/**
 * @fileoverview Marp Coreを使ってスライドHTML、テーマCSS、Markdownソース範囲を生成する。
 */
import Marp from "@marp-team/marp-core";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import {
  findHtmlTagRanges,
  getMarkdownImageReferences,
  removeHtmlAttribute,
  readHtmlAttribute,
  upsertHtmlAttribute,
} from "../../shared/imageResize";
import type {
  MarkdownImageReference,
  MarkdownInlineBlockRange,
} from "../../shared/imageResize";

const marpHighlightLanguages = {
  bash,
  css,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

for (const [name, language] of Object.entries(marpHighlightLanguages)) {
  hljs.registerLanguage(name, language);
}

/**
 * Marpの各スライドとMarkdown本文の対応範囲。
 */
export interface MarpSlideSourceRange {
  /** 1始まりのスライド番号。 */
  index: number;
  /** 対応するMarkdown開始行。 */
  startLine: number;
  /** 対応するMarkdown終了行。 */
  endLine: number;
  /** 対応するMarkdown開始オフセット。 */
  startOffset: number;
  /** 対応するMarkdown終了オフセット。 */
  endOffset: number;
  /** スライド内の最初の見出しテキスト。 */
  heading?: string;
}

/**
 * Marp Coreの描画結果。
 */
export interface MarpRenderResult {
  /** スライドごとのHTML。 */
  slides: string[];
  /** テーマとdirectiveを反映したCSS。 */
  css: string;
  /** Markdown本文と各スライドの対応範囲。 */
  sourceRanges: MarpSlideSourceRange[];
  /** Marp Core内の描画所要時間。 */
  renderDurationMs: number;
}

interface MappedToken {
  type?: string;
  map?: [number, number] | null;
  children?: MappedToken[] | null;
  content?: string;
}

interface MarpFenceToken {
  info: string;
}

/**
 * Marp Core内部のslide token mappingを読み出すためのMarp派生クラス。
 */
class SourceMappedMarp extends Marp {
  /**
   * 直前の描画でMarp Coreが保持したslide tokenを返す。
   * @returns スライドごとのMarp token一覧。
   */
  getMappedSlideTokens(): MappedToken[][] {
    return (this.lastSlideTokens ?? []) as MappedToken[][];
  }
}

/**
 * Marp Core v4でMarkdownをスライドごとに描画し、ソース対応表を生成する。
 * @param markdown - Marp形式のMarkdown本文。
 * @param katexFontPath - KaTeXフォントを同梱資産から読むための末尾スラッシュ付きURI。
 * @returns スライドHTML、テーマCSS、ソース範囲を含む描画結果。
 */
export function renderMarpMarkdown(
  markdown: string,
  katexFontPath: string,
): MarpRenderResult {
  const startedAt = performance.now();
  const marp = new SourceMappedMarp({
    // Keep Unicode emoji as text so the preview works without Marp Core's remote Twemoji CDN.
    emoji: { unicode: false, shortcode: false },
    math: { lib: "katex", katexFontPath },
    minifyCSS: true,
    script: false,
    markdown: {
      highlight: (code: string, language: string) =>
        language && hljs.getLanguage(language)
          ? hljs.highlight(code, { language, ignoreIllegals: true }).value
          : "",
    },
  });
  const defaultFenceRenderer = marp.markdown.renderer.rules.fence as ((
    this: unknown,
    tokens: MarpFenceToken[],
    index: number,
    options: unknown,
    env: unknown,
    renderer: unknown,
  ) => string) | undefined;
  if (defaultFenceRenderer) {
    marp.markdown.renderer.rules.fence = function (
      this: unknown,
      tokens: MarpFenceToken[],
      index: number,
      options: unknown,
      env: unknown,
      renderer: unknown,
    ) {
      const html = defaultFenceRenderer.call(this, tokens, index, options, env, renderer);
      const token = tokens[index];
      const scale = token.info.trim().match(/^mermaid\s+\{[^}]*\bscale\s*=\s*(\d{1,3})%[^}]*\}$/i)?.[1];
      const scalePercent = scale ? Number(scale) : NaN;
      if (!Number.isInteger(scalePercent) || scalePercent < 10 || scalePercent > 200) return html;
      return html.replace(/^<pre\b/i, `<pre data-mve-mermaid-scale="${scalePercent}"`);
    };
  }
  const rendered = marp.render(markdown, { htmlAsArray: true });
  const normalizeMarkdownImageReference = (source: string) =>
    normalizeMarpImageReference(
      marp.markdown.normalizeLink(marp.markdown.utils.unescapeAll(source)),
    );
  const sourceRanges = mapSlideRanges(
    markdown,
    marp.getMappedSlideTokens(),
  );
  const inlineBlockRanges: MarkdownInlineBlockRange[] = marp.markdown
    .parse(markdown, {})
    .flatMap((token: MappedToken) => token.type === "inline" && token.map
      ? [{ startLine: token.map[0], endLine: token.map[1] }]
      : []);
  const imageReferences = getMarkdownImageReferences(markdown, inlineBlockRanges);
  return {
    slides: rendered.html.map((html, index) =>
      decorateMarpSlideImages(
        html,
        sourceRanges[index],
        imageReferences,
        normalizeMarkdownImageReference,
      ),
    ),
    css: removeExternalCssImports(rendered.css),
    sourceRanges,
    renderDurationMs: performance.now() - startedAt,
  };
}

