/**
 * @fileoverview Markdown由来のHTML・SVGを許可範囲へ制限し、Webviewへ挿入する前に危険な要素を除去する。
 */
import DOMPurify from "dompurify";

/**
 * Markdown描画HTMLから許可されない要素と属性を除去する。
 * @param html - 表示または出力するHTML本文。
 * @param allowMarpitForeignObject - Marpit SVG内のHTMLを保持するPDF出力時のみtrue。
 * @returns DOMPurifyで危険な要素・属性を除去したHTML。
 */
export function sanitizeRenderedMarkdown(
    html: string,
    allowMarpitForeignObject = false,
): string {
    return DOMPurify.sanitize(html, {
        ADD_ATTR: [
            "target",
            "style",
            "data-original-src",
            "data-mve-link",
            "data-mve-image-index",
            "data-mve-image-kind",
            "data-mve-image-align",
            "data-mve-resizable",
            "data-mve-can-reset",
            "data-mve-short-value-candidate",
            "data-mve-short-value-label",
            "data-mve-text-color",
            "data-mermaid-source",
            "data-math-source",
            "data-copy-code",
            "data-language",
        ],
        ADD_TAGS: allowMarpitForeignObject
            ? ["mark", "ins", "foreignObject"]
            : ["mark", "ins"],
        ...(allowMarpitForeignObject
            ? { HTML_INTEGRATION_POINTS: { "annotation-xml": true, foreignobject: true } }
            : {}),
        ALLOW_DATA_ATTR: true,
    });
}
