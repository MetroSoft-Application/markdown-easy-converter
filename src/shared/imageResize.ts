/**
 * @fileoverview プレビュー倍率を除いた論理幅を計算し、画像の表示幅とMarkdownへ保存する幅を分離する。
 */
/**
 * 画像リンクの元表記と解決後の参照先を結び付けます。
 */
interface ImageReference {

    /**
     * メッセージ、項目、または処理の種類を識別する値。
     */
    kind: 'markdown' | 'html';

    /**
     * 画像参照記法の開始位置を示す本文内UTF-16オフセットです。
     */
    start: number;

    /**
     * 画像参照記法の終了位置を示す本文内UTF-16オフセットです。
     */
    end: number;

    /**
     * imageresizeで扱うaltの文字列。
     */
    alt: string;

    /**
     * Markdown画像のalt文字列が始まる本文内UTF-16オフセットです。
     */
    altStart?: number;

    /**
     * Markdown画像のalt文字列が終わる本文内UTF-16オフセットです。
     */
    altEnd?: number;

    /**
     * Alt文字列を参照ラベルとして使うshortcut reference画像かを示す。
     */
    shortcutReference?: boolean;

    /**
     * 解析・描画・変換の起点となる本文。
     */
    source: string;

    /**
     * 画面や出力に表示するタイトル。
     */
    title?: string;
}

interface HtmlAttributeReference {
    name: string;
    start: number;
    nameStart: number;
    nameEnd: number;
    end: number;
    hasEquals: boolean;
    valueStart?: number;
    valueEnd?: number;
    quote?: '"' | "'";
}

/**
 * imageresizeで扱う値の種類と境界を表す型。
 */
export type ImageAlignment = 'left' | 'center' | 'right';

/**
 * Markdown本文内の画像参照と、ソース順インデックスを表す値。
 */
export interface MarkdownImageReference {
    index: number;
    start: number;
    end: number;
    source: string;
    alt: string;
    kind: 'markdown' | 'html';
    insideNonRenderedMarkup: boolean;
    altStart?: number;
    altEnd?: number;
    shortcutReference?: boolean;
}

/**
 * Markdownパーサーが返すinlineトークンのソース行範囲。
 */
export interface MarkdownInlineBlockRange {
    startLine: number;
    endLine: number;
}

/**
 * Marpのリサイズ要求で使用する画像ソース範囲。
 */
export interface MarpImageResizeTarget {
    start: number;
    end: number;
    kind: 'markdown' | 'html';
    altStart?: number;
    altEnd?: number;
    shortcutReference?: boolean;
}

/**
 * 画像保存幅の下限。
 */
const MIN_IMAGE_WIDTH = 48;

const RAW_HTML_BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption',
    'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt',
    'fieldset', 'figcaption', 'figure', 'footer', 'frame', 'frameset', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'legend', 'li', 'link', 'main',
    'menu', 'menuitem', 'meta', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p',
    'param', 'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
    'thead', 'tr', 'track', 'ul'
]);
const HTML_CONTEXT_TAGS = new Set([
    'pre', 'script', 'style', 'textarea', 'title', 'iframe', 'object', 'form', 'template', 'noscript'
]);

/**
 * Markdown本文内の画像参照を、保存処理と同じソース順で返す。
 * @param markdown - 画像参照を列挙するMarkdown本文。
 * @param inlineBlockRanges - パーサーが返したinline tokenの行範囲。
 * @returns ソース順インデックス、参照先、本文内範囲を持つ画像一覧。
 */
export function getMarkdownImageReferences(
    markdown: string,
    inlineBlockRanges?: readonly MarkdownInlineBlockRange[],
): MarkdownImageReference[] {
    const maskedSource = maskCode(markdown, inlineBlockRanges);
    const imageReferences = scanImageReferences(markdown, inlineBlockRanges);
    const markupRanges: Array<{ start: number; end: number }> = [];
    const sourceWithoutComments = maskedSource.split('');
    const htmlTagRanges = findHtmlTagRanges(maskedSource);
    const markdownTargetRanges = collectMarkdownLinkTargetRanges(maskedSource, imageReferences);
    let commentStart = maskedSource.indexOf('<!--');
    while (commentStart >= 0) {
        if (
            htmlTagRanges.some((range) => commentStart >= range.start && commentStart < range.end) ||
            markdownTargetRanges.some((range) => commentStart >= range.start && commentStart < range.end)
        ) {
            commentStart = maskedSource.indexOf('<!--', commentStart + 4);
            continue;
        }
        const closingComment = maskedSource.indexOf('-->', commentStart + 4);
        const end = closingComment < 0 ? maskedSource.length : closingComment + 3;
        const start = commentStart;
        markupRanges.push({ start, end });
        for (let index = start; index < end; index += 1) {
            sourceWithoutComments[index] = ' ';
        }
        if (closingComment < 0) break;
        commentStart = maskedSource.indexOf('<!--', end);
    }
    const sourceWithoutCommentsText = sourceWithoutComments.join('');
    const rawHtmlBlockRanges = [
        ...collectRawHtmlBlockRanges(sourceWithoutCommentsText),
        ...collectPreHtmlBlockRanges(sourceWithoutCommentsText)
    ];
    const nonRenderedElementPattern = /<(script|style|textarea|title|iframe|object|form|template|noscript)\b[^>]*>(?:[\s\S]*?<\/\1\s*>|[\s\S]*$)/gi;
    for (const match of sourceWithoutCommentsText.matchAll(nonRenderedElementPattern)) {
        const start = match.index ?? 0;
        markupRanges.push({ start, end: start + match[0].length });
    }
    return imageReferences.map((image, index) => ({
        index,
        start: image.start,
        end: image.end,
        source: image.source,
        alt: image.alt,
        kind: image.kind,
        altStart: image.altStart,
        altEnd: image.altEnd,
        shortcutReference: image.shortcutReference,
        insideNonRenderedMarkup: markupRanges.some(
            (range) => image.start >= range.start && image.start < range.end
        ) || (image.kind === 'markdown' && rawHtmlBlockRanges.some(
            (range) => image.start >= range.start && image.start < range.end
        )
        )
    }));
}

/**
 * インラインリンクと参照定義のリンク先範囲を返す。
 * @param source - コードとHTMLタグをマスクしたMarkdown本文。
 * @returns Markdown構文のリンク先範囲。
 */
function collectMarkdownLinkTargetRanges(
    source: string,
    imageReferences: readonly ImageReference[] = [],
): Array<{ start: number; end: number }> {
    const markdownSource = maskHtmlTags(source);
    const ranges: Array<{ start: number; end: number }> = [];
    for (const image of imageReferences) {
        if (image.kind === 'markdown' && image.altStart !== undefined && image.altEnd !== undefined) {
            ranges.push({ start: image.altStart, end: image.altEnd });
        }
    }
    let index = 0;
    while (index < markdownSource.length) {
        const marker = markdownSource.indexOf('[', index);
        if (marker < 0) break;
        index = marker + 1;
        if (marker > 0 && source[marker - 1] === '\\') continue;
        const closingBracket = findClosing(markdownSource, marker + 1, ']');
        if (closingBracket < 0) continue;
        if (markdownSource[closingBracket + 1] !== '(') {
            index = closingBracket + 1;
            continue;
        }
        const closingParenthesis = findClosingParenthesis(markdownSource, closingBracket + 2);
        if (closingParenthesis < 0) continue;
        ranges.push({ start: closingBracket + 2, end: closingParenthesis });
        index = closingParenthesis + 1;
    }

    const lines = markdownSource.split(/(\r\n|\r|\n)/);
    let offset = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 2) {
        const line = lines[lineIndex] ?? '';
        const match = /^\s{0,3}\[[^\]]+\]:\s*(.+)$/.exec(line);
        const target = match?.[1];
        if (target) {
            const start = offset + line.indexOf(target);
            ranges.push({ start, end: start + target.length });
        }
        offset += line.length + (lines[lineIndex + 1]?.length ?? 0);
    }
    return ranges;
}

/**
 * Markdown画像のalt範囲を、リンク先と参照定義から特定する。
 * @param source - コードブロックをマスクしたMarkdown本文。
 * @param linkTargetRanges - 走査対象外となるMarkdownリンク先の範囲。
 * @param definitions - 画像参照先を解決するMarkdown参照定義。
 * @returns Markdown画像のalt範囲。
 */
