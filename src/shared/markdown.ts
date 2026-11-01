/**
 * @fileoverview Markdownの解析、インライン構文、表、画像、リンクの共通変換を提供する。表示と保存で本文の意味をそろえる。
 */
import { Marked, marked, type Token, type Tokens } from 'marked';

/** ワークスペースリンクを既存の絶対パスリンクと区別するMarkdown title印。 */
export const WORKSPACE_SECTION_LINK_TITLE = 'MVE workspace-root link';
import { footnoteDefinitionSyntax, mathBlockSyntax, tableOfContentsSyntax } from './markdownBlockSyntax';
import { getMessages, type SupportedLanguage } from './messages';
import { stripMveTextColorMarkup } from './textColor';

/**
 * 本文内選択範囲の開始・終了UTF-16オフセットです。
 */
export interface TextSelection {

    /**
     * 選択範囲の先頭を示す本文内UTF-16オフセットです。
     */
    from: number;

    /**
     * 選択範囲の末尾を示す本文内UTF-16オフセットです。
     */
    to: number;
}

/**
 * 編集後のMarkdown本文と、その本文で選択する範囲を保持します。
 */
export interface SourceEdit {

    /**
     * 表示・解析・変換の対象となる本文。
     */
    text: string;

    /**
   * Markdown本文内の選択範囲をUTF-16オフセットで示す。
     */
    selection: TextSelection;
}

/**
 * 見出しの深さ、表示名、本文内の行位置を持つ目次項目です。
 */
export interface OutlineItem {

    /**
     * 見出しレベルを示す1から6までの整数です。
     */
    level: number;

    /**
     * 表示・解析・変換の対象となる本文。
     */
    text: string;

    /**
     * 見出しが始まる0始まりのMarkdown行番号です。
     */
    line: number;

    /**
     * 見出し先頭の文書内UTF-16オフセットです。
     */
    offset: number;

    /**
     * Markdownで扱うidの文字列。
     */
    id: string;
}

/**
 * Markdownで扱う値の種類と境界を表す型。
 */
export type OutlineMovePosition = 'before' | 'after';

/**
 * 分割したMarkdownブロックの種別と本文内の範囲を表します。
 */
export interface MarkdownBlock {

    /**
     * ブロック先頭の本文内UTF-16オフセットです。
     */
    from: number;

    /**
     * ブロック末尾の本文内UTF-16オフセットです。
     */
    to: number;

    /**
     * ブロック範囲に含まれる元のMarkdown文字列です。
     */
    raw: string;

    /**
     * ブロック種別（見出し、段落、リストなど）を示します。
     */
    type: string;
}

/**
 * Markdown本文の問題位置、重大度、説明を表す診断項目です。
 */
export interface Diagnostic {

    /**
   * 診断の重大度をerror、warning、infoのいずれかで示す。
     */
    severity: 'error' | 'warning' | 'info';

    /**
     * Markdownで扱うcodeの文字列。
     */
    code: string;

    /**
     * HostとWebviewの間で受け渡すメッセージ。
     */
    message: string;

    /**
     * 診断箇所を含む0始まりのMarkdown行番号です。
     */
    line?: number;

    /**
     * 解析・描画・変換の起点となる本文。
     */
    source?: string;
}

/**
 * error、warning、infoの重大度別に診断項目をまとめます。
 */
export interface DiagnosticSummary {

    /**
   * error重大度の診断一覧。
     */
    errors: Diagnostic[];

    /**
   * warning重大度の診断一覧。
     */
    warnings: Diagnostic[];

    /**
   * info重大度の診断一覧。
     */
    infos: Diagnostic[];
}

/**
 * Markdown内で参照されたローカルリソースの位置と参照先です。
 */
export interface LocalResourceReference {

    /**
     * メッセージ、項目、または処理の種類を識別する値。
     */
    kind: 'image' | 'link';

    /**
     * 解析・描画・変換の起点となる本文。
     */
    source: string;

    /** 専用title印を持つワークスペース基準リンクかを示す。 */
    workspaceRooted?: boolean;

    /**
     * リソース参照が見つかった0始まりのMarkdown行番号です。
     */
    line: number;
}

/**
 * リソース参照の種別、記法、参照行、ワークスペース基準指定です。
 */
interface LocalResourceDefinition {

    /**
     * メッセージ、項目、または処理の種類を識別する値。
     */
    kind: 'image' | 'link';

    /**
     * 解析・描画・変換の起点となる本文。
     */
    source: string;

    /** Titleがワークスペース基準リンクを示すかどうか。 */
    workspaceRooted?: boolean;

    /**
     * 参照を含む0始まりのMarkdown行番号です。
     */
    line: number;
}

/**
 * 走査したリソースリンクの構文、参照先、本文位置です。
 */
interface ScannedResourceLink {

    /**
     * メッセージ、項目、または処理の種類を識別する値。
     */
    kind: 'image' | 'link';

    /**
     * 解析・描画・変換の起点となる本文。
     */
    source?: string;

    /** 専用title印を持つワークスペース基準リンクかを示す。 */
    workspaceRooted?: boolean;

    /**
   * Markdown参照リンクのラベル。
     */
    referenceLabel?: string;

    /**
     * リンク記法の開始位置を示す文書内UTF-16オフセットです。
     */
    offset: number;
}


/**
 * インライン装飾記号を本文へ置き換える正規表現と置換文字列の対応表です。
 */
const INLINE_MARKERS: Array<[RegExp, string]> = [
    [/\*\*([^\n]+?)\*\*/g, '$1'],
    [/__([^\n]+?)__/g, '$1'],
    [/~~([^\n]+?)~~/g, '$1'],
    [/==([^\n]+?)==/g, '$1'],
    [/\+\+([^\n]+?)\+\+/g, '$1'],
    [/`([^`\n]+?)`/g, '$1'],
    [/\^([^\^\n]+?)\^/g, '$1'],
    [/~([^~\n]+?)~/g, '$1'],
    [/\*([^*\n]+?)\*/g, '$1'],
    [/_([^_\n]+?)_/g, '$1']
];

/**
 * Markdown選択範囲へ指定書式を適用する。
 * @param source - 選択範囲へ書式を適用するMarkdown本文。
 * @param selection - 書式を適用する本文内のfrom/to UTF-16オフセット。
 * @param prefix 選択範囲の前へ付けるMarkdown書式文字列。
 * @param suffix 選択範囲の後ろへ付けるMarkdown書式文字列。
 * @param placeholder - 入力欄に値がないときに表示する案内文。
 * @returns 書式を適用した本文と、挿入内容を選択する新しい範囲。
 */
export function wrapSelection(
    source: string,
    selection: TextSelection,
    prefix: string,
    suffix = prefix,
    placeholder = 'テキスト'
): SourceEdit {
    // 選択範囲を正規化し、選択文字列またはプレースホルダーを装飾文字で囲む。
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    const selectedSource = source.slice(from, to);
    const selected = selectedSource || placeholder;
    const hasSelection = selectedSource.length > 0;
    const before = hasSelection && !/^\s/.test(selectedSource) && from > 0 && !/\s/.test(source[from - 1]) ? ' ' : '';
    const after = hasSelection && !/\s$/.test(selectedSource) && to < source.length && !/\s/.test(source[to]) ? ' ' : '';
    const replacement = `${before}${prefix}${selected}${suffix}${after}`;
    return {
        text: source.slice(0, from) + replacement + source.slice(to),
        selection: {
            from: from + before.length + prefix.length,
            to: from + before.length + prefix.length + selected.length
        }
    };
}

/**
 * 選択範囲に含まれる各行の先頭へ指定文字列を追加する。
 * @param source - 選択行へprefixを挿入するMarkdown本文。
 * @param selection - prefixを切り替える本文内のfrom/to UTF-16範囲。
 * @param prefix 選択範囲の前へ付けるMarkdown書式文字列。
 * @returns 条件が成立したかを示す真偽値。
 */
export function prefixSelectedLines(
    source: string,
    selection: TextSelection,
    prefix: string
): SourceEdit {
    // 選択範囲に含まれる行を取得し、各行の先頭にプレフィックスを付けるか外す。
    const from = lineStart(source, Math.min(selection.from, selection.to));
    const to = lineEnd(source, Math.max(selection.from, selection.to));
    const original = source.slice(from, to);
    const lines = original.split('\n');
    const caretOnly = selection.from === selection.to;
    const allPrefixed = lines.every(
        /**
         * @param line Markdown本文から処理する1行。
         * @returns 条件が成立したかを示す真偽値。
         */
        (line) => !line.trim() || line.startsWith(prefix));
    const changed = lines
        .map(
            /**
             * 各lineからtrimを取り出して一覧化する。
             * @param line - lineのtrimを参照する走査対象。
             * @returns trimを取り出した変換結果の一覧。
             */
            (line) => {
                if (!line.trim()) return caretOnly && lines.length === 1 ? prefix + line : line;
                if (line.startsWith(prefix)) return allPrefixed ? line.slice(prefix.length) : line;
                return prefix + line;
            })
        .join('\n');
    return {
        text: source.slice(0, from) + changed + source.slice(to),
        selection: caretOnly
            ? { from: selection.from + changed.length - original.length, to: selection.from + changed.length - original.length }
            : mapLineSelection(original, changed, from, selection)
    };
}

/**
 * 選択した行の先頭に空白2文字を追加する。
 * @param source - 選択行へ2文字分のindentを挿入するMarkdown本文。
 * @param selection - indentする本文内のfrom/to UTF-16範囲。
 * @returns インデント後の本文と、変更後のカーソル範囲。
 */
export function indentSelectedLines(source: string, selection: TextSelection): SourceEdit {
    const from = lineStart(source, Math.min(selection.from, selection.to));
    const to = lineEnd(source, Math.max(selection.from, selection.to));
    const original = source.slice(from, to);
    const lines = original.split('\n');
    const caretOnly = selection.from === selection.to;
    const changed = lines
        .map(
            /**
             * 各lineからtrimを取り出して一覧化する。
             * @param line - lineのtrimを参照する走査対象。
             * @returns trimを取り出した変換結果の一覧。
             */
            (line) => {
                if (!line.trim()) return caretOnly && lines.length === 1 ? `  ${line}` : line;
                return `  ${line}`;
            })
        .join('\n');
    return {
        text: source.slice(0, from) + changed + source.slice(to),
        selection: caretOnly
            ? { from: selection.from + 2, to: selection.from + 2 }
            : mapLineSelection(original, changed, from, selection)
    };
}

/**
 * 選択行の番号付きリスト書式を切り替える。
 * @param source - 選択行へ番号付きリストのprefixを設定するMarkdown本文。
 * @param selection - 番号付きリストを切り替える本文内のfrom/to UTF-16範囲。
 * @returns 条件が成立したかを示す真偽値。
 */
export function prefixOrderedList(source: string, selection: TextSelection): SourceEdit {
    // 選択行がすべて番号付きリストなら番号を外し、それ以外なら連番を付ける。
    const from = lineStart(source, Math.min(selection.from, selection.to));
    const to = lineEnd(source, Math.max(selection.from, selection.to));
    const original = source.slice(from, to);
    const lines = original.split('\n');
    const caretOnly = selection.from === selection.to;
    const ordered = /^\s*\d+[.)]\s+/;
    const allOrdered = lines.every(
        /**
         * @param line Markdown本文から処理する1行。
         * @returns 条件が成立したかを示す真偽値。
         */
        (line) => !line.trim() || ordered.test(line));
    const changed = caretOnly && lines.length === 1 && !lines[0].trim()
        ? [`${orderedListNumberBefore(source, from)}. `]
        : allOrdered
            ? lines.map(
                /**
                 * 各lineからreplaceを取り出して一覧化する。
                 * @param line - lineのreplaceを参照する走査対象。
                 * @returns replaceを取り出した変換結果の一覧。
                 */
                (line) => line.replace(/^(\s*)\d+[.)]\s+/, '$1'))
            : orderedListLines(lines, orderedListNumberBefore(source, from));
    const text = changed.join('\n');
    return {
        text: source.slice(0, from) + text + source.slice(to),
        selection: caretOnly
            ? { from: selection.from + text.length - original.length, to: selection.from + text.length - original.length }
            : mapLineSelection(original, text, from, selection)
    };
}

/**
 * 行単位のテキスト変更後に選択位置を対応付ける。
 * @param original - 変更前の選択行ブロック。
 * @param changed - 変更後の選択行ブロック。
 * @param regionFrom - 変更ブロックの文書内開始UTF-16オフセット。
 * @param selection - 文書内で位置を移し替える変更前選択範囲。
 * @returns 変更後の本文へ移した選択範囲。
 */
export function mapLineSelection(
    original: string,
    changed: string,
    regionFrom: number,
    selection: TextSelection
): TextSelection {
    const oldLines = original.split('\n');
    const newLines = changed.split('\n');


    const mapOffset = /**
     * @param absolute - 変更ブロック内位置へ変換する文書内の絶対UTF-16オフセット。

     */ (absolute: number): number => {
            const relative = Math.max(0, Math.min(original.length, absolute - regionFrom));
            let oldCursor = 0;
            let newCursor = 0;
            for (let index = 0; index < oldLines.length; index += 1) {
                const oldLine = oldLines[index] ?? '';
                const newLine = newLines[index] ?? '';
                const oldLineEnd = oldCursor + oldLine.length;
                if (relative <= oldLineEnd || index === oldLines.length - 1) {
                    const lineOffset = Math.max(0, Math.min(oldLine.length, relative - oldCursor));
                    return regionFrom + newCursor + mapLineOffset(oldLine, newLine, lineOffset);
                }
                oldCursor = oldLineEnd + 1;
                newCursor += newLine.length + 1;
            }
            return regionFrom + changed.length;
        };
    return {
        from: mapOffset(selection.from),
        to: mapOffset(selection.to)
    };
}

/**
 * 変更前後の1行に共通する文字範囲を使ってUTF-16オフセットを移す。
 * @param original - 選択位置を写像する変更前の1行。
 * @param changed - 対応位置を探す変更後の1行。
 * @param offset - 変更前行内のUTF-16オフセット。
 * @returns 変更後の行内UTF-16オフセット。
 */
function mapLineOffset(original: string, changed: string, offset: number): number {
    if (original === changed) return offset;
    let suffixLength = 0;
    while (
        suffixLength < original.length
        && suffixLength < changed.length
        && original.charCodeAt(original.length - suffixLength - 1) === changed.charCodeAt(changed.length - suffixLength - 1)
    ) {
        suffixLength += 1;
    }
    const originalPrefixLength = original.length - suffixLength;
    const changedPrefixLength = changed.length - suffixLength;
    if (offset <= originalPrefixLength) return changedPrefixLength;
    return Math.max(0, Math.min(changed.length, offset + changedPrefixLength - originalPrefixLength));
}

/**
 * 番号付きリストの行へ開始番号からの連番を付ける。
 * @param lines Markdown本文を行ごとに分けた文字列一覧。
 * @param firstNumber - 番号付きリストへ割り当てる開始番号。
 * @returns 入力行と同じ件数の、番号を付け直した行一覧。
 */
function orderedListLines(lines: string[], firstNumber: number): string[] {
    // 空行とインデントを維持しながら、各行へ開始番号からの連番を付ける。
    let number = firstNumber;
    return lines.map(
        /**
         * 各lineからtrimを取り出して一覧化する。
         * @param line - lineのtrimを参照する走査対象。
         * @returns trimを取り出した変換結果の一覧。
         */
        (line) => {
            if (!line.trim()) return line;
            const indentation = line.match(/^\s*/)?.[0] ?? '';
            const content = line.slice(indentation.length).replace(/^(?:[-+*]|\d+[.)])\s+/, '');
            const result = `${indentation}${number}. ${content}`;
            number += 1;
            return result;
        });
}

/**
 * 挿入位置より前に続く番号付きリストの次の項目番号を求める。
 * @param source - 処理対象となるMarkdown本文。
 * @param from - 次の番号を決めるため走査する挿入位置の本文UTF-16オフセット。
 * @returns 次に使う番号。直前に番号付きリストがなければ1。
 */
function orderedListNumberBefore(source: string, from: number): number {
    // 対象行の直前にある番号付きリストを読み取り、次に使う番号を計算する。
    const previousLine = source.slice(0, Math.max(0, from - 1)).split(/\r?\n/).at(-1) ?? '';
    const match = previousLine.match(/^\s*(\d+)[.)]\s+/);
    const previousNumber = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(previousNumber) ? previousNumber + 1 : 1;
}

/**
 * 選択範囲内のリンク・強調・取り消し線などの記号を除去する。
 * @param source - 選択範囲のinline書式を解除する元Markdown本文。
 * @param selection - 書式を解除する本文内のfrom/to UTF-16範囲。
 * @returns 書式記号を除いた本文と、更新後の選択範囲。
 */
export function clearInlineFormatting(source: string, selection: TextSelection): SourceEdit {
    // 選択範囲のリンク先を一時退避し、本文中のインライン装飾記号だけを取り除く。
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    let selected = source.slice(from, to);
    if (!selected) return { text: source, selection: { from, to } };
    const protectedTargets: string[] = [];
    // リンク先をプレースホルダーへ置き換え、装飾除去の対象から外す。
    selected = selected.replace(/(\]\()([^)]+)(\))/g,

        (_match, open: string, target: string, close: string) => {
            const index = protectedTargets.push(target) - 1;
            return `${open}\uE000${index}\uE001${close}`;
        });
    for (const [pattern, replacement] of INLINE_MARKERS) {
        // 定義済みの装飾パターンを順番に適用して、記号を内容へ置き換える。
        selected = selected.replace(pattern, replacement);
    }
    // 退避していたリンク先を元の位置へ戻す。
    selected = selected.replace(/\uE000(\d+)\uE001/g,

        (_match, index: string) => protectedTargets[Number(index)] ?? '');
    return {
        text: source.slice(0, from) + selected + source.slice(to),
        selection: { from, to: from + selected.length }
    };
}

/**
 * 選択行の見出し、引用、リスト、コードブロックなどの記号を除去する。
 * @param source - 選択ブロックの書式を解除する元Markdown本文。
 * @param selection - 書式を解除する本文内のfrom/to UTF-16範囲。
 * @returns ブロック書式記号を除いた本文と、更新後の選択範囲。
 */
export function clearBlockFormatting(source: string, selection: TextSelection): SourceEdit {
    // 選択行を取り出し、コードフェンス・見出し・引用・リスト・インデントの記号を除去する。
    const selectionFrom = Math.min(selection.from, selection.to);
    const selectionTo = Math.max(selection.from, selection.to);
    if (selectionFrom === selectionTo) return { text: source, selection: { from: selectionFrom, to: selectionTo } };
    const from = lineStart(source, selectionFrom);
    const to = lineEnd(source, selectionTo);
    let lines = source.slice(from, to).split('\n');
    // 選択範囲全体がコードフェンスで囲まれている場合は、外側のフェンスを先に外す。
    if (lines.length >= 2 && /^\s*`{3,}[^`]*$/.test(lines[0]) && /^\s*`{3,}\s*$/.test(lines.at(-1) ?? '')) {
        lines = lines.slice(1, -1);
    }
    const changed = lines
        .map(
            /**
             * 各lineからreplaceを取り出して一覧化する。
             * @param line - lineのreplaceを参照する走査対象。
             * @returns replaceを取り出した変換結果の一覧。
             */
            (line) =>
                line
                    .replace(/^\s{0,3}#{1,6}\s+/, '')
                    .replace(/^\s*>\s?/, '')
                    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
                    .replace(/^\s{4}/, '')
        )
        .join('\n');
    return {
        text: source.slice(0, from) + changed + source.slice(to),
        selection: { from, to: from + changed.length }
    };
}

