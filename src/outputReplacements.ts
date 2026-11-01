/**
 * @fileoverview 出力本文と属性、PDFヘッダー・フッターの正規表現置換を実行する。
 * 拡張プレビューの実装とは独立したCLI専有のブラウザースクリプトである。
 */
import { isTextReplacementPatternValid, type TextReplacementRule } from './shared/protocol';
import { prepareExportHtml } from './shared/exportHtml';

/**
 * 同一ルールを本文、説明属性、PDFヘッダー・フッターへ順に適用する。
 * @param html - 描画済みの出力本文。
 * @param rules - 保存済み順序の置換ルール。
 * @param header - PDFヘッダー。HTMLでは空文字列。
 * @param footer - PDFフッター。HTMLでは空文字列。
 * @returns 置換済みHTMLとヘッダー・フッター。
 */
export async function replaceOutputHtml(
  html: string, rules: readonly TextReplacementRule[], header = '', footer = ''
): Promise<{ html: string; header: string; footer: string }> {
  if (!rules.some((rule) => rule.pattern.length > 0)) return { html, header, footer };
  const root = document.createElement('div');
  root.innerHTML = prepareExportHtml(html);
  const values = [header, footer];
  await applyTextReplacements(root, rules, values, () => true);
  return { html: prepareExportHtml(root.innerHTML), header: values[0], footer: values[1] };
}

/** 正規表現の処理が上限時間内に終わらなかった場合に使うエラー。 */
class TextReplacementTimeoutError extends Error {
  constructor() {
    super("Text replacement timed out.");
    this.name = "TextReplacementTimeoutError";
  }
}

/** Web Workerで正規表現置換を完了できなかった場合に使うエラー。 */
class TextReplacementWorkerError extends Error {
  constructor() {
    super("Text replacement failed.");
    this.name = "TextReplacementWorkerError";
  }
}

/** 古い出力要求が置換を中断した場合に使うエラー。 */
class TextReplacementCancelledError extends Error {
  constructor() {
    super("Text replacement was cancelled.");
    this.name = "TextReplacementCancelledError";
  }
}

/** 任意の正規表現による処理を、出力の描画ページから分離するWorker本体。 */
const TEXT_REPLACEMENT_WORKER_SOURCE = `
self.onmessage = (event) => {
  try {
    const { values, pattern, replacement, preservePageTokensFromIndex } = event.data;
    const results = values.map((value, index) => {
      const matchOffsets = [];
      let replacedValue;
      if (index >= preservePageTokensFromIndex) {
        replacedValue = value
          .split(/(\{page\}|\{pages\})/g)
          .map((part) =>
            part === "{page}" || part === "{pages}"
              ? part
              : part.replace(new RegExp(pattern, "g"), () => replacement),
          )
          .join("");
      } else {
        const expression = new RegExp(pattern, "g");
        for (const match of value.matchAll(expression)) {
          matchOffsets.push(match.index, match.index + match[0].length);
        }
        replacedValue = value.replace(
          new RegExp(pattern, "g"),
          () => replacement,
        );
      }
      return { matches: new Uint32Array(matchOffsets), value: replacedValue };
    });
    self.postMessage(
      { results },
      results.map((result) => result.matches.buffer),
    );
  } catch {
    self.postMessage({ error: true });
  }
};
`;

/** Workerが返すテキスト区間ごとの置換結果。 */
interface TextReplacementResult {
  /** 各入力値内の一致範囲を、開始・終了の半開オフセットで交互に格納する。ページ番号保護領域では空配列。 */
  matches: Uint32Array;
  /** 正規表現を適用した後の値。ページ番号保護領域ではページ番号トークンを維持する。 */
  value: string;
}

/** 連結した表示テキスト内でのDOMテキストノード位置。 */
interface TextNodeSpan {
  /** 表示順のDOMテキストノード。 */
  node: Text;
  /** DOMテキストノード内で対象範囲が始まる位置。 */
  nodeStart: number;
  /** 連結テキスト上でノードが始まる位置。 */
  start: number;
  /** 連結テキスト上でノードが終わる位置。 */
  end: number;
}

