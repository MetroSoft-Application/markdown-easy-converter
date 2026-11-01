/**
 * @fileoverview Extension HostとWebviewの描画経路でTextile.jsの呼び出し設定を統一する。
 */
import textile from 'textile-js';

/**
 * Textile本文をローカルのTextile.js実装でHTMLへ変換する。
 * Textile.jsの単一改行は段落内の折返しとして扱い、HTML安全化は呼び出し側へ委ねる。
 * @param source - Textile構文を含む未変更の原文。
 * @returns Textile.jsが生成したサニタイズ前のHTML。
 */
export function renderTextile(source: string): string {
    const extracted = extractTextileCodeBlocks(source);
    let html = textile(normalizeDocumentedTextileSyntax(extracted.source), { breaks: true });
    for (const [marker, codeHtml] of extracted.codeBlocks) {
        html = html.replace(`<p>${marker}</p>`, codeHtml).replace(marker, codeHtml);
    }
    html = html
        .replace(
            /<\/?acronym\b/gi,
            /**
             * Textile.jsの旧acronym要素を記事が示すabbr要素へ揃える。
             * @param tag - 変換前のacronym開始または終了タグ。
             * @returns 同じ属性を維持したabbrタグ。
             */
            (tag) => tag.replace(/acronym/i, 'abbr')
        )
        .replace(/<p>---<\/p>/g, '<hr />');
    return addTextileScriptAndSubscriptTags(html);
}

/**
 * bc./bc..とpre./pre..をTextile.jsの段落整形から分離し、空行とインデントを保ったHTMLへ置き換える。
 * Textile.jsが連続コード段落に付加する空白を避け、コード本文の改行を画面・PDF・HTMLで一致させる。
 * @param source - Textile構文を含む未変更原文。
 * @returns Textile.jsへ渡すマーカー入り本文と、HTMLへ戻すコードブロックの対応表。
 */
function extractTextileCodeBlocks(source: string): { source: string; codeBlocks: Map<string, string> } {
    const lines = source.split(/(?<=\n)|(?<=\r)(?!\n)/);
    const output: string[] = [];
    const codeBlocks = new Map<string, string>();
    let rawPreformatted = false;
    let rawNoTextile = false;
    let extendedNoTextile = false;
    let paragraphNoTextile = false;
    let index = 0;

    while (index < lines.length) {
        const rawLine = lines[index] ?? '';
        const line = rawLine.replace(/(?:\r\n|\r|\n)$/, '');
        if (extendedNoTextile && isTextileBlockBoundary(line)) extendedNoTextile = false;
        else if (extendedNoTextile) {
            output.push(rawLine);
            index += 1;
            continue;
        }
        if (paragraphNoTextile && !line.trim()) paragraphNoTextile = false;
        if (rawPreformatted) {
            if (/<\/pre\s*>/i.test(line)) rawPreformatted = false;
            output.push(rawLine);
            index += 1;
            continue;
        }
        if (rawNoTextile) {
            if (/<\/notextile\s*>/i.test(line)) rawNoTextile = false;
            output.push(rawLine);
            index += 1;
            continue;
        }
        if (paragraphNoTextile) {
            output.push(rawLine);
            index += 1;
            continue;
        }
        if (!/<notextile\b/i.test(line) && /<pre\b/i.test(line)) {
            const rawPre = extractRawHtmlPreBlock(lines, index);
            if (rawPre) {
                const marker = `mvetextilecodeblock${codeBlocks.size}`;
                codeBlocks.set(marker, renderRawHtmlPreBlock(rawPre.html));
                const replacement = `${marker}\n\n${rawPre.suffix}`;
                const replacementLines = replacement.split(/(?<=\n)|(?<=\r)(?!\n)/);
                lines.splice(index, lines.length - index, ...replacementLines);
                continue;
            }
        }
        if (/<(?:pre|notextile)\b[^>]*>/i.test(line)) {
            if (/<pre\b[^>]*>/i.test(line) && !/<\/pre\s*>/i.test(line)) rawPreformatted = true;
            if (/<notextile\b[^>]*>/i.test(line) && !/<\/notextile\s*>/i.test(line)) rawNoTextile = true;
            output.push(rawLine);
            index += 1;
            continue;
        }
        if (/^notextile\.{1,2}(?:\s|$)/i.test(line)) {
            extendedNoTextile = /^notextile\.\.(?:\s|$)/i.test(line);
            paragraphNoTextile = !extendedNoTextile;
            output.push(rawLine);
            index += 1;
            continue;
        }

        const codeLead = /^(bc|pre)(\.\.?)[ \t](.*)$/i.exec(line);
        if (!codeLead) {
            output.push(rawLine);
            index += 1;
            continue;
        }

        const isCode = codeLead[1]?.toLowerCase() === 'bc';
        const isExtended = codeLead[2] === '..';
        const bodyLines = [codeLead[3] ?? ''];
        if (rawLine.length > line.length) bodyLines[0] += rawLine.slice(line.length);
        index += 1;
        while (index < lines.length) {
            const nextRawLine = lines[index] ?? '';
            const nextLine = nextRawLine.replace(/(?:\r\n|\r|\n)$/, '');
            if (isExtended && isTextileBlockBoundary(nextLine)) break;
            if (!isExtended && !nextLine.trim()) break;
            bodyLines.push(nextRawLine);
            index += 1;
        }

        const body = bodyLines.join('').replace(/(?:\r\n|\r|\n)+$/u, '');
        const marker = `mvetextilecodeblock${codeBlocks.size}`;
        const escapedCode = escapeTextileCode(body);
        codeBlocks.set(marker, isCode ? `<pre><code>${escapedCode}</code></pre>` : `<pre>${escapedCode}</pre>`);
        output.push(`\n\n${marker}\n\n`);
    }

    return { source: output.join(''), codeBlocks };
}