/**
 * Marpが生成した各スライド画像へ、元Markdownの画像インデックスを設定する。
 * @param html - Marp Coreが描画した1枚分のHTML。
 * @param range - 対象スライドに対応するMarkdown範囲。
 * @param imageReferences - Markdown本文内の画像参照一覧。
 * @returns ソース上の画像参照と一致したimg要素へインデックスを設定したHTML。
 */
function decorateMarpSlideImages(
  html: string,
  range: MarpSlideSourceRange | undefined,
  imageReferences: MarkdownImageReference[],
  normalizeMarkdownImageReference: (source: string) => string,
): string {
  if (!range) return html;
  const candidates = imageReferences.filter(
    (reference) =>
      reference.start >= range.startOffset &&
      reference.start < range.endOffset &&
      !reference.insideNonRenderedMarkup &&
      !(reference.kind === "markdown" && reference.alt.split(/\s+/).includes("bg")),
  );
  const renderedImageTagStarts = new Set(
    findHtmlTagRanges(maskNonRenderedMarpMarkup(html))
      .filter((tagRange) => /^<img\b/i.test(html.slice(tagRange.start, tagRange.end)))
      .map((tagRange) => tagRange.start),
  );
  const replacements = findHtmlTagRanges(html)
    .filter((tagRange) => /^<img\b/i.test(html.slice(tagRange.start, tagRange.end)))
    .map((tagRange) => {
      const tag = html.slice(tagRange.start, tagRange.end);
      if (!renderedImageTagStarts.has(tagRange.start)) {
        return { ...tagRange, replacement: tag };
      }
      const sourceMetadataAttributes = [
        "data-mve-image-index",
        "data-mve-image-start",
        "data-mve-image-end",
        "data-mve-image-kind",
        "data-mve-image-alt-start",
        "data-mve-image-alt-end",
        "data-mve-image-shortcut-reference",
      ];
      const withoutMetadata = sourceMetadataAttributes.reduce(
        (currentTag, attribute) => removeHtmlAttribute(currentTag, attribute),
        tag,
      );
      const source = readHtmlAttribute(tag, "src");
      const normalizedSource = source === undefined
        ? undefined
        : normalizeMarpImageReference(source);
      const candidateIndex = normalizedSource === undefined
        ? -1
        : candidates.findIndex(
          (candidate) => {
            const candidateSource = candidate.kind === "markdown"
              ? normalizeMarkdownImageReference(candidate.source)
              : normalizeMarpImageReference(candidate.source);
            return candidateSource === normalizedSource;
          },
        );
      if (candidateIndex < 0) return { ...tagRange, replacement: withoutMetadata };
      const [reference] = candidates.splice(candidateIndex, 1);
      if (!reference) return { ...tagRange, replacement: withoutMetadata };
      let replacement = upsertHtmlAttribute(
        withoutMetadata,
        "data-mve-image-index",
        String(reference.index),
      );
      replacement = upsertHtmlAttribute(replacement, "data-mve-image-start", String(reference.start));
      replacement = upsertHtmlAttribute(replacement, "data-mve-image-end", String(reference.end));
      replacement = upsertHtmlAttribute(replacement, "data-mve-image-kind", reference.kind);
      if (reference.altStart !== undefined && reference.altEnd !== undefined) {
        replacement = upsertHtmlAttribute(replacement, "data-mve-image-alt-start", String(reference.altStart));
        replacement = upsertHtmlAttribute(replacement, "data-mve-image-alt-end", String(reference.altEnd));
      }
      if (reference.shortcutReference) {
        replacement = upsertHtmlAttribute(replacement, "data-mve-image-shortcut-reference", "true");
      }
      return {
        ...tagRange,
        replacement,
      };
    });
  let updatedHtml = html;
  for (const replacement of replacements.reverse()) {
    updatedHtml = updatedHtml.slice(0, replacement.start) +
      replacement.replacement + updatedHtml.slice(replacement.end);
  }
  return updatedHtml;
}

/**
 * コメントや実行・非表示用HTML要素の中にあるimg文字列を照合対象から除外する。
 * @param html - Marp Coreが生成したHTML。
 * @returns 非描画領域を空白へ置き換え、元HTMLと同じ文字位置を保った文字列。
 */