/**
 * 指定行列数のMarkdown表を見出し行、区切り行、空行で生成する。
 * @param rows - 表の本文行数。許容範囲外の値は2から50へ制限する。
 * @param columns - 表の列数。許容範囲外の値は1から20へ制限する。
 * @returns 見出し行、区切り行、空の本文行を含むMarkdown表。
 */
export function createTableMarkdown(rows = 3, columns = 3): string {
    // 行数と列数を許容範囲へ収め、見出し・区切り・空の本文行から表を生成する。
    const safeRows = Math.max(2, Math.min(rows, 50));
    const safeColumns = Math.max(1, Math.min(columns, 20));
    const header = `| ${Array.from({ length: safeColumns },

        (_, i) => `列${i + 1}`).join(' | ')} |`;
    const divider = `| ${Array.from({ length: safeColumns },
        /**
         * Markdown表の列数分、区切り行のセルを作成する。
         */
        () => '---').join(' | ')} |`;
    const body = Array.from(
        { length: safeRows - 1 },


        () => `| ${Array.from({ length: safeColumns },
            /**
             * Markdown表の列数分、空の本文セルを作成する。
             */
            () => '').join(' | ')} |`
    );
    return [header, divider, ...body].join('\n');
}

/**
 * Markdownで扱う値の種類と境界を表す型。
 */
export type MarkdownTableAction =
    | 'rowBefore'
    | 'rowAfter'
    | 'deleteRow'
    | 'colBefore'
    | 'colAfter'
    | 'deleteColumn'
    | 'header'
    | 'alignLeft'
    | 'alignCenter'
    | 'alignRight'
    | 'alignColumns';

/**
 * Markdownへ渡す設定項目と既定値のデータ形状。
 */
export interface MarkdownTableActionOptions {

    /**
   * HTML出力で再利用する文書の見出し名。
     */
    headerName?: string;
}

/**
 * Markdown表のヘッダー、行、セル配置を解析した結果です。
 */
interface ParsedMarkdownTable {

    /**
     * 解析対象となるMarkdown表の各行です。
     */
    lines: string[];

    /**
     * Markdown本文の各行先頭を示すUTF-16オフセット配列。
     */
    lineStarts: number[];

    /**
     * 入力Markdown表で使われている改行文字列です。
     */
    eol: string;

    /**
     * 表の先頭行を示す0始まりのMarkdown行番号です。
     */
    startLine: number;

    /**
     * 表の最終行を示す0始まりのMarkdown行番号です。
     */
    endLine: number;

    /**
     * 区切り行を示す0始まりのMarkdown行番号です。
     */
    separatorLine: number;

    /**
     * Markdownで扱うrowsの一覧。
     */
    rows: string[][];

    /**
     * Markdownで扱うseparatorの文字列。
     */
    separator: string[];

    /**
     * Markdownで扱うindentの文字列。
     */
    indent: string;

    /**
     * 表データ内の0始まりの行番号です。
     */
    rowIndex: number;

    /**
     * 表データ内の0始まりの列番号です。
     */
    columnIndex: number;
}

/**
 * 指定した表編集操作を適用する差分を計算する。
 * @param markdown - 表編集操作を適用する元Markdown本文。
 * @param selection - 操作対象表を特定する本文内のUTF-16選択範囲。
 * @param action - 実行する表編集操作の識別子。
 * @param options - 呼び出し側が指定する処理設定。
 * @returns 表本文の編集範囲と置換後テキスト。選択範囲が対象表に含まれない場合はundefined。
 */
export function applyMarkdownTableAction(
    markdown: string,
    selection: TextSelection,
    action: MarkdownTableAction,
    options: MarkdownTableActionOptions = {}
): SourceEdit | undefined {
    // 選択位置を含むGFM表を解析し、操作対象の行・列を複製して編集する。
    const table = parseMarkdownTable(markdown, selection);
    if (!table) return undefined;

    const rows = table.rows.map(
        /**
         * 各行からsliceを取り出して一覧化する。
         * @param row - 行のsliceを参照する走査対象。
         * @returns sliceを取り出した変換結果の一覧。
         */
        (row) => row.slice());
    const separator = table.separator.slice();
    let rowIndex = table.rowIndex;
    const columnIndex = table.columnIndex;

    // 指定された操作に応じて行・列・見出し・配置を変更する。
    switch (action) {
        case 'rowBefore':
            rows.splice(rowIndex, 0, Array.from({ length: separator.length },
                /**
                 * 挿入する表行のセルを空文字で初期化する。
                 */
                () => ''));
            break;
        case 'rowAfter':
            rows.splice(rowIndex + 1, 0, Array.from({ length: separator.length },
                /**
                 * 挿入する表行のセルを空文字で初期化する。
                 */
                () => ''));
            rowIndex += 1;
            break;
        case 'deleteRow':
            if (rows.length <= 1) return undefined;
            rows.splice(rowIndex, 1);
            rowIndex = Math.min(rowIndex, rows.length - 1);
            break;
        case 'colBefore':
            rows.forEach(
                /**
                 * 行ごとにspliceを実行する。
                 * @param row - 行のspliceを参照する走査対象。
                 * @param index - 走査中の配列における0始まりの要素位置。
                 */
                (row, index) => row.splice(columnIndex, 0, index === 0 ? newColumnHeader(options.headerName, columnIndex + 1) : ''));
            separator.splice(columnIndex, 0, '---');
            break;
        case 'colAfter':
            rows.forEach(
                /**
                 * 行ごとにspliceを実行する。
                 * @param row - 行のspliceを参照する走査対象。
                 * @param index - 走査中の配列における0始まりの要素位置。
                 */
                (row, index) => row.splice(columnIndex + 1, 0, index === 0 ? newColumnHeader(options.headerName, columnIndex + 2) : ''));
            separator.splice(columnIndex + 1, 0, '---');
            break;
        case 'deleteColumn':
            if (separator.length <= 1) return undefined;
            for (const row of rows) row.splice(columnIndex, 1);
            separator.splice(columnIndex, 1);
            break;
        case 'header':
            if (rowIndex === 0) return undefined;
            [rows[0], rows[rowIndex]] = [rows[rowIndex], rows[0]];
            rowIndex = 0;
            break;
        case 'alignLeft':
            separator[columnIndex] = ':---';
            break;
        case 'alignCenter':
            separator[columnIndex] = ':---:';
            break;
        case 'alignRight':
            separator[columnIndex] = '---:';
            break;
        case 'alignColumns': {
            // 各列の表示幅を求め、本文セルと区切りセルを同じ幅に揃える。
            const widths = Array.from({ length: separator.length },

                (_, index) =>
                    Math.max(
                        3,
                        displayWidth(stripMveTextColorMarkup(separator[index] ?? '')),
                        ...rows.map(
                            (row) => displayWidth(stripMveTextColorMarkup(row[index] ?? '')))
                    )
            );
            for (const row of rows) {
                for (let index = 0; index < widths.length; index += 1) {
                    row[index] = padDisplayWidth(row[index] ?? '', widths[index]);
                }
            }
            for (let index = 0; index < widths.length; index += 1) {
                separator[index] = padDisplayWidth(separator[index] ?? '---', widths[index]);
            }
            break;
        }
    }

    return renderMarkdownTableEdit(markdown, table, rows, separator, rowIndex, columnIndex);
}