/** 改行区切りで分けた、DOMテキストノード内の対象範囲。 */
interface TextNodeSlice {
  /** 対象範囲を含むDOMテキストノード。 */
  node: Text;
  /** DOMテキストノード内で対象範囲が始まる位置。 */
  startOffset: number;
  /** DOMテキストノード内で対象範囲が終わる位置。 */
  endOffset: number;
}

/** 正規表現ルール1件あたりの最大処理時間（ミリ秒）。 */
const TEXT_REPLACEMENT_TIMEOUT_MS = 2000;

/**
 * 1ルール分の正規表現処理を制限時間付きWorkerで実行する。
 * @param values 正規表現を適用する本文区間または属性値。
 * @param rule 適用する正規表現と置換文字列。
 * @param preservePageTokensFromIndex ページ番号用トークンを保護し始めるvalues内の位置。
 * @param isCurrent 要求が現在も有効かを判定する関数。falseになった場合は処理を中止する。
 * @returns 元文字列上の一致位置と置換後の文字列。キャンセル・時間超過・Worker失敗・不正応答時はPromiseを拒否する。
 */
function replaceStringsWithWorker(
  values: readonly string[],
  rule: TextReplacementRule,
  preservePageTokensFromIndex: number,
  isCurrent: () => boolean,
): Promise<TextReplacementResult[]> {
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let workerUrl: string | undefined;
    let timeoutHandle: number | undefined;
    let cancellationCheckHandle: number | undefined;
    let settled = false;
    /**
     * Worker、タイマー、Object URLを一度だけ解放し、Promiseの結果を確定する。
     * @param error 省略時はPromiseを解決し、指定時はその理由で拒否する。
     * @param results Workerが返した置換結果。
     */
    const finish = (error?: Error, results?: TextReplacementResult[]): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
      if (cancellationCheckHandle !== undefined) {
        window.clearInterval(cancellationCheckHandle);
      }
      worker?.terminate();
      if (workerUrl) URL.revokeObjectURL(workerUrl);
      if (error) reject(error);
      else resolve(results ?? []);
    };

    try {
      workerUrl = URL.createObjectURL(
        new Blob([TEXT_REPLACEMENT_WORKER_SOURCE], {
          type: "text/javascript",
        }),
      );
      worker = new Worker(workerUrl);
      cancellationCheckHandle = window.setInterval(() => {
        if (!isCurrent()) finish(new TextReplacementCancelledError());
      }, 50);
      if (!isCurrent()) {
        finish(new TextReplacementCancelledError());
        return;
      }
      timeoutHandle = window.setTimeout(
        () => finish(new TextReplacementTimeoutError()),
        TEXT_REPLACEMENT_TIMEOUT_MS,
      );
      worker.addEventListener(
        "message",

        (event: MessageEvent<unknown>) => {
          const data = event.data as
            | { results?: TextReplacementResult[]; error?: boolean }
            | undefined;
          if (
            !data ||
            !Array.isArray(data.results) ||
            data.results.length !== values.length
          ) {
            finish(new TextReplacementWorkerError());
            return;
          }
          finish(undefined, data.results);
        },
        { once: true },
      );
      worker.addEventListener(
        "error",

        (event: ErrorEvent) => {
          event.preventDefault();
          finish(new TextReplacementWorkerError());
        },
        { once: true },
      );
      worker.postMessage({
        values,
        pattern: rule.pattern,
        replacement: rule.replacement,
        preservePageTokensFromIndex,
      });
    } catch {
      finish(new TextReplacementWorkerError());
    }
  });
}

/**
 * 置換対象のテキスト連結を分断するブロック要素名。別ブロック間の一致を防ぐ。
 */
const OUTPUT_TEXT_BLOCK_ELEMENTS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "CAPTION",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

/**
 * 正規表現が隣接する別段落や別の視覚要素をまたがないように区切る要素。
 */
const OUTPUT_TEXT_BOUNDARY_ELEMENTS = new Set([
  "A",
  "BR",
  "CANVAS",
  "EMBED",
  "HR",
  "IFRAME",
  "IMG",
  "OBJECT",
  "VIDEO",
  "AUDIO",
]);

/**
 * 出力本文の文字列走査から除外する実行・スタイル要素。
 */
const OUTPUT_TEXT_IGNORED_ELEMENTS = new Set([
  "NOSCRIPT",
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
]);