/**
 * Textile変換対象の行頭にあるHTML preブロックを抽出し、後続行を置き換え可能にする。
 * @param lines - 改行を保持したTextileソース行。
 * @param startIndex - pre開始候補行の位置。
 * @returns 閉じタグまで揃ったpre要素とその後続ソース。未完の要素はundefined。
 */
function extractRawHtmlPreBlock(
    lines: readonly string[],
    startIndex: number
): { html: string; suffix: string } | undefined {
    const tail = lines.slice(startIndex).join('');
    const opening = /^([ \t]*)(<pre\b[^>]*>)/i.exec(tail);
    if (!opening) return undefined;
    const openingEnd = opening[0].length;
    const closing = /<\/pre\s*>/i.exec(tail.slice(openingEnd));
    if (!closing) return undefined;
    const closingStart = openingEnd + closing.index;
    const closingEnd = closingStart + closing[0].length;
    return {
        html: opening[2] + tail.slice(openingEnd, closingStart) + closing[0],
        suffix: tail.slice(closingEnd)
    };
}

/**
 * raw HTML pre要素をプレーンなコード文字列として再構成する。
 * @param source - Textile入力から抽出した閉じ済みpre要素。
 * @returns 内容をHTMLエスケープし、コード言語クラスを保持したpre要素。
 */
function renderRawHtmlPreBlock(source: string): string {
    const opening = /^<pre\b([^>]*)>/i.exec(source);
    const closing = /<\/pre\s*>$/i.exec(source);
    if (!opening || !closing) return source;
    const inner = source.slice(opening[0].length, closing.index);
    const code = /^\s*(<code\b[^>]*>)([\s\S]*?)(<\/code\s*>)\s*$/i.exec(inner);
    const preOpen = `<pre${opening[1] ?? ''}>`;
    if (!code) return `${preOpen}${escapeTextileCode(trimCodeWrapperNewlines(decodeTextileCodeEntities(inner)))}</pre>`;
    const codeOpen = code[1] ?? '<code>';
    const codeBody = trimCodeWrapperNewlines(decodeTextileCodeEntities(code[2] ?? ''));
    const codeClose = code[3] ?? '</code>';
    return `${preOpen}${codeOpen}${escapeTextileCode(codeBody)}${codeClose}</pre>`;
}