/**
 * 選択位置を含むMarkdown表の行・区切り・セル範囲を解析する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @param selection - 解析対象表を特定するMarkdown本文内のUTF-16選択範囲。
 * @returns 行、区切り、セル範囲を含む表解析結果。選択位置に有効な表がない場合はundefined。
 */
function parseMarkdownTable(markdown: string, selection: TextSelection): ParsedMarkdownTable | undefined {
    // 改行位置を記録しながら、選択行を含む連続した表の範囲を特定する。
    const lineBreaks = [...markdown.matchAll(/\r\n|\r|\n/g)].map(
        /**
         * 各matchを変換して一覧化する。
         * @param match - Markdownへ渡す入力。

         */
        (match) => match[0]);
    const eol = lineBreaks[0] ?? '\n';
    const lines = markdown.split(/\r\n|\r|\n/);
    const lineStarts: number[] = [];
    let offset = 0;
    for (let index = 0; index < lines.length; index += 1) {
        lineStarts.push(offset);
        offset += lines[index].length + (lineBreaks[index]?.length ?? 0);
    }

    const currentLine = findLineIndex(lineStarts, selection.from);
    if (!isTableRowLine(lines[currentLine])) return undefined;
    if (isInsideMarkdownFence(lines, currentLine)) return undefined;
    let startLine = currentLine;
    let endLine = currentLine;
    while (startLine > 0 && isTableRowLine(lines[startLine - 1])) startLine -= 1;
    while (endLine + 1 < lines.length && isTableRowLine(lines[endLine + 1])) endLine += 1;

    const separatorLine = lines.findIndex(
        /**
         * @param line Markdown本文から処理する1行。
         * @param index - 走査中の配列における0始まりの要素位置。
         */
        (line, index) => index >= startLine && index <= endLine && isTableSeparatorLine(line));
    if (separatorLine < 0) return undefined;
    if (separatorLine !== startLine + 1 || !isTableRowLine(lines[startLine])) return undefined;

    // 区切り行を除いた本文行をセルへ分割し、すべての行を同じ列数へ補正する。
    const rowLines = lines
        .slice(startLine, endLine + 1)
        .map(
            /**
             * 各lineを変換して一覧化する。
             * @param line Markdown本文から処理する1行。
             * @param index - 走査中の配列における0始まりの要素位置。

             */
            (line, index) => ({ line, index: startLine + index }))
        .filter(
            /**
             * 条件を満たす設定だけを残す。
             * @param index - 元文書内で区切り行か判定する0始まり行インデックス。

             */
            ({ index }) => index !== separatorLine);
    if (!rowLines.length) return undefined;

    const rows = rowLines.map(
        ({ line }) => splitTableCells(line));
    const separator = splitTableCells(lines[separatorLine]);
    const columnCount = Math.max(1, separator.length, ...rows.map(
        /**
         * 各行からlengthを取り出して一覧化する。
         * @param row - 行のlengthを参照する走査対象。
         * @returns lengthを取り出した変換結果の一覧。
         */
        (row) => row.length));
    for (const row of rows) while (row.length < columnCount) row.push('');
    while (separator.length < columnCount) separator.push('---');

    const rowLineIndex = rowLines.findIndex(
        /**

         * @param index - 元文書内で現在の選択行と照合する0始まり行インデックス。
         */
        ({ index }) => index === currentLine);
    const rowIndex = rowLineIndex < 0 ? 0 : rowLineIndex;
    const lineOffset = selection.from - lineStarts[currentLine];
    const columnIndex = tableColumnAt(lines[currentLine], lineOffset, columnCount);
    const indent = /^\s*/.exec(lines[rowLines[0].index])?.[0] ?? '';

    return {
        lines,
        lineStarts,
        eol,
        startLine,
        endLine,
        separatorLine,
        rows,
        separator,
        indent,
        rowIndex,
        columnIndex
    };
}

/**
 * 編集済みのMarkdown表を本文へ反映し、選択セルの位置も返す。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @param table - 元Markdown表の行位置、区切り、インデント、選択セル情報。
 * @param rows - 編集後に出力する表セルの行列。
 * @param separator - Markdownへ出力する表の配置区切りセル。
 * @param rowIndex - 編集後に選択状態とする本文行の0始まりインデックス。
 * @param columnIndex - 編集後に選択状態とする表列の0始まりインデックス。
 * @returns 置換後のMarkdown本文と、編集後の選択位置。
 */
function renderMarkdownTableEdit(
    markdown: string,
    table: ParsedMarkdownTable,
    rows: string[][],
    separator: string[],
    rowIndex: number,
    columnIndex: number
): SourceEdit {
    // 編集済みの行と区切り行をMarkdownへ再出力し、選択セルの先頭へカーソルを移す。
    const renderedRows = rows.map(
        (row) => renderTableRow(table.indent, row));
    const renderedSeparator = renderTableRow(table.indent, separator);
    const renderedTable = [renderedRows[0], renderedSeparator, ...renderedRows.slice(1)];
    const startOffset = table.lineStarts[table.startLine];
    const endOffset = table.lineStarts[table.endLine] + table.lines[table.endLine].length;
    const replacement = renderedTable.join(table.eol);
    const text = markdown.slice(0, startOffset) + replacement + markdown.slice(endOffset);
    const renderedRowIndex = rowIndex === 0 ? 0 : rowIndex + 1;
    const rowPrefix = renderedTable.slice(0, renderedRowIndex).join(table.eol);
    const rowStart = startOffset + rowPrefix.length + (renderedRowIndex ? table.eol.length : 0);
    const safeColumn = Math.min(columnIndex, rows[rowIndex].length - 1);
    const cellOffset = table.indent.length + 2
        + rows[rowIndex].slice(0, safeColumn).reduce(
            /**
             * 要素を順に加算して累積値を求める。
             * @param total - 累積値へ加算する要素。
             * @param cell - 累積値へ加算する要素。
             * @returns 要素を集約した累積値。
             */
            (total, cell) => total + cell.length + 3, 0);
    const caret = rowStart + cellOffset;
    return { text, selection: { from: caret, to: caret } };
}

/**
 * TSVの行列を選択したMarkdown表へ反映する差分を計算する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @param selection - 表編集を適用するMarkdown本文内のUTF-16選択範囲。
 * @param tsv - 表セルへ分割するタブ区切りテキスト。
 * @returns TSVを表本文へ反映する編集範囲と置換後テキスト。対象表がない場合はundefined。
 */
export function applyMarkdownTableTsv(
    markdown: string,
    selection: TextSelection,
    tsv: string
): SourceEdit | undefined {
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    if (isMarkdownCodeFencePosition(markdown, selection)) return undefined;
    const table = parseMarkdownTable(markdown, { from, to: from });
    const pastedRows = parseTsv(tsv);
    if (!pastedRows.length || !pastedRows.some(
        /**

         * @param row - Markdownで走査または更新する要素。
         */
        (row) => row.length)) return undefined;

    if (!table) return insertMarkdownTableFromTsv(markdown, selection, pastedRows);
    const tableEnd = table.lineStarts[table.endLine] + table.lines[table.endLine].length;
    if (to > tableEnd) return insertMarkdownTableFromTsv(markdown, selection, pastedRows);
    if (table.separatorLine === findLineIndex(table.lineStarts, from)) return undefined;

    const rows = table.rows.map(
        /**
         * 各行からsliceを取り出して一覧化する。
         * @param row - 行のsliceを参照する走査対象。
         * @returns sliceを取り出した変換結果の一覧。
         */
        (row) => row.slice());
    const separator = table.separator.slice();
    const requiredRows = table.rowIndex + pastedRows.length;
    const requiredColumns = table.columnIndex + Math.max(...pastedRows.map(
        /**
         * 各行からlengthを取り出して一覧化する。
         * @param row - 行のlengthを参照する走査対象。
         * @returns lengthを取り出した変換結果の一覧。
         */
        (row) => row.length));
    while (rows.length < requiredRows) rows.push(Array.from({ length: separator.length },
        /**
         * 不足している表行の各セルを空文字で初期化する。
         */
        () => ''));
    while (separator.length < requiredColumns) separator.push('---');
    for (const row of rows) while (row.length < separator.length) row.push('');

    for (let rowOffset = 0; rowOffset < pastedRows.length; rowOffset += 1) {
        const row = pastedRows[rowOffset];
        for (let columnOffset = 0; columnOffset < row.length; columnOffset += 1) {
            rows[table.rowIndex + rowOffset][table.columnIndex + columnOffset] = escapeMarkdownTableCell(row[columnOffset]);
        }
    }
    return renderMarkdownTableEdit(markdown, table, rows, separator, table.rowIndex, table.columnIndex);
}

/**
 * Markdownの条件を判定する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @param selection - コードフェンス内にあるか調べる本文内のUTF-16 caret範囲。
 * @returns 条件が成立したかを示す真偽値。
 */
export function isMarkdownCodeFencePosition(markdown: string, selection: TextSelection): boolean {
    const lines = markdown.split(/\r\n|\r|\n/);
    const lineStarts: number[] = [];
    let offset = 0;
    for (let index = 0; index < lines.length; index += 1) {
        lineStarts.push(offset);
        offset += lines[index].length + (markdown.slice(offset + lines[index].length).match(/^\r\n|^\r|^\n/)?.[0].length ?? 0);
    }
    const line = findLineIndex(lineStarts, Math.min(selection.from, selection.to));
    return isInsideMarkdownFence(lines, line);
}

/**
 * TSVの各行をMarkdown表として、選択範囲の先頭へ挿入する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @param selection - TSV表を挿入または貼り付ける本文内のUTF-16範囲。
 * @param rows - TSVから解析した表セル文字列の行列。
 * @returns 表を挿入した本文と、挿入した表の選択範囲。
 */
function insertMarkdownTableFromTsv(markdown: string, selection: TextSelection, rows: string[][]): SourceEdit {
    const eol = markdown.match(/\r\n|\r|\n/)?.[0] ?? '\n';
    const from = Math.max(0, Math.min(selection.from, selection.to));
    const to = Math.min(markdown.length, Math.max(selection.from, selection.to));
    const columnCount = Math.max(1, ...rows.map(
        /**
         * 各行からlengthを取り出して一覧化する。
         * @param row - 行のlengthを参照する走査対象。
         * @returns lengthを取り出した変換結果の一覧。
         */
        (row) => row.length));
    const normalizedRows = rows.map(
        /**
         * 各行をfromへ渡し、変換結果を一覧化する。
         * @param row - 走査中の要素。

         */
        (row) => Array.from({ length: columnCount },

            (_, index) => escapeMarkdownTableCell(row[index] ?? '')));
    const separator = Array.from({ length: columnCount },
        /**
         * Markdown表の列数分、区切り行のセルを作成する。
         */
        () => '---');
    const rendered = [
        renderTableRow('', normalizedRows[0]),
        renderTableRow('', separator),
        ...normalizedRows.slice(1).map(
            (row) => renderTableRow('', row))
    ].join(eol);
    const before = markdown.slice(0, from);
    const after = markdown.slice(to);
    const prefix = before.length && !before.endsWith('\n') ? eol : '';
    const suffix = after.length && !/^(?:\r\n|\r|\n)/.test(after) ? eol : '';
    const replacement = prefix + rendered + suffix;
    const text = before + replacement + after;
    const caret = from + replacement.length;
    return { text, selection: { from: caret, to: caret } };
}

/**
 * 選択したMarkdown表のヘッダーとデータ行をタブ区切り形式へ変換する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @param selection - Markdown本文からTSVへ書き出す表を示す選択範囲。
 * @returns 表の内容を表すTSV文字列。選択位置に有効な表がない場合はundefined。
 */
export function markdownTableToTsv(markdown: string, selection: TextSelection): string | undefined {
    const table = parseMarkdownTable(markdown, selection);
    if (!table || table.separatorLine === findLineIndex(table.lineStarts, selection.from)) return undefined;
    return table.rows
        .map(
            /**
             * 各行からmapを取り出して一覧化する。
             * @param row - 行のmapを参照する走査対象。
             * @returns mapを取り出した変換結果の一覧。
             */
            (row) => row.map(
                (cell) => encodeTsvCell(stripMarkdownTableCell(cell))).join('\t'))
        .join('\r\n');
}

/**
 * TSVの引用符とエスケープを解釈し、行・セルの二次元配列へ分割する。
 * @param tsv - クリップボードから読み込んだタブ・改行区切りの貼り付けテキスト。
 * @returns 引用符とタブ・改行を解釈した行列。
 */
function parseTsv(tsv: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    let hasValue = false;
    for (let index = 0; index < tsv.length; index += 1) {
        const character = tsv[index];
        if (quoted) {
            if (character === '"' && tsv[index + 1] === '"') {
                cell += '"';
                index += 1;
            } else if (character === '"') {
                quoted = false;
            } else {
                cell += character;
            }
            hasValue = true;
            continue;
        }
        if (character === '"' && cell.length === 0) {
            quoted = true;
            hasValue = true;
        } else if (character === '\t') {
            row.push(cell);
            cell = '';
            hasValue = true;
        } else if (character === '\r' || character === '\n') {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
            hasValue = false;
            if (character === '\r' && tsv[index + 1] === '\n') index += 1;
        } else {
            cell += character;
            hasValue = true;
        }
    }
    if (hasValue || cell.length > 0 || row.length > 0) row.push(cell);
    if (row.length) rows.push(row);
    return rows;
}