function collectMarkdownImageAltRanges(
    source: string,
    linkTargetRanges: readonly { start: number; end: number }[],
    definitions: ReadonlyMap<string, unknown>,
): Array<{ start: number; end: number }> {
    const markdownSource = maskHtmlTags(source);
    const ranges: Array<{ start: number; end: number }> = [];
    let index = 0;
    while (index < markdownSource.length) {
        const marker = markdownSource.indexOf('![', index);
        if (marker < 0) break;
        index = marker + 2;
        if (marker > 0 && source[marker - 1] === '\\') continue;
        const containingTarget = linkTargetRanges.find(
            (range) => marker >= range.start && marker < range.end,
        );
        if (containingTarget) {
            index = containingTarget.end;
            continue;
        }
        const closingBracket = findClosing(markdownSource, marker + 2, ']');
        if (closingBracket < 0) continue;
        const alt = source.slice(marker + 2, closingBracket);
        if (markdownSource[closingBracket + 1] === '(') {
            const closingParenthesis = findClosingParenthesis(markdownSource, closingBracket + 2);
            if (closingParenthesis < 0) continue;
            const target = parseMarkdownTarget(source.slice(closingBracket + 2, closingParenthesis));
            if (target.source) ranges.push({ start: marker + 2, end: closingBracket });
            index = closingParenthesis + 1;
            continue;
        }
        if (markdownSource[closingBracket + 1] === '[') {
            const referenceClosingBracket = findClosing(markdownSource, closingBracket + 2, ']');
            if (referenceClosingBracket < 0) continue;
            const label = normalizeReferenceLabel(
                source.slice(closingBracket + 2, referenceClosingBracket) || alt,
            );
            if (definitions.has(label)) ranges.push({ start: marker + 2, end: closingBracket });
            index = referenceClosingBracket + 1;
            continue;
        }
        if (definitions.has(normalizeReferenceLabel(alt))) {
            ranges.push({ start: marker + 2, end: closingBracket });
        }
        index = closingBracket + 1;
    }
    return ranges;
}

/**
 * Markdownブロックの後に続くHTMLブロック開始条件を判定する。
 * @param line - HTMLタグ直前のMarkdown行。
 * @returns 見出しまたは区切りブロックの場合はtrue。
 */
/**
 * Markdownの引用・リスト接頭辞を除いた行本文を返す。
 * @param line - Markdownコンテナ内の行。
 * @returns コンテナ接頭辞を除いた行。
 */