/**
 * HTMLタグの直後・直前に置かれた整形用改行を一つずつ取り除く。
 * @param source - raw preまたはcode要素の本文。
 * @returns ラッパー整形用の先頭・末尾改行を除いたコード本文。
 */
function trimCodeWrapperNewlines(source: string): string {
    return source.replace(/^(?:\r\n|\r|\n)/, '').replace(/(?:\r\n|\r|\n)$/, '');
}

/**
 * コードブロックのHTML文字参照を文字へ戻し、再エスケープ前のソースを復元する。
 * @param source - raw HTML pre/code要素内の本文。
 * @returns 標準文字参照と数値文字参照を復号した文字列。
 */
export function decodeTextileCodeEntities(source: string): string {
    return source.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, reference: string) => {
        const normalized = reference.toLowerCase();
        if (normalized === 'amp') return '&';
        if (normalized === 'lt') return '<';
        if (normalized === 'gt') return '>';
        if (normalized === 'quot') return '"';
        if (normalized === 'apos') return "'";
        if (normalized === 'nbsp') return '\u00a0';
        const codePoint = normalized.startsWith('#x')
            ? Number.parseInt(normalized.slice(2), 16)
            : Number.parseInt(normalized.slice(1), 10);
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : entity;
    });
}

/**
 * Textileコード本文をHTMLテキストとして出力し、タグやエンティティの実行・解釈を防ぐ。
 * @param source - Textileコードブロックの本文。
 * @returns &, <, >をエスケープし、改行と引用符を保持した文字列。
 */
function escapeTextileCode(source: string): string {
    return source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * コード抽出中に次のTextileブロックへ切り替える明示接頭辞か判定する。
 * @param line - 複数段落コードまたはnotextile本文内の行。
 * @returns 次のTextileブロックであればtrue。
 */
function isTextileBlockBoundary(line: string): boolean {
    return /^(?:p|div|bq|bc|pre|notextile|h[1-6])(?:[<>=()]*)(?:\([^)]*\))?(?:\{[^}]*\})?(?:\[[^\]]*\])?\.{1,2}(?:\s|$)/i.test(line)
        || /^(?:p|div|bq|bc|pre|notextile|h[1-6])\.(?:https?:\/\/|\()/i.test(line);
}

/**
 * 参照記事で使われているTextile表記の差をTextile.jsの入力へ正規化する。
 * コード・notextile・pre内は原文を保ち、コード内のリンク候補を誤変換しない。
 * @param source - TextileまたはMarkdown混在文書の未変更原文。
 * @returns Textile.jsで変換可能な構文へ正規化した一時入力。
 */