/**
 * Markdown表セル内の予約記号と改行をエスケープする。
 * @param value - Markdown表セルへ出力する前に記号と改行をエスケープする文字列。

 */
function escapeMarkdownTableCell(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/[|`*_~\[\]<>]/g, '\\$&')
        .replace(/\r\n|\r|\n/g, '<br>');
}

/**
 * Markdownの条件を判定する。
 * @param lines Markdown本文を行ごとに分けた文字列一覧。
 * @param lineIndex - fence内か判定する0始まりMarkdown行インデックス。
 * @returns 条件が成立したかを示す真偽値。
 */
function isInsideMarkdownFence(lines: string[], lineIndex: number): boolean {
    let fenceCharacter = '';
    let fenceLength = 0;
    for (let index = 0; index <= lineIndex; index += 1) {
        const match = /^\s*(`{3,}|~{3,})/.exec(lines[index]);
        if (!match) continue;
        const character = match[1][0];
        if (!fenceCharacter) {
            fenceCharacter = character;
            fenceLength = match[1].length;
        } else if (character === fenceCharacter && match[1].length >= fenceLength) {
            fenceCharacter = '';
            fenceLength = 0;
        }
    }
    return Boolean(fenceCharacter);
}

/**
 * コードフェンスで囲まれたMarkdown本文の行番号を集める。
 * @param lines Markdown本文を行ごとに分けた文字列一覧。
 * @returns コードフェンス内の0始まり行番号のSet。
 */
function getFencedMarkdownLineIndexes(lines: string[]): Set<number> {
    const fencedLineIndexes = new Set<number>();
    let fenceCharacter = '';
    let fenceLength = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index]);
        if (fenceCharacter) {
            fencedLineIndexes.add(index);
            if (match && match[1][0] === fenceCharacter
                && match[1].length >= fenceLength
                && /^[ \t]*$/.test(match[2])) {
                fenceCharacter = '';
                fenceLength = 0;
            }
            continue;
        }
        if (!match) continue;
        fencedLineIndexes.add(index);
        fenceCharacter = match[1][0];
        fenceLength = match[1].length;
    }
    return fencedLineIndexes;
}

/**
 * Markdownから不要または危険な情報を除去する。
 * @param value - Markdown表セルの記法を取り除いて表示用テキストへ戻す文字列。

 */
function stripMarkdownTableCell(value: string): string {
    let text = value.trim()
        .replace(/\\\|/g, '|')
        .replace(/\\([\\`*_~+\[\]()<>])/g, '$1')
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, '');
    for (const [pattern, replacement] of INLINE_MARKERS) text = text.replace(pattern, replacement);
    return text;
}

/**
 * TSVセル内のタブ、改行、二重引用符を引用形式へ変換する。
 * @param value - TSVセルとして引用符と改行をエスケープする文字列。
 * @returns 特殊文字を含む場合に引用符で囲んだセル文字列。
 */
function encodeTsvCell(value: string): string {
    return /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * 行開始オフセットを二分探索し、本文オフセットが属する行を特定する。
 * @param lineStarts - 本文中の各行の開始オフセットを昇順に並べた配列。
 * @param offset - 属する行番号を検索する本文内オフセット。
 * @returns オフセットを含む0始まりの行番号。
 */
function findLineIndex(lineStarts: number[], offset: number): number {
    // 行開始位置の配列を二分探索し、オフセットが属する行番号を求める。
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (lineStarts[middle] <= offset) low = middle;
        else high = middle - 1;
    }
    return low;
}

/**
 * Markdownの条件を判定する。
 * @param line Markdown本文から処理する1行。
 * @returns 条件が成立したかを示す真偽値。
 */
function isTableRowLine(line: string | undefined): boolean {
    // 空でなく区切り記号を含む行を表の行候補として判定する。
    const trimmed = line?.trim() ?? '';
    return trimmed.includes('|') && trimmed.length > 0;
}

/**
 * Markdownの条件を判定する。
 * @param line Markdown本文から処理する1行。
 * @returns 条件が成立したかを示す真偽値。
 */
function isTableSeparatorLine(line: string): boolean {
    // 全セルがMarkdown表の区切り形式になっているかを判定する。
    const cells = splitTableCells(line);
    return cells.length > 0 && cells.every(
        /**
         * @param cell - Markdownで走査または更新する要素。

         */
        (cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

/**
 * Markdown表の行をエスケープされていない縦棒でセルに分割する。
 * @param line Markdown本文から処理する1行。
 * @returns 行に含まれるセル値の一覧。
 */
function splitTableCells(line: string): string[] {
    // エスケープされていない縦棒だけを区切りとして、表のセルを分割する。
    let body = line.trim();
    if (body.startsWith('|')) body = body.slice(1);
    if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
    const cells: string[] = [];
    let cell = '';
    for (let index = 0; index < body.length; index += 1) {
        const character = body[index];
        if (character === '|' && body[index - 1] !== '\\') {
            cells.push(cell.trim());
            cell = '';
        } else {
            cell += character;
        }
    }
    cells.push(cell.trim());
    return cells;
}

/**
 * 表行の区切り記号を走査し、指定オフセットが属する列を求める。
 * @param line Markdown本文から処理する1行。
 * @param offset - 表行内のUTF-16カーソルオフセット。
 * @param columnCount - 列番号を上限に制限する表の総列数。
 * @returns 0始まり列番号。結果は既存列数の範囲に制限する。
 */
function tableColumnAt(line: string, offset: number, columnCount: number): number {
    // 行内の縦棒を数え、指定オフセットが属する列番号を求める。
    const firstContent = line.search(/\S/);
    let start = firstContent < 0 ? 0 : firstContent;
    if (line[start] === '|') start += 1;
    let column = 0;
    for (let index = start; index < Math.min(offset, line.length); index += 1) {
        if (line[index] === '|' && line[index - 1] !== '\\') column += 1;
    }
    return Math.max(0, Math.min(column, columnCount - 1));
}

/**
 * インデントとセル列からMarkdown表の1行を生成する。
 * @param indent - 表行の前に保つMarkdown blockquote/listのインデント文字列。
 * @param cells - Markdown表行として出力する各セルの文字列一覧。

 */
function renderTableRow(indent: string, cells: string[]): string {
    // インデントとセル配列から、1行分のMarkdown表記を生成する。
    return indent + '| ' + cells.join(' | ') + ' |';
}

/**
 * 空の見出しに列番号を使った既定名を付ける。
 * @param value - 新しいMarkdown表列の見出し候補。空の場合は列番号から生成する。
 * @param columnNumber - 新しい列の1始まり番号。空見出しのfallback生成に使う。
 * @returns 空でない場合は入力値、空の場合は列番号から作った見出し。
 */
function newColumnHeader(value: string | undefined, columnNumber: number): string {
    // 指定された見出しを使い、空の場合は列番号から既定の見出しを作る。
    const header = value?.trim();
    return header || `列${columnNumber}`;
}

/**
 * 結合文字を幅0、全角文字を幅2として文字列の表示幅を数える。
 * @param value - 表示幅を計算する文字列。
 * @returns 全角文字を2として数えた表示幅。
 */
function displayWidth(value: string): number {
    // 結合文字を除外し、全角文字を2幅として表示幅を数える。
    let width = 0;
    for (const character of Array.from(value)) {
        if (/\p{Mark}/u.test(character)) continue;
        const codePoint = character.codePointAt(0) ?? 0;
        width += isWideCodePoint(codePoint) ? 2 : 1;
    }
    return width;
}

/**
 * 表示幅が指定値に達するまで文字列の末尾へ空白を追加する。
 * @param value - 指定幅に達するまで空白で埋める表示文字列。
 * @param width - 表示領域または列の幅。
 * @returns 指定幅まで右側を空白で埋めた文字列。
 */
function padDisplayWidth(value: string, width: number): string {
    // 現在の表示幅が指定幅に届くまで末尾へ空白を追加する。
    return value + ' '.repeat(Math.max(0, width - displayWidth(stripMveTextColorMarkup(value))));
}

/**
 * Markdownの条件を判定する。
 * @param codePoint - 全角表示幅として扱うか判定するUnicode code point値。
 * @returns 条件が成立したかを示す真偽値。
 */
function isWideCodePoint(codePoint: number): boolean {
    // コードポイントが全角表示されるUnicode範囲に含まれるかを判定する。
    return codePoint >= 0x1100 && (
        codePoint <= 0x115f
        || codePoint === 0x2329
        || codePoint === 0x232a
        || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
        || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
        || (codePoint >= 0xf900 && codePoint <= 0xfaff)
        || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
        || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
        || (codePoint >= 0xff01 && codePoint <= 0xff60)
        || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
        || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    );
}

/**
 * Markdown画像alt属性へ出力するため、予約記号をescapeし改行を除く。
 * @param value - Markdown画像altへ出力する文字列。
 * @returns 角括弧・バックスラッシュをescapeし、1行に整えたalt文字列。
 */
export function escapeMarkdownAlt(value: string): string {
    // 画像の代替テキストからMarkdown記号と改行を除去して1行へ整える。
    return value.replace(/[\[\]\\]/g, '\\$&').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Markdownの入力を検証し、表示または保存に使う形式へ変換する。
 * @param path - Markdown画像destinationへ挿入するURIまたは相対パス。
 * @param alt - Markdown画像記法へ挿入するaltテキスト。
 * @returns 指定destinationとaltを使ったMarkdown画像記法。
 */
export function imageMarkdown(path: string, alt = getMessages('ja').editor.defaultImageAlt): string {
    // パスの区切りを正規化し、エスケープ済みの代替テキストで画像記法を作る。
    return `![${escapeMarkdownAlt(alt)}](${path.replace(/\\/g, '/')})`;
}

/**
 * Markdown見出しから順序付きのアウトライン項目を作る。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @returns 見出し名、深さ、行番号、文書内オフセット、重複しないIDを持つ項目一覧。
 */
export function getOutline(markdown: string): OutlineItem[] {
    // Markdownの見出しを走査し、表示名・行番号・文書内位置・重複しないIDを収集する。
    const items: OutlineItem[] = [];
    const duplicateCount = new Map<string, number>();
    const usedIds = new Set<string>();
    const lines = markdown.split(/\r\n|\r|\n/);
    const fencedLineIndexes = getFencedMarkdownLineIndexes(lines);
    let lineNumber = 1;
    for (const lineMatch of markdown.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
        const rawLine = lineMatch[0];
        if (!rawLine && lineMatch.index === markdown.length) break;
        const line = rawLine.replace(/(?:\r\n|\r|\n)$/, '');
        if (fencedLineIndexes.has(lineNumber - 1)) {
            lineNumber += 1;
            continue;
        }
        const match = /^(#{1,6})\s+(.+?)(?:\s+\{#([^}]+)\})?\s*#*\s*$/.exec(line);
        if (match) {
            // 装飾記号を除いた見出し文字列から、明示IDまたは自動生成IDを決める。
            const visible = stripMveTextColorMarkup(match[2]);
            const explicit = /\s+\{#([^}]+)\}\s*$/.exec(visible);
            const text = visible
                .replace(/\s+\{#[^}]+\}\s*$/, '')
                .replace(/[*_`~+=]/g, '')
                .trim();
            const baseId = explicit?.[1] || match[3] || slugify(text);
            items.push({
                level: match[1].length,
                text,
                line: lineNumber,
                offset: lineMatch.index,
                id: uniqueHeadingAnchorId(baseId, duplicateCount, usedIds)
            });
        }
        lineNumber += 1;
    }
    return items;
}

/**
 * Markdownの条件を判定する。
 * @param outline Markdown見出しから構成したアウトライン項目一覧。
 * @param sourceIndex 移動元となるアウトライン項目の0始まりインデックス。
 * @param targetIndex 移動先となるアウトライン項目の0始まりインデックス。
 * @returns 条件が成立したかを示す真偽値。
 */
export function canMoveOutlineSection(
    outline: readonly OutlineItem[],
    sourceIndex: number,
    targetIndex: number
): boolean {
    if (sourceIndex === targetIndex) return false;
    const source = outline[sourceIndex];
    const target = outline[targetIndex];
    if (!source || !target) return false;
    return source.level === target.level || isOutlineEmptyParentTarget(outline, sourceIndex, targetIndex);
}

/**
 * Markdownの条件を判定する。
 * @param outline Markdown見出しから構成したアウトライン項目一覧。
 * @param sourceIndex 移動元となるアウトライン項目の0始まりインデックス。
 * @param targetIndex 移動先となるアウトライン項目の0始まりインデックス。
 * @returns 条件が成立したかを示す真偽値。
 */
export function isOutlineEmptyParentTarget(
    outline: readonly OutlineItem[],
    sourceIndex: number,
    targetIndex: number
): boolean {
    const source = outline[sourceIndex];
    const target = outline[targetIndex];
    if (!source || !target || source.level !== target.level + 1) return false;
    const next = outline[targetIndex + 1];
    return !next || next.level <= target.level;
}