function stripMarkdownContainerPrefixes(line: string): string {
    return line.replace(/^(?:[ \t]{0,3}>[ \t]?|[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+)+/, '');
}

/**
 * Markdown行頭にある blockquote 記号の深さを返す。
 * @param line - Markdownの1行。
 * @returns 行頭に連続するblockquoteの数。
 */
function getMarkdownBlockquoteDepth(line: string): number {
    let remaining = line;
    let depth = 0;
    while (true) {
        const marker = /^[ \t]{0,3}>[ \t]?/.exec(remaining);
        if (!marker) return depth;
        depth += 1;
        remaining = remaining.slice(marker[0].length);
    }
}

/**
 * Markdown行頭のlist item markerの有無を返す。
 * @param line - Markdownの1行。
 * @returns list item markerが行頭にある場合はtrue。
 */
function startsMarkdownListItem(line: string): boolean {
    let remaining = line;
    while (true) {
        const quoteMarker = /^[ \t]{0,3}>[ \t]?/.exec(remaining);
        if (!quoteMarker) break;
        remaining = remaining.slice(quoteMarker[0].length);
    }
    return /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/.test(remaining);
}

function isMarkdownBlockBoundaryLine(line: string, precedingLine: string): boolean {
    const content = stripMarkdownContainerPrefixes(line).trim();
    if (/^#{1,6}(?:[ \t]+|$)/.test(content)) return true;
    if (/^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(content)) return true;
    if (!/^(?:=+|-+)$/.test(content)) return false;

    const previousContent = stripMarkdownContainerPrefixes(precedingLine).trim();
    return previousContent.length > 0 &&
        !/^#{1,6}(?:[ \t]+|$)/.test(previousContent) &&
        !/^(?:=+|-+)$/.test(previousContent) &&
        !/^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(previousContent);
}

/**
 * Markdown表の行をセルごとに分割する。
 * @param line - Markdown表の候補行。
 * @returns エスケープされていないパイプを含む行のセル。該当しない場合はundefined。
 */
function getMarkdownTableCells(line: string): string[] | undefined {
    const unprefixedLine = stripMarkdownContainerPrefixes(line);
    const leadingWhitespace = /^[ \t]*/.exec(unprefixedLine)?.[0] ?? '';
    let indentationColumns = 0;
    for (const character of leadingWhitespace) {
        indentationColumns = character === '\t'
            ? indentationColumns + 4 - indentationColumns % 4
            : indentationColumns + 1;
    }
    if (indentationColumns > 3) return undefined;

    const content = unprefixedLine.trim();
    const cells: string[] = [];
    let cellStart = 0;
    let precedingBackslashes = 0;
    let lastDelimiterIndex = -1;

    for (let index = 0; index < content.length; index += 1) {
        const character = content[index];
        if (character === '|' && precedingBackslashes % 2 === 0) {
            cells.push(content.slice(cellStart, index).trim());
            cellStart = index + 1;
            lastDelimiterIndex = index;
            precedingBackslashes = 0;
        } else if (character === '\\') {
            precedingBackslashes += 1;
        } else {
            precedingBackslashes = 0;
        }
    }
    if (lastDelimiterIndex < 0) return undefined;
    cells.push(content.slice(cellStart).trim());
    if (content.startsWith('|')) cells.shift();
    if (lastDelimiterIndex === content.length - 1) cells.pop();
    return cells.length > 0 ? cells : undefined;
}

/**
 * Markdown table行内で、セルを分けるパイプの行内オフセットを返す。
 * @param line - Markdown tableの行。
 * @returns エスケープされていないセル区切りのオフセット一覧。
 */
function getMarkdownTableDelimiterOffsets(line: string): number[] {
    const unprefixedLine = stripMarkdownContainerPrefixes(line);
    const leadingWhitespace = /^[ \t]*/.exec(unprefixedLine)?.[0] ?? '';
    const content = unprefixedLine.trim();
    const contentOffset = line.length - unprefixedLine.length + leadingWhitespace.length;
    const offsets: number[] = [];
    let precedingBackslashes = 0;

    for (let index = 0; index < content.length; index += 1) {
        const character = content[index];
        if (character === '|' && precedingBackslashes % 2 === 0) {
            offsets.push(contentOffset + index);
            precedingBackslashes = 0;
        } else if (character === '\\') {
            precedingBackslashes += 1;
        } else {
            precedingBackslashes = 0;
        }
    }

    return offsets;
}

/**
 * Markdown表の区切り行かを判定する。
 * @param line - Markdown表の候補行。
 * @returns 全セルが列区切り記法ならtrue。
 */
function isMarkdownTableSeparatorRow(line: string): boolean {
    const cells = getMarkdownTableCells(line);
    return cells !== undefined && cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/**
 * Markdown本文でHTMLブロックとして解釈される範囲を収集する。
 * @param source - コメントとコード領域を除いたMarkdown本文。
 * @returns 空行までのHTMLブロック範囲。
 */
function collectRawHtmlBlockRanges(source: string): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    const lines = source.split(/(\r\n|\r|\n)/);
    const startPattern = /^[ \t]{0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+)*[ \t]{0,3}<([a-z][a-z0-9-]*)\b/i;
    let offset = 0;
    let blockStart: number | undefined;
    let markdownTableActive = false;
    let previousLineWasTableRow = false;

    for (let index = 0; index < lines.length; index += 2) {
        const line = lines[index] ?? '';
        const lineEnding = lines[index + 1] ?? '';
        const isBlankLine = /^[ \t]*$/.test(line);
        if (isBlankLine) {
            markdownTableActive = false;
            previousLineWasTableRow = false;
        }
        const currentLineCells = getMarkdownTableCells(line);
        const tableSeparatorCells = getMarkdownTableCells(lines[index + 2] ?? '');
        if (
            currentLineCells !== undefined &&
            tableSeparatorCells?.length === currentLineCells.length &&
            isMarkdownTableSeparatorRow(lines[index + 2] ?? '')
        ) {
            markdownTableActive = true;
        }
        const isCurrentTableRow = markdownTableActive && currentLineCells !== undefined;
        if (blockStart !== undefined && isBlankLine) {
            ranges.push({ start: blockStart, end: offset });
            blockStart = undefined;
        }
        if (blockStart === undefined) {
            const match = startPattern.exec(line);
            if (match && RAW_HTML_BLOCK_TAGS.has(match[1].toLowerCase())) {
                blockStart = offset;
            } else {
                const standaloneTag = isStandaloneHtmlTag(line);
                const previousLine = lines[index - 2] ?? '';
                const followsBlockBoundary = index === 0 ||
                    /^[ \t]*$/.test(previousLine) ||
                    previousLineWasTableRow ||
                    isMarkdownBlockBoundaryLine(previousLine, lines[index - 4] ?? '');
                const tagName = standaloneTag
                    ? /^<\/?([a-z][a-z0-9:-]*)\b/i.exec(standaloneTag)?.[1]?.toLowerCase()
                    : undefined;
                if (
                    followsBlockBoundary &&
                    tagName &&
                    !RAW_HTML_BLOCK_TAGS.has(tagName) &&
                    !['pre', 'script', 'style'].includes(tagName)
                ) {
                    blockStart = offset;
                }
            }
        }
        if (markdownTableActive && !isCurrentTableRow) markdownTableActive = false;
        previousLineWasTableRow = isCurrentTableRow;
        offset += line.length + lineEnding.length;
    }

    if (blockStart !== undefined) ranges.push({ start: blockStart, end: source.length });
    return ranges;
}

/**
 * 行全体がHTMLの開始タグまたは終了タグかを判定する。
 * @param line - HTMLブロックの開始候補となるMarkdown行。
 * @returns 行全体を占めるHTMLタグ。該当しない場合はundefined。
 */
function isStandaloneHtmlTag(line: string): string | undefined {
    const containerPrefix = /^[ \t]{0,3}(?:(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+)*)/.exec(line)?.[0] ?? '';
    const content = line.slice(containerPrefix.length);
    const ranges = findHtmlTagRanges(content);
    if (ranges.length !== 1) return undefined;
    const [range] = ranges;
    if (!range || content.slice(0, range.start).trim() || content.slice(range.end).trim()) return undefined;
    const tag = content.slice(range.start, range.end);
    return /^<\/?[a-z][a-z0-9:-]*\b/i.test(tag) ? tag : undefined;
}

/**
 * pre要素のHTMLブロック範囲を閉じタグまで収集する。
 * @param source - コメントとコード領域を除いたMarkdown本文。
 * @returns pre開始タグから対応する終了タグまでの範囲。
 */
function collectPreHtmlBlockRanges(source: string): Array<{ start: number; end: number }> {
    const tagRanges = findHtmlTagRanges(source);
    const ranges: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < tagRanges.length; index += 1) {
        const openingRange = tagRanges[index];
        if (!openingRange) continue;
        const openingTag = source.slice(openingRange.start, openingRange.end);
        if (!/^<pre\b/i.test(openingTag)) continue;

        const lineStart = Math.max(
            source.lastIndexOf('\n', openingRange.start - 1),
            source.lastIndexOf('\r', openingRange.start - 1),
        ) + 1;
        const linePrefix = source.slice(lineStart, openingRange.start);
        if (!/^[ \t]{0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+)*[ \t]*$/.test(linePrefix)) continue;

        const closingRange = tagRanges.slice(index + 1).find((range) =>
            /^<\/pre\b/i.test(source.slice(range.start, range.end))
        );
        ranges.push({
            start: openingRange.start,
            end: closingRange?.end ?? source.length
        });
    }
    return ranges;
}

/**
  * Markdown本文内の指定画像へ幅を設定し、ほかの記法を保った本文を返す。
 * @param markdown - サイズ変更する画像参照を含むMarkdown本文。
 * @param imageIndex - 変更する画像参照の0始まりインデックス。
 * @param width - imgのwidth属性へ設定する幅（px）。
  * @returns 対象画像の幅だけを更新したMarkdown本文。
 */
export function resizeImageInMarkdown(markdown: string, imageIndex: number, width: number): string {
    const image = scanImageReferences(markdown)[imageIndex];
    if (!image) return markdown;

    const normalizedWidth = normalizeWidth(width);
    const replacement = image.kind === 'markdown'
        ? buildMarkdownReplacement(image, normalizedWidth)
        : buildHtmlReplacement(markdown.slice(image.start, image.end), normalizedWidth);

    return markdown.slice(0, image.start) + replacement + markdown.slice(image.end);
}

/**
 * Marp画像の幅オプションだけを更新し、ほかのMarpit指定とMarkdown記法を保つ。
 * @param markdown - サイズ変更する画像を含むMarkdown本文。
 * @param imageIndex - 幅を変更する画像参照の0始まりインデックス。
 * @param width - Marpitの幅オプションへ設定するCSSピクセル幅。
 * @param target - 描画時に確定した画像のソース範囲。
 * @returns 対象画像の幅オプションだけを更新したMarkdown本文。
 */
export function resizeMarpImageInMarkdown(
    markdown: string,
    imageIndex: number,
    width: number,
    target?: MarpImageResizeTarget,
): string {
    const image = target
        ? getMarpImageResizeTarget(markdown, target)
        : scanImageReferences(markdown)[imageIndex];
    if (!image) return markdown;

    const normalizedWidth = normalizeWidth(width);
    if (image.kind === 'html') {
        const originalTag = markdown.slice(image.start, image.end);
        const replacement = buildMarpHtmlReplacement(
            originalTag,
            normalizedWidth
        );
        return markdown.slice(0, image.start) + replacement + markdown.slice(image.end);
    }
    if (image.altStart === undefined || image.altEnd === undefined) return markdown;

    const sourceAlt = markdown.slice(image.altStart, image.altEnd);
    const resizedAlt = updateMarpImageWidthOption(sourceAlt, normalizedWidth);
    const replacementAlt = image.shortcutReference
        ? `${resizedAlt}][${sourceAlt}`
        : resizedAlt;
    return markdown.slice(0, image.altStart) + replacementAlt + markdown.slice(image.altEnd);
}

/**
 * 描画時に受け取った画像ソース範囲を、現在のMarkdownと照合する。
 * @param markdown - 変更前のMarkdown本文。
 * @param target - 描画画像に対応するソース範囲。
 * @returns 本文と範囲が一致する画像参照。
 */
function getMarpImageResizeTarget(
    markdown: string,
    target: MarpImageResizeTarget,
): ImageReference | undefined {
    if (
        !Number.isSafeInteger(target.start) ||
        !Number.isSafeInteger(target.end) ||
        target.start < 0 ||
        target.end <= target.start ||
        target.end > markdown.length
    ) {
        return undefined;
    }

    const sourceText = markdown.slice(target.start, target.end);
    if (target.kind === 'html') {
        if (!/^<img\b/i.test(sourceText)) return undefined;
        const source = readHtmlAttribute(sourceText, 'src');
        if (!source) return undefined;
        return {
            kind: 'html',
            start: target.start,
            end: target.end,
            source,
            alt: readHtmlAttribute(sourceText, 'alt') ?? '',
        };
    }

    if (
        target.kind !== 'markdown' ||
        !sourceText.startsWith('![') ||
        !Number.isSafeInteger(target.altStart) ||
        !Number.isSafeInteger(target.altEnd) ||
        (target.altStart ?? -1) < target.start + 2 ||
        (target.altEnd ?? Number.POSITIVE_INFINITY) < (target.altStart ?? 0) ||
        (target.altEnd ?? Number.POSITIVE_INFINITY) > target.end ||
        markdown[target.altEnd ?? -1] !== ']'
    ) {
        return undefined;
    }

    return {
        kind: 'markdown',
        start: target.start,
        end: target.end,
        source: '',
        alt: markdown.slice(target.altStart, target.altEnd),
        altStart: target.altStart,
        altEnd: target.altEnd,
        shortcutReference: target.shortcutReference,
    };
}

/**
  * Markdown本文内の指定画像へ配置属性を設定し、ほかの記法を保った本文を返す。
 * @param markdown - 配置を変更する画像参照を含むMarkdown本文。
 * @param imageIndex - 変更する画像参照の0始まりインデックス。
 * @param alignment - Markdown画像に設定する配置（left、center、right）。
  * @returns 対象画像の配置だけを更新したMarkdown本文。
 */
export function alignImageInMarkdown(markdown: string, imageIndex: number, alignment: ImageAlignment): string {
    const image = scanImageReferences(markdown)[imageIndex];
    if (!image) return markdown;

    const normalizedAlignment = normalizeAlignment(alignment);
    const replacement = image.kind === 'markdown'
        ? buildMarkdownAlignmentReplacement(image, normalizedAlignment)
        : upsertHtmlAttribute(markdown.slice(image.start, image.end), 'align', normalizedAlignment);

    return markdown.slice(0, image.start) + replacement + markdown.slice(image.end);
}

/**
 * imageresizeの状態または本文へ変更を適用し、必要なら以前の状態へ戻す。
 * 指定したHTML画像のwidthとheightを取り除く。
 * @param markdown - サイズをリセットする画像参照を含むMarkdown本文。
 * @param imageIndex - リセットする画像参照の0始まりインデックス。
 * @returns 対象画像のサイズ属性を除いたMarkdown本文。対象がなければ元の本文。
 */
export function resetImageSizeInMarkdown(markdown: string, imageIndex: number): string {
    const image = scanImageReferences(markdown)[imageIndex];
    if (!image || image.kind !== 'html') return markdown;

    const original = markdown.slice(image.start, image.end);
    if (!hasHtmlAttribute(original, 'width')) return markdown;
    const replacement = removeHtmlAttribute(removeHtmlAttribute(original, 'height'), 'width');
    return markdown.slice(0, image.start) + replacement + markdown.slice(image.end);
}

/**
 * 画像幅を最小値以上の整数pxへ丸める。
 * @param width - 画像へ設定するCSS幅候補（px）。

 */
function normalizeWidth(width: number): number {
    return Math.max(MIN_IMAGE_WIDTH, Math.round(Number.isFinite(width) ? width : MIN_IMAGE_WIDTH));
}

/**
 * 画像alt内の既存のMarpit幅指定を置き換えるか、新しい幅指定を末尾へ加える。
 * @param alt - 幅オプションを更新するMarkdown画像のalt文字列。
 * @param width - 設定する幅。
 * @returns 指定幅を含むalt文字列。
 */
function updateMarpImageWidthOption(alt: string, width: number): string {
    const widthOption = /(^|\s)(?:w|width):(?:(?:\d*\.)?\d+(?:%|ch|cm|em|ex|in|mm|pc|pt|px)?|auto)(?=\s|$)/g;
    let replaced = false;
    const updatedAlt = alt.replace(widthOption, (_match, leading: string) => {
        replaced = true;
        return leading + 'w:' + width + 'px';
    });
    if (replaced) return updatedAlt;
    return updatedAlt + (updatedAlt && !/\s$/.test(updatedAlt) ? ' ' : '') + 'w:' + width + 'px';
}

/**
 * 画像配置をleft、center、rightの有効値へ正規化する。
 * @param alignment - 画像に適用する配置値（left/center/right）。
 * @returns left、center、rightのいずれか。
 */
function normalizeAlignment(alignment: ImageAlignment): ImageAlignment {
    return alignment === 'center' || alignment === 'right' ? alignment : 'left';
}

/**
 * Markdownの画像構文とHTML img要素から参照先と本文範囲を収集する。
 * @param markdown - 画像参照を列挙するMarkdown本文。
 * @returns 参照先、画像構文の形式、本文内の範囲を持つ画像参照一覧。
 */
function scanImageReferences(
    markdown: string,
    inlineBlockRanges?: readonly MarkdownInlineBlockRange[],
): ImageReference[] {
    const masked = maskCode(markdown, inlineBlockRanges);
    const markdownMasked = maskHtmlTags(masked);
    const definitions = collectReferenceDefinitions(markdown, masked);
    const references: ImageReference[] = [];

    for (const range of findHtmlTagRanges(masked)) {
        const tag = markdown.slice(range.start, range.end);
        if (!/^<img\b/i.test(tag)) continue;
        const source = readHtmlAttribute(tag, 'src');
        if (!source) continue;
        references.push({
            kind: 'html',
            start: range.start,
            end: range.end,
            source,
            alt: readHtmlAttribute(tag, 'alt') ?? ''
        });
    }

    let index = 0;
    while (index < markdownMasked.length) {
        const marker = markdownMasked.indexOf('![', index);
        if (marker < 0) break;
        index = marker + 2;

        if (marker > 0 && markdown[marker - 1] === '\\') continue;
        const closingBracket = findClosing(markdown, marker + 2, ']');
        if (closingBracket < 0) continue;

        const alt = markdown.slice(marker + 2, closingBracket);
        if (markdown[closingBracket + 1] === '(') {
            const closingParenthesis = findClosingParenthesis(markdown, closingBracket + 2);
            if (closingParenthesis < 0) continue;
            const target = parseMarkdownTarget(markdown.slice(closingBracket + 2, closingParenthesis));
            if (target.source) {
                references.push({
                    kind: 'markdown',
                    start: marker,
                    end: closingParenthesis + 1,
                    alt,
                    altStart: marker + 2,
                    altEnd: closingBracket,
                    source: target.source,
                    title: target.title
                });
            }
            index = closingParenthesis + 1;
            continue;
        }

        let referenceEnd = closingBracket + 1;
        let label = normalizeReferenceLabel(alt);
        let shortcutReference = true;
        if (markdown[closingBracket + 1] === '[') {
            const referenceClosingBracket = findClosing(markdown, closingBracket + 2, ']');
            if (referenceClosingBracket < 0) continue;
            label = normalizeReferenceLabel(markdown.slice(closingBracket + 2, referenceClosingBracket) || alt);
            referenceEnd = referenceClosingBracket + 1;
            shortcutReference = false;
        }
        const definition = definitions.get(label);
        if (definition) {
            references.push({
                kind: 'markdown',
                start: marker,
                end: referenceEnd,
                alt,
                altStart: marker + 2,
                altEnd: closingBracket,
                shortcutReference,
                source: definition.source,
                title: definition.title
            });
        }
        index = referenceEnd;
    }

    return references.sort(
        /**
         * 2つの値を比較して並び順を決める。
         * @param left - 比較対象の左側の値。
         * @param right - 比較対象の右側の値。
         * @returns 2つの要素の順序を示す数値。
         */
        (left, right) => left.start - right.start);
}

/**
 * パーサーのinline token行範囲を元Markdownのオフセットへ変換する。
 * @param source - 元Markdown本文。
 * @param lines - 本文を行と改行へ分割した配列。
 * @param inlineBlockRanges - パーサーが返したinline tokenの行範囲。
 * @returns バッククォート対応付けを分割するソースオフセット。
 */
function getMarkdownInlineBlockBoundaries(
    source: string,
    lines: string[],
    inlineBlockRanges?: readonly MarkdownInlineBlockRange[],
): Set<number> {
    const lineStarts: number[] = [];
    let offset = 0;
    for (let index = 0; index < lines.length; index += 2) {
        lineStarts.push(offset);
        offset += (lines[index] ?? '').length + (lines[index + 1] ?? '').length;
    }

    const boundaries = new Set<number>();
    if (!inlineBlockRanges) return boundaries;
    for (const range of inlineBlockRanges) {
        boundaries.add(lineStarts[range.startLine] ?? source.length);
        boundaries.add(lineStarts[range.endLine] ?? source.length);
    }
    return boundaries;
}

/**
 * コード領域を空白化し、画像構文の誤検出を防ぐ走査用本文を返す。
 * @param source - コード範囲を空白化するMarkdown本文。
 * @param inlineBlockRanges - パーサーが返したinline tokenの行範囲。
 * @returns コード範囲を空白に置き換えた本文。
 */
function maskCode(
    source: string,
    inlineBlockRanges?: readonly MarkdownInlineBlockRange[],
): string {
    const chars = source.split('');
    const lines = source.split(/(\r\n|\r|\n)/);
    let offset = 0;
    let fence: string | undefined;
    let fenceLength = 0;
    let inIndentedCode = false;
    let markdownTableActive = false;
    let previousLineWasTableRow = false;
    let previousLine = '';
    let htmlContext: HtmlMaskState = { inComment: false };
    let inRawHtmlBlock = false;
    const inlineBlockBoundaries = getMarkdownInlineBlockBoundaries(source, lines, inlineBlockRanges);
    const rawHtmlBlockStartPattern = /^[ \t]{0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+)*[ \t]{0,3}<([a-z][a-z0-9-]*)\b/i;

    for (let index = 0; index < lines.length; index += 2) {
        const line = lines[index] ?? '';
        const lineEnding = lines[index + 1] ?? '';
        const lineStart = offset;
        const lineEnd = offset + line.length + lineEnding.length;
        const precedingLineWasTableRow = previousLineWasTableRow;
        const containerContent = stripMarkdownContainerPrefixes(line);
        const marker = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(containerContent);
        const isBlankLine = /^[ \t]*$/.test(containerContent);
        if (inlineBlockRanges === undefined) {
            const boundaryLine = isMarkdownBlockBoundaryLine(line, previousLine);
            const currentBoundaryContent = stripMarkdownContainerPrefixes(line).trim();
            const precedingBoundaryContent = stripMarkdownContainerPrefixes(previousLine).trim();
            const isSetextUnderline = /^(?:=+|-+)$/.test(currentBoundaryContent) &&
                precedingBoundaryContent.length > 0 &&
                !/^#{1,6}(?:[ \t]+|$)/.test(precedingBoundaryContent) &&
                !/^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(precedingBoundaryContent);
            if (isBlankLine) {
                inlineBlockBoundaries.add(lineStart);
                inlineBlockBoundaries.add(lineEnd);
            } else if (boundaryLine) {
                if (isSetextUnderline) {
                    let headingStartOffset = lineStart - (lines[index - 1]?.length ?? 0) - previousLine.length;
                    let candidateStartOffset = headingStartOffset;
                    let nextLineForHeading = line;
                    for (let candidateIndex = index - 2; candidateIndex >= 0; candidateIndex -= 2) {
                        const candidateLine = lines[candidateIndex] ?? '';
                        const candidateContent = stripMarkdownContainerPrefixes(candidateLine).trim();
                        const candidatePreviousLine = lines[candidateIndex - 2] ?? '';
                        if (!candidateContent) break;
                        if (
                            candidateIndex !== index - 2 &&
                            isMarkdownBlockBoundaryLine(candidateLine, candidatePreviousLine)
                        ) {
                            break;
                        }
                        if (
                            getMarkdownBlockquoteDepth(candidateLine) !==
                            getMarkdownBlockquoteDepth(nextLineForHeading)
                        ) {
                            break;
                        }
                        headingStartOffset = candidateStartOffset;
                        if (startsMarkdownListItem(candidateLine)) break;
                        nextLineForHeading = candidateLine;
                        candidateStartOffset -= (lines[candidateIndex - 1]?.length ?? 0) + candidateLine.length;
                    }
                    inlineBlockBoundaries.add(headingStartOffset);
                    inlineBlockBoundaries.add(lineEnd);
                } else {
                    inlineBlockBoundaries.add(lineStart);
                    inlineBlockBoundaries.add(lineEnd);
                }
            }
            if (getMarkdownBlockquoteDepth(line) !== getMarkdownBlockquoteDepth(previousLine)) {
                inlineBlockBoundaries.add(lineStart);
            }
        }
        if (inRawHtmlBlock && isBlankLine) inRawHtmlBlock = false;
        const rawHtmlBlockTag = rawHtmlBlockStartPattern.exec(line)?.[1]?.toLowerCase();
        const startsRawHtmlBlock = rawHtmlBlockTag !== undefined &&
            RAW_HTML_BLOCK_TAGS.has(rawHtmlBlockTag);
        const startsHtmlContextElement = findHtmlTagRanges(line).some((range) => {
            const tag = line.slice(range.start, range.end);
            const tagName = /^<\s*([a-z][a-z0-9-]*)\b/i.exec(tag)?.[1]?.toLowerCase();
            return Boolean(
                tagName &&
                HTML_CONTEXT_TAGS.has(tagName) &&
                !/^<\s*\//.test(tag) &&
                !/\/\s*>$/.test(tag),
            );
        });
        const allowHtmlCommentStart = inRawHtmlBlock ||
            startsRawHtmlBlock ||
            /^[ \t]{0,3}<!--/.test(containerContent);
        const isHtmlContextLine = htmlContext.inComment ||
            htmlContext.openElement !== undefined ||
            inRawHtmlBlock;
        const isInsideHtmlContextElement = htmlContext.openElement !== undefined;
        let lineContainsMarkdownCode = false;
        if (fence) {
            const closesFence = marker !== null &&
                marker[1][0] === fence &&
                marker[1].length >= fenceLength &&
                /^[ \t]*$/.test(marker[2] ?? '');
            if (closesFence) {
                fence = undefined;
                fenceLength = 0;
            }
            markdownTableActive = false;
            previousLineWasTableRow = false;
            lineContainsMarkdownCode = true;
            for (let charIndex = 0; charIndex < line.length; charIndex += 1) chars[offset + charIndex] = ' ';
        } else if (isHtmlContextLine) {
            htmlContext = advanceHtmlMaskState(line, htmlContext, allowHtmlCommentStart);
            inIndentedCode = false;
            markdownTableActive = false;
            previousLineWasTableRow = false;
        } else if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
            fence = marker[1][0];
            fenceLength = marker[1].length;
            inIndentedCode = false;
            markdownTableActive = false;
            previousLineWasTableRow = false;
            lineContainsMarkdownCode = true;
            for (let charIndex = 0; charIndex < line.length; charIndex += 1) chars[offset + charIndex] = ' ';
        } else {
            if (isBlankLine) {
                markdownTableActive = false;
                previousLineWasTableRow = false;
            }
            const cells = getMarkdownTableCells(line);
            const separatorCells = getMarkdownTableCells(lines[index + 2] ?? '');
            if (
                cells !== undefined &&
                separatorCells !== undefined &&
                cells.length === separatorCells.length &&
                isMarkdownTableSeparatorRow(lines[index + 2] ?? '')
            ) {
                markdownTableActive = true;
            }
            const isCurrentTableRow = markdownTableActive && cells !== undefined;
            if (isCurrentTableRow) {
                inlineBlockBoundaries.add(lineStart);
                inlineBlockBoundaries.add(lineEnd);
                for (const delimiterOffset of getMarkdownTableDelimiterOffsets(line)) {
                    inlineBlockBoundaries.add(lineStart + delimiterOffset);
                    inlineBlockBoundaries.add(lineStart + delimiterOffset + 1);
                }
            }
            const leadingWhitespace = /^[ \t]*/.exec(containerContent)?.[0] ?? '';
            let indentationColumns = 0;
            for (const character of leadingWhitespace) {
                indentationColumns = character === '\t'
                    ? indentationColumns + 4 - indentationColumns % 4
                    : indentationColumns + 1;
            }
            const isIndentedLine = indentationColumns >= 4;
            if (inIndentedCode && (isBlankLine || isIndentedLine)) {
                lineContainsMarkdownCode = true;
                for (let charIndex = 0; charIndex < line.length; charIndex += 1) chars[offset + charIndex] = ' ';
            } else {
                inIndentedCode = false;
                const previousLineContent = stripMarkdownContainerPrefixes(previousLine);
                const precedesBlock = index === 0 ||
                    /^[ \t]*$/.test(previousLineContent) ||
                    previousLineWasTableRow ||
                    isMarkdownBlockBoundaryLine(previousLine, lines[index - 4] ?? '');
                if (isIndentedLine && precedesBlock) {
                    inIndentedCode = true;
                    lineContainsMarkdownCode = true;
                    for (let charIndex = 0; charIndex < line.length; charIndex += 1) chars[offset + charIndex] = ' ';
                }
            }
            if (markdownTableActive && !isCurrentTableRow) markdownTableActive = false;
            previousLineWasTableRow = isCurrentTableRow;
        }
        if (
            inlineBlockRanges === undefined &&
            startsMarkdownListItem(line) &&
            !lineContainsMarkdownCode
        ) {
            inlineBlockBoundaries.add(lineStart);
        }
        if (
            lineContainsMarkdownCode ||
            isInsideHtmlContextElement ||
            startsHtmlContextElement ||
            startsRawHtmlBlock ||
            inRawHtmlBlock
        ) {
            inlineBlockBoundaries.add(lineStart);
            inlineBlockBoundaries.add(lineEnd);
        }
        if (!fence && !isHtmlContextLine && !lineContainsMarkdownCode) {
            htmlContext = advanceHtmlMaskState(line, htmlContext, allowHtmlCommentStart);
            if (startsRawHtmlBlock) {
                inRawHtmlBlock = true;
            } else {
                const standaloneTag = isStandaloneHtmlTag(line);
                const previousLineForHtml = lines[index - 2] ?? '';
                const followsBlockBoundary = index === 0 ||
                    /^[ \t]*$/.test(previousLineForHtml) ||
                    precedingLineWasTableRow ||
                    isMarkdownBlockBoundaryLine(previousLineForHtml, lines[index - 4] ?? '');
                const standaloneTagName = standaloneTag
                    ? /^<\/?([a-z][a-z0-9:-]*)\b/i.exec(standaloneTag)?.[1]?.toLowerCase()
                    : undefined;
                if (
                    followsBlockBoundary &&
                    standaloneTagName &&
                    !RAW_HTML_BLOCK_TAGS.has(standaloneTagName) &&
                    !['pre', 'script', 'style'].includes(standaloneTagName)
                ) {
                    inRawHtmlBlock = true;
                }
            }
        }
        offset += line.length + lineEnding.length;
        previousLine = line;
    }

    if (!chars.includes('`')) return chars.join('');
    const inlineSource = chars.join('');
    const inlineChars = maskHtmlTags(inlineSource).split('');
    const maskInlineRange = (start: number, end: number): void => {
        for (let maskIndex = start; maskIndex < end; maskIndex += 1) {
            if (inlineChars[maskIndex] !== '\n' && inlineChars[maskIndex] !== '\r') inlineChars[maskIndex] = ' ';
        }
    };
    const markdownLinkTargetRanges = collectMarkdownLinkTargetRanges(inlineSource);
    const markdownDefinitions = collectReferenceDefinitions(source, inlineSource);
    const markdownImageAltRanges = collectMarkdownImageAltRanges(
        inlineSource,
        markdownLinkTargetRanges,
        markdownDefinitions,
    );
    const nonCommentMarkupRanges = [
        ...findHtmlTagRanges(inlineSource),
        ...markdownLinkTargetRanges,
        ...markdownImageAltRanges,
    ];
    for (const range of [
        ...collectRawHtmlBlockRanges(inlineSource),
        ...collectPreHtmlBlockRanges(inlineSource)
    ]) {
        maskInlineRange(range.start, range.end);
    }
    for (const match of inlineSource.matchAll(/<(script|style|textarea|title|iframe|object|form|template|noscript)\b[^>]*>(?:[\s\S]*?<\/\1\s*>|[\s\S]*$)/gi)) {
        const start = match.index ?? 0;
        maskInlineRange(start, start + match[0].length);
    }
    const backtickRuns: Array<{ start: number; end: number; escaped: boolean; block: number }> = [];
    const orderedInlineBlockBoundaries = [...inlineBlockBoundaries].sort((left, right) => left - right);
    let boundaryIndex = 0;
    let inlineBlockIndex = 0;
    let scanIndex = 0;
    while (scanIndex < inlineChars.length) {
        while (
            (orderedInlineBlockBoundaries[boundaryIndex] ?? Number.POSITIVE_INFINITY) <= scanIndex
        ) {
            inlineBlockIndex += 1;
            boundaryIndex += 1;
        }
        if (inlineChars[scanIndex] !== '`') {
            scanIndex += 1;
            continue;
        }
        const start = scanIndex;
        while (inlineChars[scanIndex] === '`') scanIndex += 1;
        let precedingBackslashes = 0;
        for (let previousIndex = start - 1; previousIndex >= 0 && inlineChars[previousIndex] === '\\'; previousIndex -= 1) {
            precedingBackslashes += 1;
        }
        backtickRuns.push({
            start,
            end: scanIndex,
            escaped: precedingBackslashes % 2 === 1,
            block: inlineBlockIndex,
        });
    }

    const unescapedRunsByLength = new Map<string, Array<{ start: number; end: number; escaped: boolean; block: number }>>();
    for (const run of backtickRuns) {
        if (run.escaped) continue;
        const length = run.end - run.start;
        const key = `${run.block}:${length}`;
        const matchingRuns = unescapedRunsByLength.get(key) ?? [];
        matchingRuns.push(run);
        unescapedRunsByLength.set(key, matchingRuns);
    }
    const commentRanges: Array<{ start: number; end: number; closed: boolean }> = [];
    let commentStart = inlineSource.indexOf('<!--');
    while (commentStart >= 0) {
        if (
            inlineChars[commentStart] !== '<' ||
            nonCommentMarkupRanges.some(
                (range) => commentStart >= range.start && commentStart < range.end,
            )
        ) {
            commentStart = inlineSource.indexOf('<!--', commentStart + 4);
            continue;
        }
        const closingComment = inlineSource.indexOf('-->', commentStart + 4);
        const commentEnd = closingComment < 0 ? inlineSource.length : closingComment + 3;
        commentRanges.push({
            start: commentStart,
            end: commentEnd,
            closed: closingComment >= 0,
        });
        if (closingComment < 0) break;
        commentStart = inlineSource.indexOf('<!--', commentEnd);
    }

    let runIndex = 0;
    let commentIndex = 0;
    let sourceIndex = 0;
    while (runIndex < backtickRuns.length) {
        const run = backtickRuns[runIndex];
        if (!run) break;
        while ((commentRanges[commentIndex]?.end ?? Number.POSITIVE_INFINITY) <= sourceIndex) commentIndex += 1;
        const nextComment = commentRanges[commentIndex];
        if (nextComment && nextComment.start <= run.start) {
            sourceIndex = nextComment.end;
            while ((commentRanges[commentIndex]?.end ?? Number.POSITIVE_INFINITY) <= sourceIndex) commentIndex += 1;
            while ((backtickRuns[runIndex]?.start ?? Number.POSITIVE_INFINITY) < sourceIndex) runIndex += 1;
            continue;
        }
        if (run.start < sourceIndex) {
            runIndex += 1;
            continue;
        }
        if (run.escaped) {
            sourceIndex = run.end;
            runIndex += 1;
            continue;
        }

        const runLength = run.end - run.start;
        const matchingRuns = unescapedRunsByLength.get(`${run.block}:${runLength}`) ?? [];
        let lower = 0;
        let upper = matchingRuns.length;
        while (lower < upper) {
            const middle = Math.floor((lower + upper) / 2);
            if ((matchingRuns[middle]?.start ?? Number.POSITIVE_INFINITY) <= run.start) lower = middle + 1;
            else upper = middle;
        }
        let closingRun: (typeof matchingRuns)[number] | undefined = matchingRuns[lower];
        if (!closingRun) {
            sourceIndex = run.end;
            runIndex += 1;
            continue;
        }
        for (let maskIndex = run.start; maskIndex < closingRun.end; maskIndex += 1) {
            if (chars[maskIndex] !== '\n' && chars[maskIndex] !== '\r') chars[maskIndex] = ' ';
        }
        sourceIndex = closingRun.end;
        while ((commentRanges[commentIndex]?.start ?? Number.POSITIVE_INFINITY) < sourceIndex) commentIndex += 1;
        while ((backtickRuns[runIndex]?.start ?? Number.POSITIVE_INFINITY) < sourceIndex) runIndex += 1;
    }

    return chars.join('');
}