function normalizeDocumentedTextileSyntax(source: string): string {
    let extendedBlock = false;
    let extendedNoTextile = false;
    let paragraphProtected = false;
    let paragraphNoTextile = false;
    let rawPreformatted = false;
    let rawNoTextile = false;
    const noTextileProtectedTags = new Map<string, number>();

    return source.split(/(?<=\n)|(?<=\r)(?!\n)/).map(
        /**
         * コード・変換除外範囲を追跡し、本文行だけを参照記法へ正規化する。
         * @param rawLine - 改行を含む原文の一行。
         * @returns 改行と保護領域を保った正規化行。
         */
        (rawLine) => {
            const line = rawLine.replace(/(?:\r\n|\r|\n)$/, '');
            const newline = rawLine.slice(line.length);
            if (extendedBlock && isTextileBlockBoundary(line)) {
                extendedBlock = false;
                extendedNoTextile = false;
                noTextileProtectedTags.clear();
            }
            if (paragraphProtected && !line.trim()) {
                paragraphProtected = false;
                paragraphNoTextile = false;
                noTextileProtectedTags.clear();
            }
            if (rawPreformatted) {
                if (/<\/pre\s*>/i.test(line)) rawPreformatted = false;
                return rawLine;
            }
            if (rawNoTextile) {
                const closesNotextile = /<\/notextile\s*>/i.test(line);
                const protectedLine = protectTextileScriptMarkersInRawMarkup(rawLine, noTextileProtectedTags);
                if (closesNotextile) {
                    rawNoTextile = false;
                    noTextileProtectedTags.clear();
                }
                return protectedLine;
            }
            if (extendedNoTextile) return protectTextileScriptMarkersInRawMarkup(line, noTextileProtectedTags) + newline;
            if (paragraphNoTextile) return protectTextileScriptMarkersInRawMarkup(line, noTextileProtectedTags) + newline;
            if (extendedBlock || paragraphProtected) return rawLine;

            if (/<(?:pre|notextile)\b[^>]*>/i.test(line)) {
                if (/<pre\b[^>]*>/i.test(line) && !/<\/pre\s*>/i.test(line)) rawPreformatted = true;
                if (/<notextile\b[^>]*>/i.test(line)) {
                    const closesNotextile = /<\/notextile\s*>/i.test(line);
                    rawNoTextile = !closesNotextile;
                    const protectedLine = protectTextileScriptMarkersInRawMarkup(rawLine, noTextileProtectedTags);
                    if (closesNotextile) noTextileProtectedTags.clear();
                    return protectedLine;
                }
                return rawLine;
            }
            const protectedLead = /^(bc|pre|notextile)(?:\([^)]*\))?(?:\{[^}]*\})?(?:\[[^\]]*\])?\.(\.)?(?:\s|$)/i.exec(line);
            if (protectedLead) {
                const isNoTextile = protectedLead[1]?.toLowerCase() === 'notextile';
                if (protectedLead[2]) {
                    extendedBlock = true;
                    extendedNoTextile = isNoTextile;
                } else {
                    paragraphProtected = true;
                    paragraphNoTextile = isNoTextile;
                }
                const protectedBody = isNoTextile
                    ? protectTextileScriptMarkersInRawMarkup(line.slice(protectedLead[0].length), noTextileProtectedTags)
                    : line;
                return (isNoTextile ? protectedLead[0] : '') + protectedBody + newline;
            }
            let normalizedLine = normalizeTextileDefinitionList(line);
            normalizedLine = normalizeTextileCitePrefix(normalizedLine);
            normalizedLine = normalizeOutsideTextileInlineCode(normalizedLine, normalizeTextileLinkedImages);
            normalizedLine = normalizeOutsideTextileInlineCode(normalizedLine, normalizeTextileReferenceLinks);

            if (isTextileExtendedBlock(line)) extendedBlock = true;
            return normalizedLine + newline;
        }
    ).join('');
}

/**
 * Textile.jsがリストとして扱う定義リスト接頭辞へ記事例を合わせる。
 * @param line - コード保護領域外の一行。
 * @returns 定義リスト例を変換した行。
 */
function normalizeTextileDefinitionList(line: string): string {
    return line.replace(/^(\s*)\*\s+(.+?)\s+:=\s+(.+?)\s*$/u, '$1- $2 := $3');
}

/**
 * NotePM例の引用元URLをTextile.jsが認識するcite付きblockquote表記へ揃える。
 * @param line - コード保護領域外の一行。
 * @returns cite付き引用または元の行。
 */
function normalizeTextileCitePrefix(line: string): string {
    const parenthesized = /^(\s*)bq\.\((https?:\/\/[^)\s]+)\)\s+(.+)$/i.exec(line);
    if (parenthesized) return `${parenthesized[1]}bq.:${parenthesized[2]} ${parenthesized[3]}`;
    const compact = /^(\s*)bq\.(https?:\/\/\S+)\s+(.+)$/i.exec(line);
    if (compact) return `${compact[1]}bq.:${compact[2]} ${compact[3]}`;
    return line;
}