function maskNonRenderedMarpMarkup(html: string): string {
  const characters = html.split("");
  const htmlTagRanges = findHtmlTagRanges(html);
  const nonRenderedRanges: Array<{ start: number; end: number }> = [];
  const nonRenderedPattern = /<(script|style|textarea|title|iframe|object|form|template|noscript)\b[^>]*>(?:[\s\S]*?<\/\1\s*>|[\s\S]*$)/gi;
  for (const match of html.matchAll(nonRenderedPattern)) {
    const start = match.index ?? 0;
    nonRenderedRanges.push({ start, end: start + match[0].length });
  }
  for (const range of nonRenderedRanges) {
    for (let index = range.start; index < range.end; index += 1) {
      characters[index] = " ";
    }
  }

  let commentStart = html.indexOf("<!--");
  while (commentStart >= 0) {
    const insideTag = htmlTagRanges.some(
      (range) => commentStart >= range.start && commentStart < range.end,
    );
    const insideNonRenderedElement = nonRenderedRanges.some(
      (range) => commentStart >= range.start && commentStart < range.end,
    );
    if (insideTag || insideNonRenderedElement) {
      commentStart = html.indexOf("<!--", commentStart + 4);
      continue;
    }
    const closingComment = html.indexOf("-->", commentStart + 4);
    const end = closingComment < 0 ? html.length : closingComment + 3;
    for (let index = commentStart; index < end; index += 1) {
      characters[index] = " ";
    }
    if (closingComment < 0) break;
    commentStart = html.indexOf("<!--", end);
  }
  return characters.join("");
}

/**
 * HTML属性に含まれる一般的な文字参照を復元する。
 * @param value - HTML属性値。
 * @returns 文字参照を復元した属性値。
 */
function decodeMarpHtmlEntities(value: string): string {
  return value.replace(
    /&(?:amp|quot|apos|lt|gt|#39|#\d+|#x[0-9a-f]+);/gi,
    (entity) => {
      const name = entity.toLowerCase();
      const namedEntities: Record<string, string> = {
        "&amp;": "&",
        "&quot;": "\"",
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
        "&#39;": "'",
      };
      const namedValue = namedEntities[name];
      if (namedValue !== undefined) return namedValue;
      const numeric = name.startsWith("&#x")
        ? Number.parseInt(name.slice(3, -1), 16)
        : Number.parseInt(name.slice(2, -1), 10);
      return Number.isInteger(numeric) && numeric > 0 && numeric <= 0x10ffff
        ? String.fromCodePoint(numeric)
        : entity;
    },
  );
}

/**
 * Markdown側とHTML側の画像参照値を照合できる形へ正規化する。
 * @param value - HTMLまたはMarkdownから取得した画像参照値。
 * @returns HTML文字参照を復元した画像参照値。
 */
function normalizeMarpImageReference(value: string): string {
  return decodeMarpHtmlEntities(value);
}

/**
 * MarpテーマCSSから外部HTTP(S)の@importを除去し、ネットワーク不要にする。
 * @param css - Marp Coreが生成したテーマCSS。
 * @returns 外部CSS importを除いたテーマCSS。
 */
function removeExternalCssImports(css: string): string {
  return css.replace(
    /@import\s+(?:url\(\s*)?["']?https?:\/\/[^"')\s]+["']?\s*\)?\s*;?/gi,
    "",
  );
}

/**
 * Marp Coreのtoken行範囲をMarkdown本文の行・文字オフセットへ変換する。
 * @param markdown - 元のMarkdown本文。
 * @param slideTokens - Marp Coreのスライドごとのtoken一覧。
 * @returns スライド番号とMarkdown本文の開始・終了位置の対応表。
 */
function mapSlideRanges(
  markdown: string,
  slideTokens: MappedToken[][],
): MarpSlideSourceRange[] {
  const lineOffsets = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    const code = markdown.charCodeAt(index);
    if (code === 13) {
      if (markdown.charCodeAt(index + 1) === 10) index += 1;
      lineOffsets.push(index + 1);
    } else if (code === 10) {
      lineOffsets.push(index + 1);
    }
  }
  return slideTokens.map((tokens, index) => {
    const maps = tokens
      .filter((token) => token.type !== "front_matter")
      .flatMap((token) => (token.map ? [token.map] : []));
    const startLineIndex = maps.length
      ? Math.min(...maps.map(([start]) => start))
      : 0;
    const endLineIndex = maps.length
      ? Math.max(...maps.map(([, end]) => end))
      : Math.min(startLineIndex + 1, lineOffsets.length);
    const startOffset = lineOffsets[Math.min(startLineIndex, lineOffsets.length - 1)] ?? 0;
    const endOffset = lineOffsets[Math.min(endLineIndex, lineOffsets.length)] ?? markdown.length;
    const heading = findSlideHeading(markdown, startLineIndex, endLineIndex);
    return {
      index: index + 1,
      startLine: startLineIndex + 1,
      endLine: Math.max(startLineIndex + 1, endLineIndex),
      startOffset,
      endOffset: Math.max(startOffset, endOffset),
      ...(heading ? { heading } : {}),
    };
  });
}

/**
 * 指定範囲内にある最初のATX見出しを取得する。
 * @param markdown - 元のMarkdown本文。
 * @param startLine - 0始まりの開始行。
 * @param endLine - 0始まりの終端行。
 * @returns 見出し記法を除いた先頭の見出し、または未検出時のundefined。
 */
function findSlideHeading(
  markdown: string,
  startLine: number,
  endLine: number,
): string | undefined {
  const lines = markdown.split(/\r\n|\r|\n/);
  for (let index = startLine; index < Math.min(endLine, lines.length); index += 1) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[index] ?? "");
    if (match) return match[1];
  }
  return undefined;
}