interface HtmlMaskState {
    inComment: boolean;
    openElement?: string;
}

/**
 * 1行分のHTMLコメントまたは非描画要素の状態を更新する。
 * @param line - 状態を更新するMarkdown行。
 * @param initialState - 行の開始時点で有効なHTML状態。
 * @returns 行末時点で有効なHTML状態。
 */
function advanceHtmlMaskState(
    line: string,
    initialState: HtmlMaskState,
    allowCommentStart: boolean,
): HtmlMaskState {
    let inComment = initialState.inComment;
    let openElement = initialState.openElement;
    let index = 0;
    const tagRanges = findHtmlTagRanges(line);
    let tagIndex = 0;

    while (index < line.length) {
        while ((tagRanges[tagIndex]?.start ?? Number.POSITIVE_INFINITY) < index) tagIndex += 1;
        if (openElement) {
            let closingTagIndex = tagIndex;
            while (closingTagIndex < tagRanges.length) {
                const range = tagRanges[closingTagIndex];
                if (range && new RegExp(`^<\\s*\\/\\s*${openElement}\\b`, 'i').test(line.slice(range.start, range.end))) {
                    openElement = undefined;
                    index = range.end;
                    tagIndex = closingTagIndex + 1;
                    break;
                }
                closingTagIndex += 1;
            }
            if (openElement) return { inComment: false, openElement };
            continue;
        }

        if (inComment) {
            const closingComment = line.indexOf('-->', index);
            if (closingComment < 0) return { inComment: true };
            index = closingComment + 3;
            inComment = false;
            continue;
        }

        const commentStart = allowCommentStart ? line.indexOf('<!--', index) : -1;
        const nextTag = tagRanges[tagIndex];
        if (commentStart >= 0 && (!nextTag || commentStart <= nextTag.start)) {
            inComment = true;
            index = commentStart + 4;
            continue;
        }
        if (!nextTag) break;
        if (nextTag.start > index) {
            index = nextTag.start;
            continue;
        }

        const tag = line.slice(nextTag.start, nextTag.end);
        const openingTagName = /^<\s*([a-z][a-z0-9-]*)\b/i.exec(tag)?.[1]?.toLowerCase();
        if (
            openingTagName &&
            HTML_CONTEXT_TAGS.has(openingTagName) &&
            !/^<\s*\//.test(tag) &&
            !/\/\s*>$/.test(tag)
        ) {
            openElement = openingTagName;
        }
        index = nextTag.end;
        tagIndex += 1;
    }

    return openElement ? { inComment, openElement } : { inComment };
}