/**
 * Textileの画像後置URLをリンク内画像としてTextile.jsへ渡す。
 * @param line - コード保護領域外の一行。
 * @returns 後置URL付き画像をリンク表記へ変換した行。
 */
function normalizeTextileLinkedImages(line: string): string {
    return line.replace(/!([^!\r\n]+)!(https?:\/\/[^\s]+)/gi, '"!$1!":$2');
}

/**
 * Textileの参照リンク短縮例を表示名付きの通常リンクへ正規化する。
 * @param line - コード保護領域外の一行。
 * @returns `[label]URL` 表記をTextileリンクへ変換した行。
 */
function normalizeTextileReferenceLinks(line: string): string {
    return line.replace(/\[([a-z][\w-]*)\](https?:\/\/[^\s\]]+)/gi, '"$1":$2');
}

/**
 * Textileリンク補助記法の正規化をインラインコード外に限定する。
 * @param line - Textile本文の一行。
 * @param normalize - コード外のテキストへ適用するリンク正規化。
 * @returns `@...@` の内容を維持した正規化行。
 */
function normalizeOutsideTextileInlineCode(line: string, normalize: (text: string) => string): string {
    const codeSpan = /@[^@\r\n]*@/gu;
    let output = '';
    let cursor = 0;
    for (const match of line.matchAll(codeSpan)) {
        const index = match.index ?? cursor;
        output += normalize(line.slice(cursor, index)) + match[0];
        cursor = index + match[0].length;
    }
    return output + normalize(line.slice(cursor));
}

/**
 * notextileのテキスト内にある上付き・下付き記号だけを数値参照へ退避する。
 * @param text - Textile変換を受けないプレーンテキスト。
 * @returns 後段のHTML補正が記号を変換しない一時表現。
 */
function protectTextileScriptMarkers(text: string): string {
    return text
        .replace(/\^([^<>^]+?)\^/gu, '&#94;$1&#94;')
        .replace(/~([^<>~]+?)~/gu, '&#126;$1&#126;');
}

/**
 * raw notextile HTML内のテキストだけを退避し、タグ属性と改行をそのまま残す。
 * @param source - notextileの開始行、本文行、または終了行を含む原文。
 * @returns 上付き・下付き記号を後段補正から保護したHTML行。
 */
function protectTextileScriptMarkersInRawMarkup(
    source: string,
    protectedTagCounts: Map<string, number>
): string {
    let output = '';
    let textStart = 0;
    let cursor = 0;
    while (cursor < source.length) {
        if (source[cursor] !== '<') {
            cursor += 1;
            continue;
        }
        if (!/[A-Za-z/!?]/u.test(source[cursor + 1] ?? '')) {
            cursor += 1;
            continue;
        }
        if (cursor > textStart) {
            const text = source.slice(textStart, cursor);
            output += protectedTagCounts.size === 0 ? protectTextileScriptMarkers(text) : text;
        }
        const tagEnd = findHtmlTagEnd(source, cursor);
        if (tagEnd < 0) {
            output += source.slice(cursor);
            textStart = source.length;
            break;
        }
        const tag = source.slice(cursor, tagEnd + 1);
        output += tag;
        updateProtectedTagCounts(tag, protectedTagCounts);
        cursor = tagEnd + 1;
        textStart = cursor;
    }
    if (textStart < source.length) {
        const text = source.slice(textStart);
        output += protectedTagCounts.size === 0 ? protectTextileScriptMarkers(text) : text;
    }
    return output;
}

/**
 * 二重ピリオドで次の明示ブロックまで続くTextile構文か判定する。
 * @param line - 描画中のTextile行。
 * @returns 継続ブロックならtrue。
 */
