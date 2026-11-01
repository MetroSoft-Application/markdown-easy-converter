/**
 * @fileoverview Markdownプレビューを保存可能なHTMLへまとめ、設定値とリソース参照を出力へ反映する。
 */
/**
 * HTMLを出力向けに調整し、Mermaidの描画結果を埋め込む。
 * @param html - 表示または出力するHTML本文。
 * @returns 遅延画像を即時読み込みにし、SVG置換を反映したHTML。
 */
export function prepareExportHtml(html: string): string {
    const eagerImages = html.replace(/\sloading=(['"])lazy\1/gi, ' loading="eager"');
    return eagerImages.replace(
        /<div([^>]*?)\sdata-mve-export-svg="([^"]+)"([^>]*)><\/div>/gi,


        (_match, before: string, encoded: string, after: string) => {
            try {
                return `<div${before}${after}>${decodeURIComponent(encoded)}</div>`;
            } catch {
                return `<div${before}${after}></div>`;
            }
        }
    );
}