/**
 * HTMLタグの属性内にあるMarkdown画像風の文字列を走査対象から除く。
 * @param source - コード領域を空白化したMarkdown本文。
 * @returns HTMLタグ範囲を空白に置き換えた本文。
 */
function maskHtmlTags(source: string): string {
    const characters = source.split('');
    for (const range of findHtmlTagRanges(source)) {
        for (let tagIndex = range.start; tagIndex < range.end; tagIndex += 1) {
            characters[tagIndex] = ' ';
        }
    }
    return characters.join('');
}

/**
 * 引用符内の山括弧を考慮してHTMLタグの範囲を列挙する。
 * @param source - HTMLタグを検索する本文。
 * @returns 開始位置と終了位置を持つHTMLタグ範囲。
 */
export function findHtmlTagRanges(source: string): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    let index = 0;
    while (index < source.length) {
        if (source[index] !== '<') {
            index += 1;
            continue;
        }

        let nameStart = index + 1;
        if (source[nameStart] === '/') nameStart += 1;
        if (!/[a-z]/i.test(source[nameStart] ?? '')) {
            index += 1;
            continue;
        }

        let quote: '"' | "'" | undefined;
        let end = nameStart + 1;
        for (; end < source.length; end += 1) {
            const character = source[end];
            if (quote) {
                if (character === quote) quote = undefined;
            } else if (character === '"' || character === "'") {
                quote = character;
            } else if (character === '>') {
                break;
            }
        }
        if (end >= source.length) {
            index += 1;
            continue;
        }
        ranges.push({ start: index, end: end + 1 });
        index = end + 1;
    }
    return ranges;
}

