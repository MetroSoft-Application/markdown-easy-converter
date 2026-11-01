/**
 * @fileoverview 独立出力エンジンのHTML/PDFで共通する本文タイポグラフィと表の折り返しCSSを生成する。
 * CLI経由と拡張の保存要求は同じ出力規則を利用する。
 */
import { DEFAULT_PDF_OPTIONS } from './protocol';
import { fontFamilyForCss } from './fontFamily';

/**
 * HTML/PDF本文へ適用するフォントと基本レイアウトのCSSを作る。
 * @param fontFamily - 出力CSSへ設定するフォントファミリー。
 * @returns 出力本文のタイポグラフィ、表幅、セル内折り返しを定義するCSS。
 */
export function printContentCss(fontFamily: string): string {
    const safeFontFamily = fontFamilyForCss(
        fontFamily,
        DEFAULT_PDF_OPTIONS.fontFamily,
    );
    return `
body{font-family:${safeFontFamily};color:#202124;line-height:1.75;font-size:11pt}
h1{font-size:24pt;border-bottom:2px solid #3a70b8;padding-bottom:6px}h2{font-size:18pt;border-bottom:1px solid #bbb;padding-bottom:4px}h3{font-size:14pt}
/* 表は内容の最大幅を基準にし、親要素を超える長文はセル内で折り返す。 */
table{width:max-content;max-width:100%;border-collapse:collapse;margin:1em 0}th,td{border:1px solid #888;padding:6px 8px;vertical-align:top;word-break:normal;overflow-wrap:anywhere}th{color:#202124;background:#bdd5ef}
/* プレビュー由来のnowrap属性は出力へ持ち込まず、表示幅に合わせて折り返す。 */
table th[data-mve-nowrap="true"],table td[data-mve-nowrap="true"]{white-space:normal;overflow-wrap:anywhere}
/* 短い候補の列は内容幅を保ち、表で幅が足りない場合だけ緊急折り返しを許可する。 */
table th[data-mve-short-value-candidate="true"],table td[data-mve-short-value-candidate="true"]{word-break:keep-all;overflow-wrap:break-word}
/* 空白を含む短い見出し語句は通常幅では一組にし、狭い画面・用紙では折り返す。 */
table th[data-mve-short-value-label="true"]{white-space:nowrap;overflow-wrap:normal}
/* 端末幅が狭い場合はセル余白を縮め、列内容の折り返し領域を確保する。 */
@media screen and (max-width:400px){table th,table td{padding:4px 1px}table th[data-mve-short-value-label="true"]{white-space:normal;overflow-wrap:anywhere}}
@media print and (max-width:400px){table th[data-mve-short-value-label="true"]{white-space:normal;overflow-wrap:anywhere}}
pre{background:#f5f5f5;border:1px solid #ddd;border-radius:4px;padding:12px;overflow-wrap:anywhere;white-space:pre-wrap}
blockquote,.markdown-alert{border-left:4px solid #3a70b8;margin:1em 0;padding:8px 14px;background:#f4f7fb}
img,svg{max-width:100%;height:auto}.page-break{break-after:page}.code-figure figcaption button{display:none}.table-of-contents ul{list-style:none;padding-left:0}.toc-level-2{padding-left:1em}.toc-level-3{padding-left:2em}
`;
}