/**
 * 指定したアウトライン項目を配下の見出しごと移動する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @param outline Markdown見出しから構成したアウトライン項目一覧。
 * @param sourceIndex 移動元となるアウトライン項目の0始まりインデックス。
 * @param targetIndex 移動先となるアウトライン項目の0始まりインデックス。
 * @param position 移動先項目の前後どちらへ対象項目を置くか。
 * @returns 見出しセクションを移動した本文。移動条件を満たさない場合はundefined。
 */
export function moveOutlineSection(
    markdown: string,
    outline: readonly OutlineItem[],
    sourceIndex: number,
    targetIndex: number,
    position: OutlineMovePosition
): string | undefined {
    if (!canMoveOutlineSection(outline, sourceIndex, targetIndex)) return undefined;
    const source = outline[sourceIndex];
    const target = outline[targetIndex];
    const sourceTo = findOutlineSectionEnd(markdown, outline, sourceIndex);
    const targetTo = findOutlineSectionEnd(markdown, outline, targetIndex);
    if (source.offset < 0 || source.offset > markdown.length
        || sourceTo < source.offset || sourceTo > markdown.length
        || target.offset < 0 || target.offset > markdown.length
        || targetTo < target.offset || targetTo > markdown.length) return undefined;

    const block = markdown.slice(source.offset, sourceTo);
    const withoutSource = markdown.slice(0, source.offset) + markdown.slice(sourceTo);
    const insertionPosition = isOutlineEmptyParentTarget(outline, sourceIndex, targetIndex) ? 'after' : position;
    const originalInsertion = insertionPosition === 'before' ? target.offset : targetTo;
    const insertion = originalInsertion - (source.offset < originalInsertion ? sourceTo - source.offset : 0);
    if (insertion < 0 || insertion > withoutSource.length) return undefined;
    if (insertion === source.offset) return undefined;

    const before = withoutSource.slice(0, insertion);
    const after = withoutSource.slice(insertion);
    const lineSeparator = getMarkdownLineSeparator(markdown);
    const separatorBefore = before && !endsWithLineBreak(before) ? lineSeparator : '';
    const separatorAfter = after && !endsWithLineBreak(block) ? lineSeparator : '';
    return before + separatorBefore + block + separatorAfter + after;
}

/**
 * 指定アウトライン項目から次の同階層以上の見出しまでの範囲を求める。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @param outline Markdown見出しから構成したアウトライン項目一覧。
 * @param index - 範囲の起点となるアウトライン項目の番号。
 * @returns 次の同階層以上の見出しの行、または文書末尾のオフセット。
 */
function findOutlineSectionEnd(markdown: string, outline: readonly OutlineItem[], index: number): number {
    const source = outline[index];
    if (!source) return -1;
    for (let candidate = index + 1; candidate < outline.length; candidate += 1) {
        if (outline[candidate].level <= source.level) return outline[candidate].offset;
    }
    return markdown.length;
}

/**
 * 本文に最初に現れる改行コードを調べる。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @returns CRLF、CR、LFのいずれか。改行がなければLF。
 */
function getMarkdownLineSeparator(markdown: string): string {
    const match = /\r\n|\r|\n/.exec(markdown);
    return match?.[0] ?? '\n';
}

/**
 * 文字列の末尾がCRLF、CR、LFのいずれかで終わるかを調べる。
 * @param value - 末尾がCRLF、CR、LFのいずれかであるか判定する文字列。
 * @returns 条件が成立したかを示す真偽値。
 */
function endsWithLineBreak(value: string): boolean {
    return /(?:\r\n|\r|\n)$/.test(value);
}

/**
 * Markdown本文をmarkedの解析結果と対応づけたブロック一覧に分割する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @returns Markdown本文の各ブロックと元文書内の位置を持つ一覧。
 */
export function splitMarkdownBlocks(markdown: string): MarkdownBlock[] {
    // 改行を正規化したMarkdownをmarkedで解析し、元文書のオフセットを持つブロックへ変換する。
    if (!markdown) return [{ from: 0, to: 0, raw: '', type: 'space' }];
    const { normalized, originalOffsets } = normalizeWithOriginalOffsets(markdown);
    const tokens = marked.lexer(normalized, { gfm: true, breaks: false });
    const blocks: MarkdownBlock[] = [];
    let cursor = 0;
    for (const token of tokens) {
        // トークンの前にある未分類部分を空白ブロックとして追加する。
        const raw = token.raw ?? '';
        const found = normalized.indexOf(raw, cursor);
        if (found > cursor) {
            const from = originalOffsets[cursor];
            const to = originalOffsets[found];
            blocks.push({ from, to, raw: markdown.slice(from, to), type: 'space' });
        }
        const from = found >= 0 ? found : cursor;
        const to = from + raw.length;
        const originalFrom = originalOffsets[from];
        const originalTo = originalOffsets[to];
        blocks.push({
            from: originalFrom,
            to: originalTo,
            raw: markdown.slice(originalFrom, originalTo),
            type: token.type
        });
        cursor = to;
    }
    if (cursor < normalized.length) {
        // 最後のトークン以降に残った文字列をテキストブロックとして追加する。
        const originalFrom = originalOffsets[cursor];
        blocks.push({ from: originalFrom, to: markdown.length, raw: markdown.slice(originalFrom), type: 'text' });
    }
    return blocks.length ? blocks : [{ from: 0, to: markdown.length, raw: markdown, type: 'text' }];
}

/**
 * 改行コードをLFへ統一し、正規化後の各オフセットに対応する元位置を記録する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @returns LFへ正規化した本文と、各位置に対応する原文オフセット配列。
 */
function normalizeWithOriginalOffsets(markdown: string): {
    /**
     * Markdownで扱うnormalizedの文字列。
     */
    normalized: string;
    /**
     * LF正規化本文内の各文字に対応する原文UTF-16オフセット配列。
     */
    originalOffsets: number[]
} {
    // CRLF・CRをLFへ統一し、正規化後の各文字位置から元文書位置への対応表を作る。
    let normalized = '';
    const originalOffsets = [0];
    let offset = 0;
    while (offset < markdown.length) {
        if (markdown[offset] === '\r') {
            offset += markdown[offset + 1] === '\n' ? 2 : 1;
            normalized += '\n';
        } else {
            normalized += markdown[offset];
            offset += 1;
        }
        originalOffsets.push(offset);
    }
    return { normalized, originalOffsets };
}

/**
 * Markdown本文を走査し、利用者に表示する診断を集める。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @param language - Markdownの対象や分岐を識別する値。
 * @returns 指定言語の診断メッセージと本文内位置を含む診断一覧。
 */