function isTextileExtendedBlock(line: string): boolean {
    return /^(?:p|div|bq|bc|pre|notextile|h[1-6])(?:[<>=()]*)(?:\([^)]*\))?(?:\{[^}]*\})?(?:\[[^\]]*\])?\.\.(?:\s|$)/i.test(line);
}

/**
 * Textile.js 2.1.1 leaves Textile superscript and subscript markers as text, so this adapter
 * completes those phrase forms only in generated text nodes. Code and preformatted regions stay literal.
 * @param html - Unsanitized HTML returned by Textile.js.
 * @returns HTML with supported Textile superscript and subscript phrases represented as tags.
 */
function addTextileScriptAndSubscriptTags(html: string): string {
    const output: string[] = [];
    const protectedTagCounts = new Map<string, number>();
    let textStart = 0;
    let cursor = 0;

    while (cursor < html.length) {
        if (html[cursor] !== '<') {
            cursor += 1;
            continue;
        }

        if (cursor > textStart) {
            const text = html.slice(textStart, cursor);
            output.push(protectedTagCounts.size === 0 ? replaceTextileScriptMarkers(text) : text);
        }

        const tagEnd = findHtmlTagEnd(html, cursor);
        if (tagEnd < 0) {
            const trailingText = html.slice(cursor);
            output.push(protectedTagCounts.size === 0 ? replaceTextileScriptMarkers(trailingText) : trailingText);
            textStart = html.length;
            break;
        }

        const tag = html.slice(cursor, tagEnd + 1);
        output.push(tag);
        updateProtectedTagCounts(tag, protectedTagCounts);
        cursor = tagEnd + 1;
        textStart = cursor;
    }

    if (textStart < html.length) {
        const trailingText = html.slice(textStart);
        output.push(protectedTagCounts.size === 0 ? replaceTextileScriptMarkers(trailingText) : trailingText);
    }

    return output.join('');
}

/**
 * Replaces only complete Textile ^sup^ and ~sub~ phrase markers in an already escaped HTML text node.
 * @param text - HTML text outside tags, code, preformatted content, scripts, or styles.
 * @returns Text with Textile script markers converted to safe inline tags.
 */
function replaceTextileScriptMarkers(text: string): string {
    return text
        .replace(/\^([^<>^]+?)\^/gu, '<sup>$1</sup>')
        .replace(/~([^<>~]+?)~/gu, '<sub>$1</sub>');
}

/**
 * Finds the end of one generated HTML tag while respecting quoted attribute values.
 * @param html - Textile.js output being scanned.
 * @param tagStart - Index of the opening less-than sign.
 * @returns The closing greater-than index, or -1 for malformed trailing markup.
 */
function findHtmlTagEnd(html: string, tagStart: number): number {
    let quote: '"' | "'" | undefined;
    for (let index = tagStart + 1; index < html.length; index += 1) {
        const character = html[index];
        if (quote) {
            if (character === quote) quote = undefined;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === '>') return index;
    }
    return -1;
}

/**
 * Tracks generated code and raw-text tags so Textile markers inside those regions are not reinterpreted.
 * @param tag - One complete generated HTML tag.
 * @param protectedTagCounts - Mutable counts for code, pre, script, and style regions.
 */
function updateProtectedTagCounts(tag: string, protectedTagCounts: Map<string, number>): void {
    const match = tag.match(/^<\s*(\/?)\s*(code|pre|script|style)\b/iu);
    if (!match || /\/\s*>$/u.test(tag)) return;
    const [, closingSlash, tagName] = match;
    if (!tagName) return;

    const normalizedTagName = tagName.toLowerCase();
    const count = protectedTagCounts.get(normalizedTagName) ?? 0;
    const nextCount = closingSlash ? Math.max(0, count - 1) : count + 1;
    if (nextCount === 0) protectedTagCounts.delete(normalizedTagName);
    else protectedTagCounts.set(normalizedTagName, nextCount);
}
