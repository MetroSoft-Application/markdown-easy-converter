/**
 * @fileoverview PDF に埋め込むコードブロックのシンタックス色を検査する Node テスト。
 * 回帰リスク: 暗色テーマ向けの色が明色のコード背景に載り、PDF で関数名などが判読できなくなること、
 * HTML 出力と PDF 出力でハイライト配色が食い違うこと、および Marp テーマの暗色コード背景へ明色向けの色が漏れること。
 * ビルドやブラウザーを必要とせず、ソースの CSS / TS を静的に解析する。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/** リポジトリの絶対パス。 */
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** 色だけで構文を区別する文字の最低コントラスト比。現行 HTML 配色のコメント色 (約 4.2) を下限として許容する。 */
const minimumContrast = 4;
/** Marp スライド内を除外する接尾辞。Marp はテーマごとにコード背景が暗色になり得るため、明色向けの色を当てない。 */
const marpExclusion = ':not(.marpit *)';

/**
 * CSS テキストから hljs クラスごとの color 値を取り出す。セレクター一覧の各クラスへ同じ色を割り当てる。
 * @param css - 解析する CSS。
 * @param prefix - クラス名の前に付く祖先セレクター (例: `.mve-html `)。
 * @param suffix - クラス名の後ろに必須の接尾辞。付いていないセレクターは失敗にする。
 * @returns hljs クラス名から小文字の 16 進色への対応。
 * @throws 色を読み取れない hljs ルールや、接尾辞のない hljs セレクターがある場合。
 */
function highlightColors(css, prefix, suffix = '') {
  // 直前のドキュメントコメントがセレクター文字列へ混ざらないよう、コメントを除いてから解析する。
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const colors = new Map();
  const rule = /([^{}]+)\{\s*color:\s*(#[0-9a-f]{6})\s*;?\s*\}/gi;
  for (const [, selectors, color] of source.matchAll(rule)) {
    // 先行する @import などの文はセレクターではないため、最後の ; より後ろだけを読む。
    for (const selector of selectors.split(';').pop().split(',')) {
      const trimmed = selector.trim();
      if (!trimmed.startsWith(prefix) || !trimmed.includes('.hljs-')) continue;
      let name = trimmed.slice(prefix.length);
      assert.ok(name.endsWith(suffix), `${trimmed} must end with ${suffix}`);
      name = name.slice(0, name.length - suffix.length);
      if (/^\.hljs-[\w-]+$/.test(name)) colors.set(name, color.toLowerCase());
    }
  }
  // color 以外の宣言を持つ規則などを黙って比較から漏らさないよう、抽出数とセレクター出現数を照合する。
  const declared = new Set([...source.matchAll(new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.hljs-[\\w-]+)`, 'g'))]
    .map((match) => match[1]));
  assert.deepEqual([...colors.keys()].sort(), [...declared].sort(), 'some hljs rules could not be parsed as color-only rules');
  return colors;
}

/**
 * WCAG 2 の相対輝度からコントラスト比を求める。
 * @param foreground - 文字色 (#rrggbb)。
 * @param background - 背景色 (#rrggbb)。
 * @returns 1 以上 21 以下のコントラスト比。
 */
function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

test('PDF syntax highlight colors match HTML output, skip Marp slides, and stay readable on the code background', async () => {
  const pdfColors = highlightColors(await readFile(path.join(root, 'src', 'styles', 'print-assets.css'), 'utf8'), '', marpExclusion);
  const htmlColors = highlightColors(await readFile(path.join(root, 'src', 'html.ts'), 'utf8'), '.mve-html ');
  const printCss = await readFile(path.join(root, 'src', 'shared', 'printContentCss.ts'), 'utf8');
  const codeBackground = /(?:^|[}\s])pre\{[^}]*background:(#[0-9a-f]{6})/im.exec(printCss)?.[1];
  assert.ok(codeBackground, 'PDF code block background was not found in printContentCss.ts');
  assert.ok(pdfColors.size > 0, 'print-assets.css defines no hljs colors');
  assert.deepEqual(Object.fromEntries(pdfColors), Object.fromEntries(htmlColors));
  for (const [name, color] of pdfColors) {
    const ratio = contrastRatio(color, codeBackground);
    assert.ok(ratio >= minimumContrast, `${name} ${color} has contrast ${ratio.toFixed(2)} on ${codeBackground}`);
  }
});