export function collectDiagnostics(markdown: string, language: SupportedLanguage | string = 'ja'): Diagnostic[] {
    // 文書全体を1回走査し、診断パネルとPDF出力前チェックが共有する結果を作る。
    const messages = getMessages(language);
    const diagnostics: Diagnostic[] = [];
    const lines = markdown.split(/\r\n|\r|\n/);
    const fencedLines = new Set<number>();
    let openFence: {
        /**
         * Markdownで扱うmarkerの文字列。
         */
        marker: string;
        /**
         * 対象見出しがある0始まりのMarkdown行番号です。
         */
        line: number
    } | undefined;

    lines.forEach(
        /**
         * lineごとにexecを実行する。
         * @param line Markdown本文から処理する1行。
         * @param index - 走査中の配列における0始まりの要素位置。
         */
        (line, index) => {
            const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(stripResourceContainerPrefix(line));
            if (!openFence && !match) return;
            fencedLines.add(index + 1);
            if (!match) return;
            if (!openFence) {
                openFence = { marker: match[1], line: index + 1 };
                return;
            }
            if (match[1][0] === openFence.marker[0]
                && match[1].length >= openFence.marker.length
                && /^[ \t]*$/.test(match[2])) {
                openFence = undefined;
            }
        });
    if (openFence) {
        diagnostics.push({
            severity: 'error',
            code: 'unclosed-fence',
            line: openFence.line,
            message: messages.diagnostics.unclosedFence(openFence.marker)
        });
    }

    const seen = new Map<string, number>();
    lines.forEach(
        /**
         * lineごとにifを実行する。
         * @param line Markdown本文から処理する1行。
         * @param index - 走査中の配列における0始まりの要素位置。
         */
        (line, index) => {
            if (fencedLines.has(index + 1)) return;
            const match = /^(#{1,6})\s+(.+?)(?:\s+\{#([^}]+)\})?\s*#*\s*$/.exec(line);
            if (!match) return;
            const visible = stripMveTextColorMarkup(match[2]);
            const explicit = /\s+\{#([^}]+)\}\s*$/.exec(visible);
            const id = explicit?.[1] || match[3] || slugify(
                visible
                    .replace(/\s+\{#[^}]+\}\s*$/, '')
                    .replace(/[*_`~+=]/g, '')
                    .trim()
            );
            const count = seen.get(id) ?? 0;
            if (count) {
                diagnostics.push({
                    severity: 'warning',
                    code: 'duplicate-heading',
                    line: index + 1,
                    message: messages.diagnostics.duplicateHeading(id)
                });
            }
            seen.set(id, count + 1);
        });

    const recognizedTableLines = new Set<number>();
    for (let index = 0; index < lines.length - 1; index += 1) {
        if (fencedLines.has(index + 1) || recognizedTableLines.has(index + 1) || !isTableRowLine(lines[index])) continue;
        const next = lines[index + 1];
        if (isTableSeparatorLine(next)) {
            diagnoseMarkdownTable(lines, index, fencedLines, diagnostics, messages);
            recognizedTableLines.add(index + 1);
            recognizedTableLines.add(index + 2);
            for (let rowIndex = index + 2; rowIndex < lines.length && isTableRowLine(lines[rowIndex]); rowIndex += 1) {
                recognizedTableLines.add(rowIndex + 1);
            }
        } else if (isInvalidTableSeparatorCandidate(next)) {
            diagnostics.push({
                severity: 'error',
                code: 'invalid-table-separator',
                line: index + 2,
                message: messages.diagnostics.invalidTableSeparator
            });
            recognizedTableLines.add(index + 1);
            recognizedTableLines.add(index + 2);
            for (let rowIndex = index + 2; rowIndex < lines.length && isTableRowLine(lines[rowIndex]); rowIndex += 1) {
                recognizedTableLines.add(rowIndex + 1);
            }
        }
    }

    const referenceDefinitions = new Set<string>();
    lines.forEach(
        /**
         * lineごとにifを実行する。
         * @param line Markdown本文から処理する1行。
         * @param index - 走査中の配列における0始まりの要素位置。
         */
        (line, index) => {
            if (fencedLines.has(index + 1)) return;
            const definition = parseReferenceDefinition(line);
            if (definition) referenceDefinitions.add(normalizeReferenceLabel(definition));
        });
    lines.forEach(
        /**
         * lineごとにifを実行する。
         * @param line Markdown本文から処理する1行。
         * @param index - 走査中の配列における0始まりの要素位置。
         */
        (line, index) => {
            if (fencedLines.has(index + 1)) return;
            if (parseReferenceDefinition(line)) return;
            const sourceLine = maskInlineCode(line);
            for (const reference of collectReferenceUsages(sourceLine)) {
                if (reference.isImage && !reference.text.trim()) {
                    diagnostics.push({
                        severity: 'warning',
                        code: 'empty-image-alt',
                        line: index + 1,
                        message: messages.diagnostics.emptyImageAlt
                    });
                }
                reportBrokenReference(reference.label || reference.text, index + 1, referenceDefinitions, diagnostics, messages);
            }
        });

    const imageSource = markdown.replace(/`+[^`\r\n]*`+/g,
        /**
         * @param code - Markdownへ渡す入力。
         * @returns 改行以外を空白にした、元の長さを保つコードマスク。
         */
        (code) => code.replace(/[^\r\n]/g, ' '));
    const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let imageMatch: RegExpExecArray | null;
    while ((imageMatch = imagePattern.exec(imageSource))) {
        const line = markdown.slice(0, imageMatch.index).split(/\r\n|\r|\n/).length;
        if (fencedLines.has(line)) continue;
        if (!imageMatch[1].trim()) {
            diagnostics.push({
                severity: 'warning',
                code: 'empty-image-alt',
                line,
                message: messages.diagnostics.emptyImageAlt
            });
        }
        if (/^(?:https?:|data:|#)/i.test(imageMatch[2])) continue;
        diagnostics.push({
            severity: 'info',
            code: 'local-image',
            line,
            source: imageMatch[2],
            message: messages.diagnostics.localImageCheck(imageMatch[2])
        });
    }
    return sortDiagnostics(diagnostics);
}

/**
 * Markdown内で参照されるローカル画像・リンク先を収集する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @returns 文書内位置と参照先を含むローカルリソース一覧。
 */
export function collectLocalResourceReferences(markdown: string): LocalResourceReference[] {
    const lines = markdown.split(/\r\n|\r|\n/);
    const fencedLines = new Set<number>();
    let openFence: {
        /**
         * Markdownで扱うmarkerの文字列。
         */
        marker: string;
        /**
         * 対象見出しがある0始まりのMarkdown行番号です。
         */
        line: number
    } | undefined;
    lines.forEach(
        /**
         * lineごとにexecを実行する。
         * @param line - lineのsを参照する走査対象。
         * @param index - 走査中の配列における0始まりの要素位置。
         */
        (line, index) => {
            const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(stripResourceContainerPrefix(line));
            if (!openFence && !match) return;
            fencedLines.add(index + 1);
            if (!match) return;
            if (!openFence) {
                openFence = { marker: match[1], line: index + 1 };
                return;
            }
            if (match[1][0] === openFence.marker[0]
                && match[1].length >= openFence.marker.length
                && /^[ \t]*$/.test(match[2])) {
                openFence = undefined;
            }
        });

    const commentState = { open: false };
    let inTextileCodeBlock = false;
    const scanLines = lines.map(
        /**
         * 各lineからlengthを取り出して一覧化する。
         * @param line - lineのlengthを参照する走査対象。
         * @param index - 走査中の配列における0始まりの要素位置。
         * @returns lengthを取り出した変換結果の一覧。
         */
        (line, index) => {
            if (fencedLines.has(index + 1) || isIndentedResourceCodeLine(line)) return ' '.repeat(line.length);
            if (inTextileCodeBlock) {
                if (!line.trim()) inTextileCodeBlock = false;
                return ' '.repeat(line.length);
            }
            if (/^(?:bc|pre)\.\s/.test(line)) {
                inTextileCodeBlock = true;
                return ' '.repeat(line.length);
            }
            return maskHtmlComments(maskInlineCode(line), commentState);
        });
    const scanSource = scanLines.join('\n');
    const definitions = new Map<string, LocalResourceDefinition>();
    const definitionLines = new Set<number>();
    scanLines.forEach(
        /**
         * @param line Markdown本文から処理する1行。
         * @param index - 走査中の配列における0始まりの要素位置。
         */
        (line, index) => {
            const definition = parseLocalResourceDefinition(line, lines[index + 1]);
            if (!definition || !isLocalResourceSource(definition.source)) return;
            definitionLines.add(index + 1);
            definitions.set(normalizeReferenceLabel(definition.label), {
                kind: definition.kind,
                source: definition.source,
                ...(definition.workspaceRooted ? { workspaceRooted: true } : {}),
                line: index + 1
            });
        });

    const references: LocalResourceReference[] = [];
    const usedDefinitions = new Set<string>();
    for (const scanned of scanMarkdownResourceLinks(scanSource)) {
        const line = lineNumberAt(scanSource, scanned.offset);
        if (definitionLines.has(line)) continue;
        if (scanned.source) {
            if (isLocalResourceSource(scanned.source)) {
                references.push({
                    kind: scanned.kind,
                    source: scanned.source,
                    ...(scanned.workspaceRooted ? { workspaceRooted: true } : {}),
                    line
                });
            }
            continue;
        }
        const label = normalizeReferenceLabel(scanned.referenceLabel ?? '');
        const definition = definitions.get(label);
        if (!definition) continue;
        usedDefinitions.add(label);
        references.push({
            kind: scanned.kind === 'image' || definition.kind === 'image' ? 'image' : 'link',
            source: definition.source,
            ...(definition.workspaceRooted ? { workspaceRooted: true } : {}),
            line
        });
    }
    references.push(...collectTextileResourceReferences(scanLines));

    // 参照定義が単独で書かれている場合も、定義行自体を検査対象にする。
    definitions.forEach(
        /**
         * definitionごとにifを実行する。
         * @param definition - definitionのkindを参照する走査対象。
         * @param label - 使用済み判定に使う正規化済み参照ラベル。
         */
        (definition, label) => {
            if (!usedDefinitions.has(label)) {
                references.push({
                    kind: definition.kind,
                    source: definition.source,
                    ...(definition.workspaceRooted ? { workspaceRooted: true } : {}),
                    line: definition.line
                });
            }
        });
    return references;
}

/**
 * Masked source linesからTextile形式のローカル画像・リンクを抽出する。
 * Markdownフェンス、インラインコード、HTMLコメント、Textileコードブロックは呼び出し元でマスク済み。
 * @param lines - 各行番号を保った参照解析用ソース行。
 * @returns リソース種別、参照先、行番号を持つTextile参照一覧。
 */
function collectTextileResourceReferences(lines: readonly string[]): LocalResourceReference[] {
    const references: LocalResourceReference[] = [];
    lines.forEach(
        /**
         * 各Textile行からリンクと画像記法を抽出する。
         * @param line - Textile参照を含む可能性があるマスク済みソース行。
         * @param index - 走査中の0始まり行番号。
         */
        (line, index) => {
            for (const match of line.matchAll(/"([^"\r\n]+)":([^\s<>]+)/g)) {
                const source = match[2].replace(/[.,!?;:]+$/, '');
                if (isLocalResourceSource(source)) {
                    references.push({ kind: 'link', source, line: index + 1 });
                }
            }
            for (const match of line.matchAll(/!(?!\[)([^!\s()]+)(?:\(([^)]*)\))?!/g)) {
                const source = match[1];
                if (isLocalResourceSource(source)) {
                    references.push({ kind: 'image', source, line: index + 1 });
                }
            }
        });
    return references;
}

/**
 * Markdown本文からリンク・画像の参照先とソース上の範囲を収集する。
 * @param source - リンク・画像の参照先を抽出するMarkdown本文。
 * @returns 参照先、リンク形式、本文内の範囲を持つリソース参照一覧。
 */
function scanMarkdownResourceLinks(source: string): ScannedResourceLink[] {
    const links: ScannedResourceLink[] = [];
    for (let index = 0; index < source.length; index += 1) {
        const isImage = source[index] === '!' && source[index + 1] === '[';
        const open = isImage ? index + 1 : index;
        if (source[open] !== '['
            || source[open - 1] === '\\'
            || (source[open - 1] === '!' && source[open - 2] === '\\')
            || (isImage && source[index - 1] === '\\')) continue;
        const text = readBracketContent(source, open);
        if (!text) continue;
        const kind = isImage ? 'image' : 'link';
        const afterText = text.end + 1;
        if (source[afterText] === '(') {
            const destination = readInlineResourceDestination(source, afterText);
            if (destination) {
                links.push({
                    kind,
                    source: destination.source,
                    ...(destination.workspaceRooted ? { workspaceRooted: true } : {}),
                    offset: index
                });
                index = destination.end;
                continue;
            }
        }
        if (source[afterText] === '[') {
            const label = readBracketContent(source, afterText);
            if (label) {
                links.push({
                    kind,
                    referenceLabel: label.content || text.content,
                    offset: index
                });
                index = label.end;
                continue;
            }
        }
        // 定義済みのショートカット参照は、定義マップで解決できるものだけ後段で採用する。
        links.push({ kind, referenceLabel: text.content, offset: index });
        index = text.end;
    }
    const htmlPattern = /<(img|a)\b[^>]*?\b(src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/giu;
    let htmlMatch: RegExpExecArray | null;
    while ((htmlMatch = htmlPattern.exec(source))) {
        const htmlSource = htmlMatch[3] ?? htmlMatch[4] ?? htmlMatch[5] ?? '';
        links.push({
            kind: htmlMatch[1].toLowerCase() === 'img' ? 'image' : 'link',
            source: htmlSource,
            offset: htmlMatch.index
        });
    }
    return links.sort(
        /**
         * 2つの値を比較して並び順を決める。
         * @param left - 比較対象の左側の値。
         * @param right - 比較対象の右側の値。
         * @returns 2つの要素の順序を示す数値。
         */
        (left, right) => left.offset - right.offset);
}

/**
 * Markdownのinline linkから、括弧内のリソース参照先を読み取る。
 * @param source - 参照先を読むinline linkを含むMarkdown本文。
 * @param open - destination読取開始位置となる開き括弧のUTF-16オフセット。
 * @returns 参照先文字列と閉じ括弧位置。参照先がない場合はundefined。
 */
function readInlineResourceDestination(source: string, open: number): {
    /**
     * 解析・描画・変換の起点となる本文。
     */
    source: string;

    /** 専用title印がリンクのワークスペース基準指定に使われているかを示す。 */
    workspaceRooted: boolean;
    /**
     * リソース参照記法の終了位置を示す本文内UTF-16オフセットです。
     */
    end: number
} | undefined {
    let index = open + 1;
    while (/\s/u.test(source[index] ?? '')) index += 1;
    if (index >= source.length) return undefined;

    let destination: string;
    if (source[index] === '<') {
        const start = ++index;
        while (index < source.length) {
            if (source[index] === '\\') {
                index += 2;
                continue;
            }
            if (source[index] === '>') break;
            index += 1;
        }
        if (source[index] !== '>') return undefined;
        destination = source.slice(start, index);
        index += 1;
    } else {
        const start = index;
        let nestedParentheses = 0;
        while (index < source.length) {
            const character = source[index];
            if (character === '\\') {
                index += 2;
                continue;
            }
            if (character === '(') {
                nestedParentheses += 1;
                index += 1;
                continue;
            }
            if (character === ')') {
                if (nestedParentheses === 0) break;
                nestedParentheses -= 1;
                index += 1;
                continue;
            }
            if (/\s/u.test(character) && nestedParentheses === 0) break;
            index += 1;
        }
        destination = source.slice(start, index);
    }
    if (!destination) return undefined;
    const close = findInlineResourceClose(source, index);
    if (close < 0) return undefined;
    return {
        source: destination.replace(/\\([\\()])/g, '$1'),
        workspaceRooted: isWorkspaceSectionLinkTitle(source.slice(index, close)),
        end: close
    };
}

/** Markdown titleの引用形式を除いてワークスペースリンク用の印か判定する。 */
function isWorkspaceSectionLinkTitle(value: string): boolean {
    return readResourceDefinitionTitle(value) === WORKSPACE_SECTION_LINK_TITLE;
}

/** Markdown参照定義で使える引用形式からtitle本文を取り出す。 */
function readResourceDefinitionTitle(value: string): string | undefined {
    const match = /^\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^)\\])*)\))\s*$/u.exec(value);
    const title = match?.[1] ?? match?.[2] ?? match?.[3];
    return title === undefined ? undefined : unescapeResourceTitle(title);
}

/** Markdown titleのバックスラッシュでエスケープされた句読点を復元する。 */
function unescapeResourceTitle(title: string): string {
    const escapablePunctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_{|}~";
    return title.replace(/\\(.)/gu, (escape, character: string) =>
        character === String.fromCharCode(96) || escapablePunctuation.includes(character)
            ? character
            : escape);
}

/**
 * 入れ子の括弧とエスケープを考慮してlink destinationの終端を探す。
 * @param source - 括弧付きlink destinationを含むMarkdown本文。
 * @param start - 開き括弧の次から検索する本文内UTF-16オフセット。
 * @returns 閉じ括弧の位置。見つからない場合は-1。
 */
function findInlineResourceClose(source: string, start: number): number {
    let nestedParentheses = 0;
    for (let index = start; index < source.length; index += 1) {
        if (source[index] === '\\') {
            index += 1;
            continue;
        }
        if (source[index] === '(') nestedParentheses += 1;
        if (source[index] !== ')') continue;
        if (nestedParentheses === 0) return index;
        nestedParentheses -= 1;
    }
    return -1;
}

/**
 * Markdown参照定義行と任意の次行タイトルを解析する。
 * @param line Markdown本文から処理する1行。
 * @returns 参照定義の種別、ラベル、参照先など。定義として解析できない場合はundefined。
 */
function parseLocalResourceDefinition(line: string, followingLine?: string): {
    /**
     * メッセージ、項目、または処理の種類を識別する値。
     */
    kind: 'image' | 'link';
    /**
     * 画面または検証結果に表示する説明文。
     */
    label: string;
    /**
     * 解析・描画・変換の起点となる本文。
     */
    source: string;
    /** Titleがワークスペース基準リンクを示すかどうか。 */
    workspaceRooted: boolean;
} | undefined {
    const candidate = stripResourceContainerPrefix(line);
    const match = /^(!?)\[([^\]]*)\]:\s*(<[^>\r\n]+>|[^\s]+)(?:\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^)\\])*)\)))?\s*$/u.exec(candidate);
    if (!match || match[2].startsWith('^')) return undefined;
    const inlineTitle = match[4] ?? match[5] ?? match[6];
    const continuationTitle = inlineTitle === undefined && followingLine !== undefined
        ? readResourceDefinitionTitle(stripResourceContainerPrefix(followingLine))
        : undefined;
    const title = inlineTitle === undefined ? continuationTitle : unescapeResourceTitle(inlineTitle);
    return {
        kind: match[1] ? 'image' : 'link',
        label: match[2],
        source: match[3].replace(/^<|>$/g, '').trim(),
        workspaceRooted: title === WORKSPACE_SECTION_LINK_TITLE
    };
}

/**
 * Markdownの条件を判定する。
 * @param line Markdown本文から処理する1行。
 * @returns 条件が成立したかを示す真偽値。
 */
function isIndentedResourceCodeLine(line: string): boolean {
    if (/^(?: {4}|\t)/u.test(line)) return true;
    if (/^\s{0,3}(?:>|(?:[-+*]|\d+[.)]))\s+ {4}/u.test(line)) return true;
    const stripped = stripResourceContainerPrefix(line);
    return stripped !== line && /^(?: {4}|\t)/u.test(stripped);
}

/**
 * Markdownから不要または危険な情報を除去する。
 * @param line Markdown本文から処理する1行。

 */
function stripResourceContainerPrefix(line: string): string {
    if (/^(?: {4}|\t)/u.test(line)) return line;
    let result = line;
    for (let count = 0; count < 4; count += 1) {
        const next = result
            .replace(/^\s{0,3}>\s?/u, '')
            .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/u, '');
        if (next === result) break;
        result = next;
    }
    return result.replace(/^\s+/u, '');
}

