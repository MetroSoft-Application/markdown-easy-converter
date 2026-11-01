/**
 * @fileoverview コードブロックの言語名を正規化し、highlight.jsの読み込み済み言語だけで安全に強調表示する。
 */
import hljs from "highlight.js";

/**
 * codehighlighterの計算結果を再利用するキャッシュ。
 */
const highlightedCodeCache = new Map<string, string>();
/**
 * シンタックスハイライト結果を保持する最大件数。
 */
const MAX_HIGHLIGHTED_CODE_CACHE_ENTRIES = 96;

/**
 * 言語別のhighlight.jsモジュールが読み込まれている場合にコードをHTMLへ変換する。
 * @param text - 表示・解析・変換の対象となる本文。
 * @param language - codehighlighterの対象や分岐を識別する値。
 * @returns 強調表示済みHTML。言語が未登録または解析に失敗した場合はundefined。
 */
export function highlightCode(text: string, language: string): string | undefined {
    if (language && !hljs.getLanguage(language)) return undefined;
    const key = `${language || "auto"}\u0000${text}`;
    const cached = highlightedCodeCache.get(key);
    if (cached !== undefined) {
        highlightedCodeCache.delete(key);
        highlightedCodeCache.set(key, cached);
        return cached;
    }
    const highlighted = language
        ? hljs.highlight(text, { language }).value
        : hljs.highlightAuto(text).value;
    highlightedCodeCache.set(key, highlighted);
    if (highlightedCodeCache.size > MAX_HIGHLIGHTED_CODE_CACHE_ENTRIES) {
        const oldest = highlightedCodeCache.keys().next().value as string | undefined;
        if (oldest !== undefined) highlightedCodeCache.delete(oldest);
    }
    return highlighted;
}
