/**
 * @fileoverview Marpの各スライドを、PDFで個別ページとして扱えるHTMLへまとめる。
 */
/** Marpの描画済みスライドを含むPDF出力データ。 */
export interface MarpPdfExportContent {
  html: string;
  css: string;
  slideCount: number;
}

/**
 * サニタイズ済みのMarpスライドHTMLを、1スライドずつ識別できる要素へ包む。
 * @param slides - Marp Coreが描画し、呼び出し元でサニタイズ済みの各スライドHTML。
 * @param css - Marp Coreが生成したテーマとディレクティブのCSS。
 * @returns 空でないデッキならPDF用HTMLとページ数、空ならundefined。
 */
export function createMarpPdfExportContent(
  slides: readonly string[],
  css: string,
): MarpPdfExportContent | undefined {
  if (slides.length === 0) return undefined;

  const html = slides.map((slide, index) =>
    `<article class="mve-marp-slide mve-marp-pdf-slide" data-mve-marp-pdf-slide="${index + 1}"><div class="marpit">${slide}</div></article>`,
  ).join("\n");

  return { html, css, slideCount: slides.length };
}