/**
 * コード領域を除いたMarkdownから参照画像定義を集める。
 * @param source - 参照定義の元テキストを切り出すMarkdown本文。
 * @param masked - コード記法をマスクして定義構文を走査する本文。
 * @returns 小文字化した参照ラベルから元URIと表示タイトルを引くMap。
 */
function collectReferenceDefinitions(source: string, masked: string): Map<string, {
    /**
     * 解析・描画・変換の起点となる本文。
     */
    source: string;
    /**
     * 画面や出力に表示するタイトル。
     */
    title?: string
}> {
    const definitions = new Map<string, {
        /**
         * 解析・描画・変換の起点となる本文。
         */
        source: string;
        /**
         * 画面や出力に表示するタイトル。
         */
        title?: string
    }>();
    const lines = masked.split(/(\r\n|\r|\n)/);
    let offset = 0;

    for (let index = 0; index < lines.length; index += 2) {
        const line = lines[index] ?? '';
        const original = source.slice(offset, offset + line.length);
        offset += line.length + (lines[index + 1]?.length ?? 0);
        const match = /^\s{0,3}\[([^\]]+)\]:\s*(.+)$/.exec(line);
        const originalMatch = /^\s{0,3}\[([^\]]+)\]:\s*(.+)$/.exec(original);
        if (!match || !originalMatch) continue;
        const target = parseMarkdownTarget(originalMatch[2]);
        if (target.source) definitions.set(normalizeReferenceLabel(originalMatch[1]), target);
    }

    return definitions;
}