/**
 * コードや文字列内にないHTMLコメントを、解析対象からマスクする。
 * @param line Markdown本文から処理する1行。
 * @param state - 現在の編集・表示状態。
 * @returns コメント部分を同じ長さの空白に置き換えた行。
 */
function maskHtmlComments(line: string, state: {
    /**
     * Markdownのopenを切り替えるフラグ。
     */
    open: boolean
}): string {
    let result = '';
    let offset = 0;
    while (offset < line.length) {
        if (state.open) {
            const close = line.indexOf('-->', offset);
            if (close < 0) return `${result}${' '.repeat(line.length - offset)}`;
            result += ' '.repeat(close + 3 - offset);
            offset = close + 3;
            state.open = false;
            continue;
        }
        const open = line.indexOf('<!--', offset);
        if (open < 0) return result + line.slice(offset);
        result += line.slice(offset, open);
        result += ' '.repeat(4);
        offset = open + 4;
        state.open = true;
    }
    return result;
}

/**
 * UTF-16オフセットが属するMarkdown行の1始まり行番号を求める。
 * @param source - 行番号を求めるMarkdown本文。
 * @param offset - 行番号を求める本文内UTF-16オフセット。
 * @returns 1始まりの行番号。
 */
function lineNumberAt(source: string, offset: number): number {
    let line = 1;
    for (let index = 0; index < offset; index += 1) {
        if (source[index] === '\n') line += 1;
    }
    return line;
}

/**
 * 診断を重大度、行番号、本文内オフセットの順に並べ替える。
 * @param diagnostics - 集約または整形する診断一覧。
 * @returns 表示順に並べた診断一覧。
 */
export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
    return diagnostics
        .map(
            /**
             * 各項目を変換して一覧化する。
             * @param item - 走査中の要素。
             * @param index - 走査中の配列における0始まりの要素位置。

             */
            (item, index) => ({ item, index }))
        .sort(
            /**
             * 行または配列位置を比較して並び順を決める。
             * @param left - 比較対象の左側の値。
             * @param right - 比較対象の右側の値。
             * @returns 2つの要素の順序を示す数値。
             */
            (left, right) => {
                const leftLine = left.item.line ?? Number.MAX_SAFE_INTEGER;
                const rightLine = right.item.line ?? Number.MAX_SAFE_INTEGER;
                return leftLine - rightLine || left.index - right.index;
            })
        .map(
            /**
             * 各設定を変換して一覧化する。
             * @param item - 並べ替えた診断一覧へ戻すDiagnostic項目。

             */
            ({ item }) => item);
}

/**
 * 診断一覧を重大度別の件数に集約する。
 * @param diagnostics - 集約または整形する診断一覧。
 * @returns error、warning、infoそれぞれの診断件数。
 */
export function summarizeDiagnostics(diagnostics: Diagnostic[]): DiagnosticSummary {
    return {
        errors: diagnostics.filter(
            /**
             * 種別「error」の項目だけを残す。
             * @param item - 項目のseverityを参照する走査対象。

             */
            (item) => item.severity === 'error'),
        warnings: diagnostics.filter(
            /**
             * 種別「warning」の項目だけを残す。
             * @param item - 項目のseverityを参照する走査対象。

             */
            (item) => item.severity === 'warning'),
        infos: diagnostics.filter(
            /**
             * 種別「info」の項目だけを残す。
             * @param item - 項目のseverityを参照する走査対象。

             */
            (item) => item.severity === 'info')
    };
}

/**
 * 表の区切り行とセル数を検証し、誤ったMarkdown表に診断を追加する。
 * @param lines Markdown本文を行ごとに分けた文字列一覧。
 * @param headerLine 表見出し行の0始まりインデックス。
 * @param fencedLines コードフェンス内にある0始まり行インデックスのSet。
 * @param diagnostics - 集約または整形する診断一覧。
 * @param messages 診断に表示する翻訳済みメッセージ。
 */
function diagnoseMarkdownTable(lines: string[], headerLine: number, fencedLines: Set<number>, diagnostics: Diagnostic[], messages: ReturnType<typeof getMessages>): void {
    const header = splitTableCells(lines[headerLine]);
    const separator = splitTableCells(lines[headerLine + 1]);
    if (header.some(
        /**
         * @param cell - Markdownで走査または更新する要素。
         * @returns 条件が成立したかを示す真偽値。
         */
        (cell) => !cell.trim())) {
        diagnostics.push({
            severity: 'warning',
            code: 'empty-table-header',
            line: headerLine + 1,
            message: messages.diagnostics.emptyTableHeader
        });
    }
    if (header.length !== separator.length) {
        diagnostics.push({
            severity: 'error',
            code: 'table-column-mismatch',
            line: headerLine + 2,
            message: messages.diagnostics.tableColumnMismatch(header.length, separator.length, 'separator')
        });
    }
    for (let index = headerLine + 2; index < lines.length && isTableRowLine(lines[index]); index += 1) {
        if (fencedLines.has(index + 1)) break;
        const row = splitTableCells(lines[index]);
        if (row.length !== header.length) {
            diagnostics.push({
                severity: 'error',
                code: 'table-column-mismatch',
                line: index + 1,
                message: messages.diagnostics.tableColumnMismatch(header.length, row.length, 'body')
            });
        }
    }
}

/**
 * Markdownの条件を判定する。
 * @param line Markdown本文から処理する1行。
 * @returns 条件が成立したかを示す真偽値。
 */
function isLikelyTableSeparatorLine(line: string): boolean {
    const cells = splitTableCells(line);
    return cells.length > 0 && cells.some(
        /**
         * @param cell - Markdownで走査または更新する要素。
         * @returns 条件が成立したかを示す真偽値。
         */
        (cell) => /^:?-{1,}:?$/.test(cell.trim())) && line.includes('|');
}

/**
 * Markdownの条件を判定する。
 * @param separator - GFM表区切り行か判定するMarkdownテキスト候補。
 * @returns 条件が成立したかを示す真偽値。
 */
function isInvalidTableSeparatorCandidate(separator: string): boolean {
    const cells = splitTableCells(separator);


    const separatorLike = /**
     * @param cell - Markdownで走査または更新する要素。
     * @returns 条件が成立したかを示す真偽値。
     */ (cell: string): boolean => !cell.trim() || /^:?-{1,}:?$/.test(cell.trim());
    return isLikelyTableSeparatorLine(separator) && cells.every(separatorLike);
}

/**
 * 角括弧内から抽出した内容と、閉じ括弧直後の本文内UTF-16オフセットです。
 */
interface BracketContent {

    /**
     * Markdownで解析・表示・保存する本文。
     */
    content: string;

    /**
     * 角括弧内テキストの終了位置を示す本文内UTF-16オフセットです。
     */
    end: number;
}

/**
 * 参照リンク定義のラベルと使用箇所の集計結果です。
 */
interface ReferenceUsage {

    /**
     * Markdownの状態を示すフラグ。
     */
    isImage: boolean;

    /**
     * 表示・解析・変換の対象となる本文。
     */
    text: string;

    /**
     * 画面または検証結果に表示する説明文。
     */
    label: string;
}

/**
 * 開き括弧に対応する閉じ括弧と、その間の内容を探す。
 * @param source - 角括弧の内容を抽出するMarkdown本文。
 * @param open - 開き角括弧の本文内UTF-16インデックス。
 * @returns 閉じ括弧の位置と内容。対応する括弧が閉じていない場合はundefined。
 */
function readBracketContent(source: string, open: number): BracketContent | undefined {
    let depth = 0;
    let content = '';
    for (let index = open + 1; index < source.length; index += 1) {
        const character = source[index];
        if (character === '\\' && index + 1 < source.length) {
            content += character + source[index + 1];
            index += 1;
            continue;
        }
        if (character === '[') {
            depth += 1;
            content += character;
            continue;
        }
        if (character === ']') {
            if (depth === 0) return { content, end: index };
            depth -= 1;
            content += character;
            continue;
        }
        content += character;
    }
    return undefined;
}

/**
 * 1行から定義参照と参照リンクの使用箇所を収集する。
 * @param line Markdown本文から処理する1行。
 * @returns ラベルと本文内オフセットを含む参照使用箇所。
 */
function collectReferenceUsages(line: string): ReferenceUsage[] {
    const usages: ReferenceUsage[] = [];
    for (let index = 0; index < line.length; index += 1) {
        const isImage = line[index] === '!' && line[index + 1] === '[';
        const open = isImage ? index + 1 : index;
        if (line[open] !== '[' || (open > 0 && line[open - 1] === '\\')) continue;
        const text = readBracketContent(line, open);
        if (!text) continue;
        const labelOpen = text.end + 1;
        if (line[labelOpen] !== '[') {
            index = text.end;
            continue;
        }
        const label = readBracketContent(line, labelOpen);
        if (!label) {
            index = text.end;
            continue;
        }
        usages.push({ isImage, text: text.content, label: label.content });
        index = label.end;
    }
    return usages;
}

/**
 * 参照定義行からリンク識別子を取り出す。
 * @param line Markdown本文から処理する1行。
 * @returns 参照定義で取得した識別子。対象行でない場合はundefined。
 */
function parseReferenceDefinition(line: string): string | undefined {
    const open = line.search(/\S/);
    if (open < 0 || line[open] !== '[') return undefined;
    const label = readBracketContent(line, open);
    if (!label || !/^\s*:/.test(line.slice(label.end + 1))) return undefined;
    const destination = line.slice(label.end + 1).replace(/^\s*:\s*/, '');
    if (!/^(?:<[^>\r\n]+>|\S+)/.test(destination)) return undefined;
    return label.content;
}

/**
 * inline code部分を同じ長さの空白へ置き換えて解析対象から除く。
 * @param line Markdown本文から処理する1行。
 * @returns inline code以外の文字を保持したマスク済み行。
 */
function maskInlineCode(line: string): string {
    return line.replace(/`+[^`\r\n]*`+/g,
        /**
         * Markdownの前提条件を準備し、回帰条件を検証するテストケース。
         * @param code - 正規表現に一致したインラインコード範囲。
         */
        (code) => code.replace(/[^\r\n]/g, ' '));
}

/**
 * 未定義の参照リンクを診断一覧へ追加する。
 * @param label - 未定義参照リンクのラベル。空の場合は呼び出し側が渡したリンク文字列。
 * @param line 診断に記録するMarkdownの1始まり行番号。
 * @param definitions 既知の参照ラベルを保持するSet。
 * @param diagnostics - 集約または整形する診断一覧。
 * @param messages 診断に表示する翻訳済みメッセージ。
 */
function reportBrokenReference(
    label: string,
    line: number,
    definitions: Set<string>,
    diagnostics: Diagnostic[],
    messages: ReturnType<typeof getMessages>
): void {
    const normalizedLabel = normalizeReferenceLabel(label);
    if (!normalizedLabel) return;
    if (definitions.has(normalizedLabel)) return;
    diagnostics.push({
        severity: 'warning',
        code: 'broken-reference-link',
        line,
        message: messages.diagnostics.missingReference(normalizedLabel)
    });
}

/**
 * Markdown参照ラベルのエスケープと空白を正規化し、小文字へ変換する。
 * @param label - Markdown参照定義との照合に使う参照ラベル。

 */
function normalizeReferenceLabel(label: string): string {
    return label.trim().replace(/\\([\\\[\]])/g, '$1').replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Markdownの条件を判定する。
 * @param source - ローカル参照か判定するリンクまたは画像のdestination文字列。
 * @returns 条件が成立したかを示す真偽値。
 */
function isLocalResourceSource(source: string): boolean {
    if (!source || /^#/u.test(source)) return false;
    if (/^[A-Za-z]:[\\/]/u.test(source)) return true;
    if (/^(?:\\\\|\/\/)/u.test(source)) return true;
    if (/^file:/i.test(source)) return true;
    return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(source);
}

/**
 * 過剰な空行を縮約し、改行形式を保って末尾改行を付ける。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @returns 余分な空行を整理したMarkdown本文。
 */
export function formatMarkdown(markdown: string): string {
    // 改行形式を保ったまま過剰な空行を縮約し、末尾に改行を付ける。
    const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
    // 行末空白はMarkdownのハードブレークやユーザー入力の一部なので変更しない。
    const normalized = markdown
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(
            /**
             * 各lineからsliceを取り出して一覧化する。
             * @param line - lineのsliceを参照する走査対象。
             * @returns sliceを取り出した変換結果の一覧。
             */
            (line) => {
                const trailing = /[\t ]+$/.exec(line)?.[0] ?? '';
                return /^ {2,}$/.test(trailing) ? line : line.slice(0, line.length - trailing.length);
            })
        .join('\n')
        .replace(/\n{4,}/g, '\n\n\n');
    const finalText = normalized.length && !normalized.endsWith('\n') ? normalized + '\n' : normalized;
    return eol === '\r\n' ? finalText.replace(/\n/g, '\r\n') : finalText;
}

/**
 * Markdown本文を走査し、単語数と行数を集計する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @returns 集計した単語数と行数。
 */
export function wordStats(markdown: string): {
    /**
     * 集計対象Markdown本文のUTF-16文字数。
     */
    markdown: number;
    /**
     * Markdown構文を除去した本文のUTF-16文字数。
     */
    text: number;
    /**
     * Markdown本文に含まれる改行区切りの行数。
     */
    lines: number
} {
    // コードやMarkdown記号を除いた本文を作り、文字数と行数を数える。
    const text = stripMveTextColorMarkup(markdown)
        .replace(/```[\s\S]*?```/g, '')
        .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1')
        .replace(/[*_`~+=#>|-]/g, '')
        .trim();
    return {
        markdown: markdown.length,
        text: Array.from(text).length,
        lines: markdown ? markdown.split(/\r?\n/).length : 1
    };
}