/**
 * 本文、説明属性、ヘッダー・フッターをWorkerで順に置換する。
 * @param root シリアライズ前に複製した出力本文のDOMルート。
 * @param rules 上から順に適用する出力置換ルール。
 * @param externalValues PDFのヘッダー・フッターなど本文外の文字列。呼び出し元の配列を更新する。
 * @param isCurrent 出力要求が最新のままかを確認する関数。
 * @returns すべての置換が完了すると解決するPromise。無効な正規表現や要求のキャンセル時は拒否する。
 */
async function applyTextReplacements(
  root: HTMLElement,
  rules: readonly TextReplacementRule[],
  externalValues: string[],
  isCurrent: () => boolean,
): Promise<void> {
  for (const rule of rules) {
    if (!isCurrent()) throw new TextReplacementCancelledError();
    if (rule.pattern.length === 0) continue;
    if (!isTextReplacementPatternValid(rule.pattern)) {
      throw new Error("Text replacement pattern is invalid.");
    }
    const textRuns = collectOutputTextRuns(root);
    const attributes: Array<{
      element: Element;
      name: "alt" | "title" | "aria-label" | "value" | "placeholder";
      value: string;
    }> = [];
    for (const element of root.querySelectorAll(
      "[alt], [title], [aria-label], [value], [placeholder]",
    )) {
      for (const attribute of [
        "alt",
        "title",
        "aria-label",
        "value",
        "placeholder",
      ] as const) {
        const value = element.getAttribute(attribute);
        if (value !== null)
          attributes.push({ element, name: attribute, value });
      }
    }
    const values = [
      ...textRuns.map((slices) =>
        slices
          .map((slice) =>
            slice.node.data.slice(slice.startOffset, slice.endOffset),
          )
          .join(""),
      ),
      ...attributes.map((attribute) => attribute.value),
      ...externalValues,
    ];
    const externalOffset = textRuns.length + attributes.length;
    const results = await replaceStringsWithWorker(
      values,
      rule,
      externalOffset,
      isCurrent,
    );
    if (!isCurrent()) throw new TextReplacementCancelledError();
    for (let index = textRuns.length - 1; index >= 0; index--) {
      if (!isCurrent()) throw new TextReplacementCancelledError();
      await replaceTextRun(
        createTextNodeSpans(textRuns[index]),
        results[index].matches,
        rule.replacement,
        root.ownerDocument,
        isCurrent,
      );
    }
    if (!isCurrent()) throw new TextReplacementCancelledError();
    for (let index = 0; index < attributes.length; index++) {
      const attribute = attributes[index];
      attribute.element.setAttribute(
        attribute.name,
        results[textRuns.length + index].value,
      );
      if (
        attribute.name === "value" &&
        attribute.element instanceof HTMLInputElement
      ) {
        attribute.element.value = results[textRuns.length + index].value;
      }
    }
    for (let index = 0; index < externalValues.length; index++) {
      externalValues[index] = results[externalOffset + index].value;
    }
  }
}

/**
 * インライン要素をまたいで照合できるよう、同じ表示ブロックのテキストノードを集める。
 * @param root 出力本文のDOMルート。
 * @returns 段落・改行・画像・リンク境界で分けたテキスト範囲群。インライン装飾はまたいで連結する。
 */