/**
 * Markdown参照ラベルの空白を統一し、小文字へ変換する。
 * @param label - Markdown参照定義との照合に使う参照ラベル。

 */
function normalizeReferenceLabel(label: string): string {
    return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Markdown画像リンクのリンク先と任意titleを解析する。
 * @param target - Markdown参照定義のリンク先と任意titleを含む文字列。
 * @returns 画像のリンク先と、指定されている場合はtitle。
 */
function parseMarkdownTarget(target: string): {
    /**
     * 解析・描画・変換の起点となる本文。
     */
    source: string;
    /**
     * 画面や出力に表示するタイトル。
     */
    title?: string
} {
    const trimmed = target.trim();
    if (!trimmed) return { source: '' };
    if (trimmed.startsWith('<')) {
        const end = trimmed.indexOf('>');
        if (end > 0) return { source: trimmed.slice(1, end), title: parseTitle(trimmed.slice(end + 1).trim()) };
    }
    const match = /^(\S+?)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?$/.exec(trimmed);
    return { source: match?.[1] ?? trimmed, title: match?.[2] ?? match?.[3] ?? match?.[4] };
}

/**
 * Markdown画像タイトルから引用符を外した値を読み取る。
 * @param value - 引用符または括弧で囲まれたMarkdownタイトル文字列。
 * @returns タイトル本文。タイトル構文がない場合はundefined。
 */
function parseTitle(value: string): string | undefined {
    const match = /^(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))$/.exec(value);
    return match?.[1] ?? match?.[2] ?? match?.[3];
}

/**
  * 入れ子や引用符を考慮して、指定位置以降で対応する閉じ括弧を探す。
 * @param source - 対応する閉じ括弧を探索するMarkdown文字列。
 * @param start - 閉じ括弧の探索を始めるUTF-16オフセット。
 * @param closing - 一致させる閉じ括弧文字。
  * @returns 対応する閉じ括弧のUTF-16位置。見つからない場合は-1。
 */
function findClosing(source: string, start: number, closing: string): number {
    for (let index = start; index < source.length; index += 1) {
        if (source[index] === '\\') {
            index += 1;
            continue;
        }
        if (source[index] === closing) return index;
    }
    return -1;
}

/**
  * Markdownリンク先にある入れ子の丸括弧を考慮して、閉じ括弧を探す。
 * @param source - 対応する閉じ括弧を探索するMarkdown文字列。
 * @param start - 閉じ括弧の探索を始めるUTF-16オフセット。
  * @returns 対応する閉じ丸括弧のUTF-16位置。見つからない場合は-1。
 */
function findClosingParenthesis(source: string, start: number): number {
    let depth = 1;
    for (let index = start; index < source.length; index += 1) {
        if (source[index] === '\\') {
            index += 1;
            continue;
        }
        if (source[index] === '(') depth += 1;
        if (source[index] === ')' && --depth === 0) return index;
    }
    return -1;
}

/**
 * Markdown画像参照から指定幅を持つimg要素を生成する。
 * @param image - imgタグへ変換する解析済みMarkdown画像参照。
 * @param width - imgのwidth属性へ設定する画像幅（px）。

 */
function buildMarkdownReplacement(image: ImageReference, width: number): string {
    const attributes = [
        `src="${escapeHtmlAttribute(image.source)}"`,
        `alt="${escapeHtmlAttribute(image.alt)}"`,
        `width="${width}"`
    ];
    if (image.title !== undefined) attributes.push(`title="${escapeHtmlAttribute(image.title)}"`);
    return `<img ${attributes.join(' ')}>`;
}

/**
 * Markdown画像参照から指定配置を持つimg要素を生成する。
 * @param image - imgタグへ変換する解析済みMarkdown画像参照。
 * @param alignment - imgタグへ設定する配置値（left/center/right）。

 */
function buildMarkdownAlignmentReplacement(image: ImageReference, alignment: ImageAlignment): string {
    const attributes = [
        `src="${escapeHtmlAttribute(image.source)}"`,
        `alt="${escapeHtmlAttribute(image.alt)}"`,
        `align="${alignment}"`
    ];
    if (image.title !== undefined) attributes.push(`title="${escapeHtmlAttribute(image.title)}"`);
    return `<img ${attributes.join(' ')}>`;
}