/**
 * 見出し文字列を小文字化し、文字・数字・ハイフンだけのslugにする。
 * @param value - 見出しからアンカーIDを生成する元テキスト。
 * @returns 空白をハイフンへ置換し、アンカーIDに使える形へ正規化した文字列。
 */
export function slugify(value: string): string {
    // 見出し文字列を小文字化し、使用可能な文字とハイフンだけのIDへ変換する。
    return value
        .trim()
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-') || 'section';
}

/** 自動サフィックスと見出し本文の衝突を避けて、一意なアンカーIDを割り当てる。 */
function uniqueHeadingAnchorId(base: string, counts: Map<string, number>, usedIds: Set<string>): string {
    let count = counts.get(base) ?? 0;
    let id = count ? `${base}-${count}` : base;
    while (usedIds.has(id)) {
        count += 1;
        id = `${base}-${count}`;
    }
    counts.set(base, count + 1);
    usedIds.add(id);
    return id;
}

/**
 * 描画順を保ちながら、明示アンカーまたは見出し本文から一意なIDを割り当てる。
 * @param rawText アンカー生成前の見出し本文。
 * @param counts 同じ基底IDが現れた回数を保持する辞書。
 * @param usedIds すでに割り当てたIDの集合。
 * @returns 衝突を避けて割り当てた見出しID。
 */
export function nextHeadingAnchorId(rawText: string, counts: Map<string, number>, usedIds: Set<string>): string {
    const plain = stripMveTextColorMarkup(rawText);
    const explicit = /\s+\{#([^}]+)\}\s*$/.exec(plain);
    const base = explicit?.[1] ?? slugify(plain.replace(/\s+\{#[^}]+\}\s*$/, ''));
    return uniqueHeadingAnchorId(base, counts, usedIds);
}

/**
 * 同じMarkdown文書内で見出しへ移動するリンクを作る。
 * @param text リンクラベルに使う見出し本文。
 * @param id 描画時に割り当てられた見出しアンカーID。
 * @returns 文書内の見出しを指すMarkdownリンク。
 */
export function sectionMarkdownLink(text: string, id: string): string {
    return sectionMarkdownLinkToPath(text, id, '');
}

/**
 * ワークスペース相対パスを含む見出しリンクを作る。
 * @param text リンクラベルに使う見出し本文。
 * @param id 描画時に割り当てられた見出しアンカーID。
 * @param relativePath ワークスペース内の移動先Markdown文書。
 * @returns 移動先文書の見出しを指すMarkdownリンク。
 * @throws {Error} パスが空、または `..` を含んでワークスペース外へ出る場合。
 */
export function workspaceSectionMarkdownLink(text: string, id: string, relativePath: string): string {
    const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = normalizedPath.split('/').filter((segment) => segment && segment !== '.');
    if (!segments.length || segments.some((segment) => segment === '..')) {
        throw new Error('ワークスペース内のMarkdown文書パスが不正です。');
    }
    const destinationPath = `/${segments.map(encodeMarkdownPathSegment).join('/')}`;
    return sectionMarkdownLinkToPath(text, id, destinationPath, WORKSPACE_SECTION_LINK_TITLE);
}

/** 見出し名とアンカーをMarkdownリンクとして安全に組み立てる。 */
function sectionMarkdownLinkToPath(text: string, id: string, destinationPath: string, title?: string): string {
    const label = (text.trim() || id)
        .replace(/[\r\n]+/g, ' ')
        .replace(/[\\`*_\[\]~^+=$<>&!|]/gu, '\\$&');
    const fragment = id.replace(/[%#&|()[\]<>\\"'\s]/gu, (character) => {
        const encoded = encodeURIComponent(character);
        return encoded === character
            ? `%${character.charCodeAt(0).toString(16).toUpperCase()}`
            : encoded;
    });
    const titleSuffix = title === undefined ? '' : ` "${title}"`;
    return `[${label}](${destinationPath}#${fragment}${titleSuffix})`;
}

/** Markdownリンク先で構文区切りになる文字だけをパスの各要素内でエスケープする。 */
function encodeMarkdownPathSegment(segment: string): string {
    return segment.replace(/[%#?()[\]<>|&\s]/gu, (character) => encodeURIComponent(character));
}

/** 見出しのトークン位置を元の行へ対応付けるため、改行数を数える。 */
function countLineBreaks(value: string): number {
    return (value.match(/\r\n|\r|\n/g) ?? []).length;
}

/**
 * 描画と同じ見出しIDの割り当て順で、リンク先の行番号を求める。
 * @param markdown 見出し階層を走査するMarkdown本文。
 * @param targetId 移動先として検索する見出しアンカーID。
 * @param format 文書の描画形式。省略時は既存互換のMarkdown形式を使う。
 * @returns 一致した見出しの1始まり行番号。本文にIDがない場合はundefined。
 */
export function headingLineForAnchor(
    markdown: string,
    targetId: string,
    format: 'markdown' | 'mixed' | 'textile' = 'markdown'
): number | undefined {
    if (format !== 'markdown') {
        return getOutlineForFormatSource(markdown, format).find(
            /** @param heading - 指定形式から抽出したアウトライン見出し。 */
            (heading) => heading.id === targetId
        )?.line;
    }

    const counts = new Map<string, number>();
    const usedIds = new Set<string>();
    const parser = new Marked({ gfm: true, breaks: false });
    parser.use({ extensions: [
        mathBlockSyntax(),
        tableOfContentsSyntax(),
        footnoteDefinitionSyntax()
    ] });
    const tokens = parser.lexer(markdown);

    /**
     * 元のソース位置を追いながら入れ子のブロックを走査し、描画時と同じ見出しIDに対応する行を返す。
     * @param blocks 現在の階層にあるMarkedトークン。
     * @param source トークンのraw/textを照合する元Markdown。
     * @param firstLine この階層の先頭行番号。
     * @returns targetIdと一致する見出しの行番号。見つからなければundefined。
     */
    const findInTokens = (blocks: Token[], source: string, firstLine: number): number | undefined => {
        let cursor = 0;
        let line = firstLine;
        for (const block of blocks) {
            if (block.type === 'checkbox') continue;
            const offset = source.indexOf(block.raw, cursor);
            if (offset < 0) continue;
            line += countLineBreaks(source.slice(cursor, offset));
            if (block.type === 'heading') {
                const id = nextHeadingAnchorId((block.tokens ?? []).map((token) => token.raw).join(''), counts, usedIds);
                if (id === targetId) return line;
            } else if (block.type === 'blockquote') {
                const nestedLine = findInTokens(block.tokens ?? [], block.text, line);
                if (nestedLine !== undefined) return nestedLine;
            } else if (block.type === 'list') {
                const nestedLine = findInTokens(block.items, block.raw, line);
                if (nestedLine !== undefined) return nestedLine;
            } else if (block.type === 'list_item') {
                const nestedLine = findInTokens(block.tokens ?? [], block.text, line);
                if (nestedLine !== undefined) return nestedLine;
            }
            cursor = offset + block.raw.length;
            line += countLineBreaks(block.raw);
        }
        return undefined;
    };

    return findInTokens(tokens, markdown, 1);
}

/**
 * Markdown、Textile、Markdown優先の混在文書から、描画と共通のIDを持つ見出し一覧を作る。
 * @param source - 見出し位置を保ったまま解析する文書本文。
 * @param format - Markdown専用、Textile専用、またはMarkdown優先の混在描画形式。
 * @returns 文書順のアウトライン見出し一覧。コードブロック内のTextile見出しは含まない。
 */
export function getOutlineForFormatSource(
    source: string,
    format: 'markdown' | 'mixed' | 'textile'
): OutlineItem[] {
    if (format === 'markdown') return getOutline(source);
    if (format === 'mixed' && !/^h[1-6]\.\s/m.test(source)) return getOutline(source);
    const candidates = format === 'mixed'
        ? [...getOutline(source), ...getTextileAnchorHeadings(source, true)]
        : getTextileAnchorHeadings(source, false);
    const counts = new Map<string, number>();
    const usedIds = new Set<string>();
    return candidates
        .sort(
            /**
             * 異なる記法の見出し候補を原文順へ並べる。
             * @param left - 左側の見出し候補。
             * @param right - 右側の見出し候補。
             * @returns UTF-16オフセットの昇順を示す比較値。
             */
            (left, right) => left.offset - right.offset
        )
        .map(
            /**
             * 見出し記法を取り除き、文書内で一意な描画アンカーを割り当てる。
             * @param item - MarkdownまたはTextileの見出し候補。
             * @returns 表示文字列と描画IDを確定した見出し項目。
             */
            (item) => {
                const rawLine = source.slice(item.offset).split(/\r\n|\r|\n/, 1)[0] ?? '';
                const markdownHeading = /^#{1,6}\s+(.+?)\s*$/.exec(rawLine);
                const textileHeading = /^h[1-6]\.\s+(.+?)\s*$/.exec(rawLine);
                const rawHeading = textileHeading
                    ? stripTextileAnchorHeadingMarkup(textileHeading[1])
                    : markdownHeading?.[1] ?? item.text;
                return {
                    ...item,
                    id: nextHeadingAnchorId(rawHeading, counts, usedIds)
                };
            }
        );
}

/**
 * Textile見出しを原文上の行・UTF-16オフセットとともに収集する。
 * 混在MarkdownではMarkdownフェンス内を除外し、Textileコードブロックも常に除外する。
 * @param source - Textileまたは混在Markdownの文書本文。
 * @param skipMarkdownFences - trueの場合、Markdownフェンスの範囲を見出し探索から除外する。
 * @returns Textile見出しのレベル、本文、行番号、ソースオフセット。
 */
function getTextileAnchorHeadings(
    source: string,
    skipMarkdownFences: boolean
): Array<Pick<OutlineItem, 'level' | 'line' | 'offset' | 'text'>> {
    const headings: Array<Pick<OutlineItem, 'level' | 'line' | 'offset' | 'text'>> = [];
    let offset = 0;
    let lineNumber = 1;
    let fenceCharacter: string | undefined;
    let fenceLength = 0;
    let inTextileCode = false;
    for (const rawLine of source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []) {
        if (!rawLine) break;
        const line = rawLine.replace(/(?:\r\n|\r|\n)$/, '');
        const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (skipMarkdownFences && fence) {
            const marker = fence[1][0];
            if (!fenceCharacter) {
                fenceCharacter = marker;
                fenceLength = fence[1].length;
            } else if (marker === fenceCharacter && fence[1].length >= fenceLength) {
                fenceCharacter = undefined;
                fenceLength = 0;
            }
            offset += rawLine.length;
            lineNumber += 1;
            continue;
        }
        if (fenceCharacter || inTextileCode) {
            if (!line.trim()) inTextileCode = false;
            offset += rawLine.length;
            lineNumber += 1;
            continue;
        }
        if (/^(?:bc|pre)\.\s/.test(line)) {
            inTextileCode = true;
            offset += rawLine.length;
            lineNumber += 1;
            continue;
        }
        const heading = /^h([1-6])\.\s+(.+?)\s*$/.exec(line);
        if (heading) {
            headings.push({
                level: Number(heading[1]),
                text: stripTextileAnchorHeadingMarkup(heading[2]),
                line: lineNumber,
                offset
            });
        }
        offset += rawLine.length;
        lineNumber += 1;
    }
    return headings;
}

/**
 * Textileのリンク・画像・装飾記法を見出しスラッグ用の可視テキストへ整える。
 * @param source - Textile見出し本文。
 * @returns Textile記号を除いた見出し本文。
 */
function stripTextileAnchorHeadingMarkup(source: string): string {
    return source
        .replace(/"([^"\r\n]+)":\S+/g, '$1')
        .replace(/!([^!\r\n(]+)\(([^)]*)\)!/g, '$2')
        .replace(/!([^!\r\n]+)!/g, '')
        .replace(/@([^@\r\n]+)@/g, '$1')
        .replace(/\*\*?([^*\r\n]+)\*\*?/g, '$1')
        .replace(/__?([^_\r\n]+)__?/g, '$1')
        .replace(/\+\+?([^+\r\n]+)\+\+?/g, '$1')
        .replace(/--?([^- \r\n][^- \r\n]*?)--?/g, '$1')
        .replace(/\?\?([^?\r\n]+)\?\?/g, '$1')
        .replace(/<\/?[^>]+>/g, '')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .trim();
}

/**
 * 指定オフセットが属する行の開始位置を返す。
 * @param source - 行境界を調べるMarkdown本文。
 * @param offset - 行境界を調べる本文内UTF-16オフセット。
 * @returns 行頭のUTF-16オフセット。
 */
function lineStart(source: string, offset: number): number {
    // 指定位置を含む行の開始オフセットを返す。
    return source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

/**
 * 指定オフセットが属する行の終端位置を返す。
 * @param source - 行境界を調べるMarkdown本文。
 * @param offset - 行境界を調べる本文内UTF-16オフセット。
 * @returns 行末のUTF-16オフセット。
 */
function lineEnd(source: string, offset: number): number {
    // 指定位置を含む行の終端オフセットを返す。
    const end = source.indexOf('\n', offset);
    return end < 0 ? source.length : end;
}