function collectOutputTextRuns(root: HTMLElement): TextNodeSlice[][] {
  const runs: TextNodeSlice[][] = [];
  let currentRun: TextNodeSlice[] = [];
  /** 収集中の範囲を結果へ追加し、次の表示区間を空にする。 */
  const flushRun = (): void => {
    if (currentRun.length > 0) {
      runs.push(currentRun);
      currentRun = [];
    }
  };
  /** DOM順に子ノードをたどり、改行や要素境界で置換用のテキスト区間を分割する。 */
  const visit = (node: Node, isRoot = false): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text;
      let sliceStart = 0;
      for (let index = 0; index < textNode.data.length; index++) {
        const character = textNode.data[index];
        if (character !== "\r" && character !== "\n") continue;
        if (index > sliceStart) {
          currentRun.push({
            node: textNode,
            startOffset: sliceStart,
            endOffset: index,
          });
        }
        flushRun();
        if (character === "\r" && textNode.data[index + 1] === "\n") {
          index++;
        }
        sliceStart = index + 1;
      }
      if (sliceStart < textNode.data.length) {
        currentRun.push({
          node: textNode,
          startOffset: sliceStart,
          endOffset: textNode.data.length,
        });
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      for (const child of Array.from(node.childNodes)) visit(child);
      return;
    }
    const element = node as Element;
    const tagName = element.tagName.toUpperCase();
    if (
      OUTPUT_TEXT_IGNORED_ELEMENTS.has(tagName) ||
      OUTPUT_TEXT_BOUNDARY_ELEMENTS.has(tagName)
    ) {
      flushRun();
      if (tagName === "A") {
        for (const child of Array.from(element.childNodes)) visit(child);
        flushRun();
      }
      return;
    }
    const isBlock = !isRoot && OUTPUT_TEXT_BLOCK_ELEMENTS.has(tagName);
    if (isBlock) flushRun();
    for (const child of Array.from(element.childNodes)) visit(child);
    if (isBlock) flushRun();
  };
  visit(root, true);
  flushRun();
  return runs;
}

/**
 * テキスト範囲の連結位置を一度だけ計算する。
 * @param slices 表示順に並ぶテキスト範囲。
 * @returns ノードと連結テキスト上の開始・終了位置。
 */
function createTextNodeSpans(slices: TextNodeSlice[]): TextNodeSpan[] {
  let position = 0;
  return slices.map((slice) => {
    const start = position;
    position += slice.endOffset - slice.startOffset;
    return {
      node: slice.node,
      nodeStart: slice.startOffset,
      start,
      end: position,
    };
  });
}

/**
 * 一つの表示テキスト区間の一致を後ろからRangeで置換する。replacementが空なら一致部分を削除する。
 * @param spans 表示順に並ぶ、同じ本文ブロック内のノード位置。
 * @param matches Workerから受け取った一致範囲の開始・終了位置配列。
 * @param replacement 一致範囲へ挿入する文字列。
 * @param ownerDocument 対象DOMのRangeとテキストノードを生成するDocument。
 * @param isCurrent 出力要求が最新かを判定する関数。途中で無効になれば処理を中止する。
 * @returns 一致範囲を後ろから置換し、範囲外の装飾要素を保つPromise。200件ごとにUIスレッドへ制御を返す。
 */
async function replaceTextRun(
  spans: readonly TextNodeSpan[],
  matches: Uint32Array,
  replacement: string,
  ownerDocument: Document,
  isCurrent: () => boolean,
): Promise<void> {
  let applied = 0;
  for (let index = matches.length - 2; index >= 0; index -= 2) {
    if (!isCurrent()) throw new TextReplacementCancelledError();
    const matchStart = matches[index];
    const matchEnd = matches[index + 1];
    const start = locateTextPosition(spans, matchStart, "start");
    const end =
      matchStart === matchEnd
        ? start
        : locateTextPosition(spans, matchEnd, "end");
    const range = ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    range.deleteContents();
    if (replacement.length > 0) {
      range.insertNode(ownerDocument.createTextNode(replacement));
    }
    applied++;
    if (applied % 200 === 0 && index > 0) {
      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 0);
      });
      if (!isCurrent()) throw new TextReplacementCancelledError();
    }
  }
}

/**
 * 連結テキスト内の文字位置を元のDOMテキストノードとオフセットへ戻す。
 * @param spans 表示順に並ぶテキストノードと、連結テキスト上の各範囲。
 * @param position 連結テキスト上の0始まりのUTF-16オフセット。
 * @param bias 開始位置は後続ノード、終了位置は直前ノードを優先する指定。
 * @returns 対応するテキストノードとその中のオフセット。
 */
function locateTextPosition(
  spans: readonly TextNodeSpan[],
  position: number,
  bias: "start" | "end",
): { node: Text; offset: number } {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const span = spans[middle];
    const matchesPosition =
      bias === "start" ? span.end > position : span.end >= position;
    if (matchesPosition) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  const span = spans[Math.min(low, spans.length - 1)];
  const offset = span.nodeStart + Math.max(0, position - span.start);
  return { node: span.node, offset };
}