/**
 * img要素のwidth属性を指定幅へ置き換える。
 * @param tag - width属性を書き込むimg HTMLタグ全体。
 * @param width - imgのwidth属性へ設定する画像幅（px）。

 */
function buildHtmlReplacement(tag: string, width: number): string {
    return upsertHtmlAttribute(removeHtmlAttribute(tag, 'height'), 'width', String(width));
}

/**
 * MarpのHTML画像幅を属性と既存のインラインstyleへ反映する。
 * @param tag - 幅を変更するimg HTMLタグ全体。
 * @param width - imgに設定する幅（px）。
 * @returns width属性とインラインstyle幅を更新したタグ。
 */
function buildMarpHtmlReplacement(tag: string, width: number): string {
    const replacement = buildHtmlReplacement(tag, width);
    const style = readHtmlAttribute(tag, 'style');
    if (style === undefined) return replacement;
    return replaceHtmlAttributeRawValue(
        replacement,
        'style',
        upsertCssWidth(style, width)
    );
}

/**
 * CSS宣言内のwidthを置き換え、未指定なら末尾へ追加する。
 * @param style - imgのstyle属性値。
 * @param width - 設定する幅（px）。
 * @returns 幅指定を更新したstyle文字列。
 */
function upsertCssWidth(style: string, width: number): string {
    let foundWidth = false;
    const updatedStyle = style.replace(
        /(^|;)(\s*width\s*:\s*)([^;]*)/gi,
        (_match, separator: string, property: string, existingValue: string) => {
            foundWidth = true;
            const important = /\s*!important\s*$/i.test(existingValue)
                ? ' !important'
                : '';
            return separator + property + width + 'px' + important;
        }
    );
    if (foundWidth) return updatedStyle;

    const trimmedStyle = style.trimEnd();
    const separator = trimmedStyle.length === 0 || trimmedStyle.endsWith(';') ? '' : ';';
    const spacing = separator && !/\s$/.test(style) ? ' ' : '';
    return style + separator + spacing + 'width:' + width + 'px';
}

/**
  * imgタグ内の指定属性を追加または更新し、タグ文字列を返す。
 * @param tag - 属性を書き換えるimg HTMLタグ全体。
 * @param name - 更新するHTML属性名。
 * @param value - HTML属性へ設定する未エスケープの値。
  * @returns 属性値を更新したHTMLタグ。
 */
export function upsertHtmlAttribute(tag: string, name: string, value: string): string {
    const attribute = findHtmlAttribute(tag, name);
    if (attribute) {
        const replacement = attribute.name + `="${escapeHtmlAttribute(value)}"`;
        return tag.slice(0, attribute.nameStart) + replacement + tag.slice(attribute.end);
    }
    const closing = tag.endsWith('/>') ? '/>' : '>';
    return tag.slice(0, -closing.length) + ` ${name}="${escapeHtmlAttribute(value)}"` + closing;
}

/**
 * 既存HTML属性の生値を、元の引用符と文字参照を保ったまま置き換える。
 * @param tag - 属性を書き換えるimg HTMLタグ全体。
 * @param name - 更新するHTML属性名。
 * @param rawValue - 引用符で囲む前の属性値。既存の文字参照を含む。
 * @returns 属性値を置き換えたHTMLタグ。
 */
function replaceHtmlAttributeRawValue(tag: string, name: string, rawValue: string): string {
    const attribute = findHtmlAttribute(tag, name);
    if (!attribute || attribute.valueStart === undefined || attribute.valueEnd === undefined) return tag;
    const replacement = attribute.quote ? rawValue : `"${rawValue}"`;
    return tag.slice(0, attribute.valueStart) + replacement + tag.slice(attribute.valueEnd);
}

/**
 * imageresizeの状態または本文へ変更を適用し、必要なら以前の状態へ戻す。
 * @param tag - 属性を削除するimg HTMLタグ全体。
 * @param name - 削除するHTML属性名。
 * @returns 指定属性を取り除いたHTMLタグ。
 */
export function removeHtmlAttribute(tag: string, name: string): string {
    const attributes = parseHtmlAttributes(tag)
        .filter((attribute) => attribute.name.toLowerCase() === name.toLowerCase())
        .reverse();
    let updatedTag = tag;
    for (const attribute of attributes) {
        updatedTag = updatedTag.slice(0, attribute.start) + updatedTag.slice(attribute.end);
    }
    return updatedTag;
}

/**
 * imageresizeの条件を判定する。
 * @param tag - 属性の有無を検査するimg HTMLタグ全体。
 * @param name - 検査するHTML属性名。
 * @returns 条件が成立したかを示す真偽値。
 */
function hasHtmlAttribute(tag: string, name: string): boolean {
    return findHtmlAttribute(tag, name)?.hasEquals === true;
}

/**
 * HTMLタグから指定属性の値を読み取る。
 * @param tag - 属性値を読み取るimg HTMLタグ全体。
 * @param name - 読み取るHTML属性名。
 * @returns 属性値。指定属性がない場合はundefined。
 */
export function readHtmlAttribute(tag: string, name: string): string | undefined {
    const attribute = findHtmlAttribute(tag, name);
    if (!attribute || attribute.valueStart === undefined || attribute.valueEnd === undefined) return undefined;
    return tag.slice(attribute.valueStart, attribute.valueEnd);
}

/**
 * HTML開始タグの属性範囲を引用符境界に沿って解析する。
 * @param tag - 解析するHTMLタグ全体。
 * @returns 属性名、値、タグ内の各範囲。
 */
function parseHtmlAttributes(tag: string): HtmlAttributeReference[] {
    const tagName = /^<\s*\/?\s*[^\s/>]+/.exec(tag);
    if (!tagName) return [];

    const attributes: HtmlAttributeReference[] = [];
    let index = tagName[0].length;
    while (index < tag.length) {
        const start = index;
        while (index < tag.length && /\s/.test(tag[index] ?? '')) index += 1;
        if (index >= tag.length || tag[index] === '>') break;
        if (tag[index] === '/') {
            index += 1;
            continue;
        }

        const nameStart = index;
        while (index < tag.length && !/[\s=/>]/.test(tag[index] ?? '')) index += 1;
        if (index === nameStart) {
            index += 1;
            continue;
        }
        const nameEnd = index;
        const name = tag.slice(nameStart, nameEnd);
        while (index < tag.length && /\s/.test(tag[index] ?? '')) index += 1;

        let hasEquals = false;
        let valueStart: number | undefined;
        let valueEnd: number | undefined;
        let quote: '"' | "'" | undefined;
        let end = nameEnd;
        if (tag[index] === '=') {
            hasEquals = true;
            index += 1;
            while (index < tag.length && /\s/.test(tag[index] ?? '')) index += 1;
            const quoteCharacter = tag[index];
            if (quoteCharacter === '"' || quoteCharacter === "'") {
                quote = quoteCharacter;
                valueStart = index + 1;
                index = valueStart;
                while (index < tag.length && tag[index] !== quote) index += 1;
                valueEnd = index;
                if (index < tag.length) index += 1;
                end = index;
            } else {
                valueStart = index;
                while (index < tag.length && !/[\s>]/.test(tag[index] ?? '')) index += 1;
                valueEnd = index;
                end = index;
            }
        }

        attributes.push({
            name,
            start,
            nameStart,
            nameEnd,
            end,
            hasEquals,
            valueStart,
            valueEnd,
            quote
        });
    }
    return attributes;
}

/**
 * HTMLタグから指定属性を大小文字を区別せず検索する。
 * @param tag - 検索対象のHTMLタグ全体。
 * @param name - 検索する属性名。
 * @returns 最初に一致した属性。見つからない場合はundefined。
 */
function findHtmlAttribute(tag: string, name: string): HtmlAttributeReference | undefined {
    const normalizedName = name.toLowerCase();
    return parseHtmlAttributes(tag).find(
        (attribute) => attribute.name.toLowerCase() === normalizedName
    );
}

/**
 * HTML属性へ埋め込む文字列の予約文字をエスケープする。
 * @param value - HTML属性値としてエスケープする文字列。

 */
function escapeHtmlAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 正規表現のメタ文字をリテラルとして扱えるようにエスケープする。
 * @param value - 正規表現リテラルとして扱う文字列。

 */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
