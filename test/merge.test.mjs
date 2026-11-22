/**
 * @fileoverview `--merge`（複数の文書を1つのPDF/DOCXへまとめる）を検証する。
 * 実行境界: Node（node:test）。CLI を子プロセスで実行し、描画にはテスト用ブラウザーを使う。
 * 構成: 文書間リンクの解決（成果物が再公開する resolveMergedLinks を Node で）と結合の規則（再公開する mergeRenderedDocuments を
 * ブラウザーで）を単体で確かめ、実出力はサンプルの「本」（11章、`BOOK_FILES`を実行時に書き出す）の結合1回ずつ（DOCX・PDF）と、
 * 観点ごとの少数の変換で確かめる。DOCXは本文・しおり・リンク・脚注・画像がXMLで読めるため構造の検証に、PDFはしおり・用紙に使う。
 * 時間を短くするため、1回の変換に対して多くの項目を確かめ、互いに独立したテストは並列に実行する。
 * 回帰リスク: 見出し・脚注の ID の衝突による飛び先の誤り、文書間リンクの切れ・誤った飛び先、別の文書の場所からの画像の誤読、
 * 空の文書による白紙、1件の失敗での部分的な書き込み、`--json`・`--strict`・`--watch`・中断との組み合わせの破れ、
 * 単一文書の出力への影響、無害化の破れ、文書数が多い場合の性能。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { link, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import { chromium } from 'playwright-core';
import {
  assertPageSize, browserPath, cli, concurrency, imageHash, needsBrowser, readDocx, readPdf, renderer, requireCli, run, runOk,
  runWithoutBrowser, waitFor, withDirectory, writeFiles
} from './helpers.mjs';

/** 赤・青・緑の1x1 PNG。文書ごとの画像の取り違えを、中身で見分けるために使う。 */
const redPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const bluePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC', 'base64');
const greenPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgWMAAAAFEAKH5ZOq+AAAAAElFTkSuQmCC', 'base64');

const BOOK_FILES = {
  'book/00-cover.md': [
    '---', 'title: 結合テスト総合マニュアル', 'author: テスト', 'mve-convert:', '  pdf:', '    margins:', '      top: 12', '---',
    '# 表紙', '', '[toc]', '', '## この本の使い方', '', '各章へのリンク:', '',
    '- [基本記法](01-basics.md)',
    '- [基本記法の概要](01-basics.md#概要)',
    '- [図の章](02-figures/chapter.md)',
    '- [図の章の概要（./ 付き）](./02-figures/chapter.md#概要)',
    '- [図表の章の概要](03-diagrams.md#概要)',
    '- [リンクの章](04-links/links.md)',
    '- [Textile の章の概要](05-textile.textile#概要)',
    '- [混在記法の章](06-mixed.md)',
    '- [スライドの章](07-marp.md)',
    '- [空の章](08-empty.md)',
    '- [front matter だけの章](09-front-matter-only.md)',
    '- [記号を含む名前の章](10-names/%E5%A4%96%E9%83%A8%20%E6%96%87%E6%9B%B8%20%231.md)',
    '- [結合しない文書](../extras/not-merged.md)',
    '- [テキストファイル](../extras/notes.txt)',
    '- [Web](https://example.com/)',
    '- [メール](mailto:test@example.com)',
    '', '## 概要', '', '表紙の概要[^cover]。', '', '[^cover]: 表紙の脚注。', ''
  ].join('\n'),
  'book/01-basics.md': [
    '# 基本記法', '', '## 概要', '',
    '**太字**、*斜体*、~~取り消し~~、`インラインコード`、<kbd>Ctrl</kbd>、絵文字 😀。', '',
    '### リスト', '', '- 項目1', '  - 入れ子', '    - さらに入れ子', '- 項目2', '', '3. 三', '4. 四', '', '- [x] 完了', '- [ ] 未完了', '',
    '### 表', '', '| 左 | 中央 | 右 |', '| :--- | :---: | ---: |', '| a | **b** | `c` |', '| 長いセル | [リンク](#概要) | $x^2$ |', '',
    '### 引用と注意書き', '', '> 引用文', '>', '> > 入れ子の引用', '', '> [!NOTE]', '> 注意書きのブロック。', '',
    '### コード', '', '```ts', 'const value: number = 1;', 'console.log(`value: ${value}`);', '```', '',
    '### 数式', '', 'インライン $E = mc^2$ と別行立て:', '', '$', '\\int_0^1 x\\,dx = \\frac{1}{2}', '$', '',
    '## 見出しに $a_i$ と `code` を含む', '', '## 脚注付きの見出し[^h]', '',
    '本文の脚注[^1]と名前付き脚注[^named]。', '', '[^1]: 基本記法の脚注1。', '[^named]: 名前付きの脚注。', '[^h]: 見出しの脚注。', '',
    'Setext 見出し', '-------------', '', '## 明示 ID {#shared-id}', '', '[明示 ID へ](#shared-id)、[同じ文書の概要へ](#概要)。', '',
    '<details><summary>折りたたみ</summary>', '', '折りたたみの中身。', '', '</details>', '',
    '<script>window.mveInjected = 1</script>', '', '<p onclick="window.mveInjected = 2">イベント属性を持つ段落</p>', '',
    '[危険なリンク](javascript:alert(1))', '', '<!-- pagebreak -->', '', '## 改ページの後', '', '![ルートの図](figure.png)', '', '---', '',
    '基本記法の最後の段落。', ''
  ].join('\n'),
  'book/02-figures/chapter.md': [
    '# 図の章', '', '## 概要', '',
    'この章の画像は、この章のディレクトリ（02-figures）から読む。表紙と同じディレクトリにも同名の figure.png（黄）があり、取り違えると色が変わる。', '',
    '![PNG（赤）](figure.png "PNG の図")', '', '![JPEG（青）](figure.jpg)', '', '![GIF（緑）](figure.gif)', '', '![WebP（紫）](figure.webp)', '',
    '![SVG（橙）](figure.svg)', '', '![空白を含む名前](<my figure.png>)', '', '![エンコードした名前](my%20figure.png)', '',
    '![日本語の名前](図.png)', '', '![存在しない画像](missing.png)', '', '![画像でないファイル](not-image.png)', '',
    '![外部の画像](../../outside/secret.png)', '',
    '![data URI](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC)', '',
    '<img src="figure.png" alt="生HTMLの画像" width="20">', '', '| 表の中の画像 |', '| --- |', '| ![表のPNG](figure.png) |', '',
    '[基本記法の概要へ戻る](../01-basics.md#概要)', ''
  ].join('\n'),
  'book/02-figures/figure.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><rect id="shape" width="8" height="8" fill="#ff8000"/></svg>\n',
  'book/02-figures/not-image.png': 'This file is named .png but is plain text, so it must not be embedded.\n',
  'book/03-diagrams.md': [
    '# 図表', '', '## 概要', '',
    '```mermaid', 'flowchart LR', '  A[開始] --> B{判定}', '  B -->|はい| C[終了]', '  B -->|いいえ| A', '```', '',
    '構文エラーの図（エラー表示に置き換わり、出力は続く）:', '', '```mermaid', 'graph TD', '  A -->', '```', ''
  ].join('\n'),
  'book/04-links/links.md': [
    '# リンクの章', '', '## 概要', '',
    '- [表紙へ](../00-cover.md)',
    '- [表紙の概要へ](../00-cover.md#概要)',
    '- [エンコードした断片](../01-basics.md#%E6%A6%82%E8%A6%81)',
    '- [クエリ付き](../01-basics.md?view=1#概要)',
    '- [明示 ID](../01-basics.md#shared-id)',
    '- [Setext 見出し](../01-basics.md#setext-見出し)',
    '- [存在しない断片](../01-basics.md#no-such-heading)',
    '- [Textile の章](../05-textile.textile)',
    '- [自分の概要](#概要)',
    '- [自分の2つ目の概要](#概要-1)',
    '- [自分自身のファイル](links.md#概要)',
    '- [結合しない文書の断片](../../extras/not-merged.md#x)',
    '- [ディレクトリ](../02-figures/)',
    '- [不正なエスケープ](../01-basics.md#%E6%A6)',
    '- [空の章](../08-empty.md)',
    '', '## 概要', '', '同じ文書の中で重複した見出し。', ''
  ].join('\n'),
  'book/05-textile.textile': [
    'h1. Textile の章', '', 'h2. 概要', '', '*太字* と _斜体_ と @コード@。', '', '* 項目1', '** 入れ子', '* 項目2', '', '# 番号1', '# 番号2', '',
    '|_. 見出し |_. 値 |', '| a | 1 |', '| b | 2 |', '', 'bq. Textile の引用。', '', '"基本記法の概要へ":01-basics.md#概要', '',
    '!figure.png!', '', 'Textile の脚注[1]。', '', 'fn1. Textile の脚注本文。', ''
  ].join('\n'),
  'book/06-mixed.md': [
    '# 混在記法の章', '', 'h2. Textile 記法の見出し', '', '*Textile の太字* と **Markdown の太字**。', '', '|_. 列1 |_. 列2 |', '| x | y |', '',
    '## 概要', '', '混在記法の章の最後。', ''
  ].join('\n'),
  'book/07-marp.md': [
    '---', 'marp: true', 'theme: default', 'paginate: true', '---', '# スライド1', '', 'スライドの内容。', '', '---', '', '# スライド2', '',
    '![ルートの図](figure.png)', ''
  ].join('\n'),
  'book/08-empty.md': '',
  'book/09-front-matter-only.md': '---\ntitle: 本文のない章\n---\n',
  'book/10-names/外部 文書 #1.md': '# 記号を含む名前の章\n\n## 概要\n\n[表紙の使い方へ](../00-cover.md#この本の使い方)\n',
  'extras/not-merged.md': '# 結合しない文書\n\n## x\n',
  'extras/notes.txt': 'plain text\n',
  'book/figure.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAE0lEQVR4nGP8f4cBK2DCLjxYJQB3eAHrEj3BJQAAAABJRU5ErkJggg==', 'base64'),
  'book/02-figures/figure.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGO8w4AdMOEQH6QSALIMAOxjSSTlAAAAAElFTkSuQmCC', 'base64'),
  'book/02-figures/figure.jpg': Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQgJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDn6KKK/Rj87P/Z', 'base64'),
  'book/02-figures/figure.gif': Buffer.from('R0lGODdhCAAIAIEAAACgAAAAAAAAAAAAACwAAAAACAAIAAAIDwABCBxIsKDBgwgTKkwYEAA7', 'base64'),
  'book/02-figures/figure.webp': Buffer.from('UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoIAAgAAUAmJaACdLoB+AADsAD++F9//1aHy0PlofwkP/OJY6nd2gAA', 'base64'),
  'book/02-figures/my figure.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGNkOFHBgA0wYRUdtBIA/hABUMQeg0QAAAAASUVORK5CYII=', 'base64'),
  'book/02-figures/図.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGNkYLjDgA0wYRUdtBIAsFQA7DNldgEAAAAASUVORK5CYII=', 'base64'),
  'outside/secret.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGP8z/CfARtgwio6aCUAkYsCDoRKzmMAAAAASUVORK5CYII=', 'base64'),
};

/** サンプルの本の章（結合する順）。`writeFiles(directory, BOOK_FILES)`で書き出したディレクトリからの相対パス。 */
const BOOK = [
  '00-cover.md', '01-basics.md', '02-figures/chapter.md', '03-diagrams.md', '04-links/links.md', '05-textile.textile',
  '06-mixed.md', '07-marp.md', '08-empty.md', '09-front-matter-only.md', '10-names/外部 文書 #1.md'
].map((name) => path.join('book', name));

/** 結合した本の見出し（DOCXの見出しの段落の文字列、文書の順）。数式は OMML になり w:t に現れないため空白が残る。 */
const BOOK_HEADINGS = [
  '表紙', 'この本の使い方', '概要',
  '基本記法', '概要', 'リスト', '表', '引用と注意書き', 'コード', '数式', '見出しに  と code を含む', '脚注付きの見出し',
  'Setext 見出し', '明示 ID', '改ページの後',
  '図の章', '概要', '図表', '概要', 'リンクの章', '概要', '概要', 'Textile の章', '概要',
  '混在記法の章', 'Textile 記法の見出し', '概要', 'スライド1', 'スライド2', '記号を含む名前の章', '概要'
];

/** 各章の最初の見出しの番号（BOOK_HEADINGS の位置）。2章目以降はここから新しいページになる。中身のない章（08・09）は含めない。 */
const CHAPTER_STARTS = [0, 3, 15, 17, 19, 22, 24, 27, 29];

/** 画面写真から作る画像（WebP・SVG・Mermaid の図・リモート画像）。画素は配置で変わるため、中身ではなく位置で比べる。 */
const RASTER = Symbol('raster');

/**
 * DOCX の画像の並びを、期待する並び（元の画像のバイト列、または画面写真を表す RASTER）と比べる。
 * 元の形式（PNG・JPEG・GIF）はそのまま埋め込まれるため中身の一致を求め、画面写真は「元の画像のどれでもないこと」を求める。
 * @param {string[]} actual - DOCX の画像のハッシュ（本文の参照順）。
 * @param {(Buffer | symbol)[]} expected - 期待する画像。
 * @param {Buffer[]} sources - このテストで使った元の画像（画面写真がこれらと一致しないことを確かめる）。
 */
function assertImages(actual, expected, sources) {
  const known = new Set(sources.map(imageHash));
  assert.equal(actual.length, expected.length, `image count: ${actual.length} instead of ${expected.length}`);
  expected.forEach((item, index) => {
    if (item === RASTER) assert.ok(!known.has(actual[index]), `image ${index} must be a rendering`);
    else assert.equal(actual[index], imageHash(item), `image ${index} must be the same file`);
  });
}

/** 画像の検証で使う元の画像（画面写真がこれらのどれとも一致しないことを確かめる）。 */
const IMAGE_SOURCES = [...Object.values(BOOK_FILES).filter((value) => Buffer.isBuffer(value)), redPng, bluePng, greenPng];

/**
 * リモート画像を返すテスト用の HTTP サーバーを起動して検証を行い、終了時に止める。要求された URL を記録する。
 * @param {(base: string, requests: string[]) => Promise<void>} callback - サーバーの URL と要求の記録を受け取る検証。
 */
async function withImageServer(callback) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(request.url.includes('blue') ? bluePng : redPng);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * 画像の取り違えとアクセス制限を調べる2つの文書（docs/a・docs/b）と画像を作る。両方とも同じ名前の画像（PNG・JPEG・GIF・WebP・SVG）と
 * リモート画像を参照し、b は青の PNG・水色の SVG を持つ。b は a の場所にしかない only-in-a.png と、ワークスペース外の ../../outside.png も参照する。
 * @param {string} base - リモート画像のサーバーの URL。
 * @returns {Record<string, string | Buffer>} 書き出すファイル。
 */
function imageDocuments(base) {
  const doc = (title, remote) => `# ${title}\n\n![png](figure.png)\n\n![jpg](figure.jpg)\n\n![gif](figure.gif)\n\n![webp](figure.webp)\n\n![svg](figure.svg)\n\n![remote](${base}/${remote}.png)\n`;
  const figures = (name) => BOOK_FILES[`book/02-figures/${name}`];
  return {
    'docs/a/doc.md': doc('A', 'red'), 'docs/a/only-in-a.png': greenPng,
    'docs/b/doc.md': `${doc('B', 'blue')}\n![only](only-in-a.png)\n\n![outside](../../outside.png)\n`,
    'outside.png': greenPng, 'docs/b/figure.png': bluePng,
    'docs/b/figure.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#00ffff"/></svg>',
    ...Object.fromEntries(['figure.png', 'figure.jpg', 'figure.gif', 'figure.webp', 'figure.svg'].map((name) => [`docs/a/${name}`, figures(name)])),
    ...Object.fromEntries(['figure.jpg', 'figure.gif', 'figure.webp'].map((name) => [`docs/b/${name}`, figures(name)])),
  };
}

describe('merge', { concurrency }, () => {
  /**
   * 文書間リンクを、すべての書き方（相対・./・../・\・絶対パス・file: URI・?query・%エンコードした断片・不正な%エスケープ・
   * %23 を含むファイル名・大小文字違い・ワークスペース基準）で正しい文書と断片へ解決し、結合しない文書・ディレクトリ・
   * リモートやファイル以外の URI・空のリンクを解決しないことを確かめる。
   */
  test('links between documents resolve in every form', () => {
    const { resolveMergedLinks } = requireCli(cli);
    const root = path.join(tmpdir(), 'mve-merge-links', 'book');
    const a = path.join(root, 'a.md');
    const b = path.join(root, 'sub', 'b.md');
    const odd = path.join(root, '外部 文書 #1.md');
    const inputs = [a, b, odd, path.join(root, 'c.textile')];
    const cases = [
      ['sub/b.md', 1, ''], ['./sub/b.md#x', 1, 'x'], ['sub/b.md?view=1#x', 1, 'x'], ['sub/b.md?view=1', 1, ''], ['sub/b.md#', 1, ''],
      ['sub/../sub/./b.md#x', 1, 'x'], ['sub\\b.md#x', 1, 'x'], ['sub/b.md#%E6%A6%82%E8%A6%81', 1, '概要'], ['sub/b.md#概要', 1, '概要'],
      ['sub/b.md#%E6%A6', 1, '%E6%A6'], ['sub/b.md#a%20b', 1, 'a b'], ['%E5%A4%96%E9%83%A8%20%E6%96%87%E6%9B%B8%20%231.md', 2, ''],
      ['%E5%A4%96%E9%83%A8%20%E6%96%87%E6%9B%B8%20%231.md#%E6%A6%82%E8%A6%81', 2, '概要'], ['c.textile#t', 3, 't'], ['a.md#self', 0, 'self'],
      [b, 1, ''], [`${b}#x`, 1, 'x'], [pathToFileURL(b).href, 1, ''], [`${pathToFileURL(b).href}#x`, 1, 'x'], [pathToFileURL(odd).href, 2, ''],
      [`${pathToFileURL(odd).href}?q=1#%E6%A6%82%E8%A6%81`, 2, '概要'],
      ...(process.platform === 'win32' ? [['SUB/B.MD#x', 1, 'x'], ['Sub\\B.md', 1, '']] : []),
    ];
    const links = resolveMergedLinks(cases.map(([href]) => ({ href, workspaceRooted: false })), a, inputs, root);
    for (const [href, document, fragment] of cases) assert.deepEqual(links[`p:${href}`], { document, fragment }, href);
    assert.equal(Object.keys(links).length, cases.length);

    const ignored = ['other.md', 'sub/', 'sub', 'sub/b.markdown', 'sub/b.md.bak', 'https://example.com/sub/b.md', 'http://localhost/a.md',
      'mailto:a@example.com', 'tel:000', 'ftp://example.com/a.md', '//example.com/a.md', 'data:text/plain,a', 'javascript:alert(1)',
      'vscode://file/a.md', '', '#', '?x', path.join(root, 'sub', 'c.md'), pathToFileURL(path.join(root, 'z.md')).href, 'file:///%'];
    assert.deepEqual(resolveMergedLinks(ignored.map((href) => ({ href, workspaceRooted: false })), a, inputs, root), {});

    const rooted = { href: '/sub/b.md#x', workspaceRooted: true };
    assert.deepEqual(resolveMergedLinks([rooted, { href: '/sub/b.md#x', workspaceRooted: false }], a, [a, b], root), { 'r:/sub/b.md#x': { document: 1, fragment: 'x' } });
    assert.deepEqual(resolveMergedLinks([rooted], a, [a, b], path.join(root, 'sub')), {});
    const outside = path.join(tmpdir(), 'mve-merge-links', 'outside.md');
    assert.deepEqual(resolveMergedLinks([rooted], outside, [outside, b], root), {});
  });

  /**
   * 結合の規則を、成果物の mergeRenderedDocuments をブラウザーで直接実行して確かめる（ブラウザーの起動は1回）。
   * ID: 先の文書と重なる ID だけを、先の文書・同じ文書の既存の ID・既に割り当てた名前と重ならない名前へ改名し、同じ文書内の重複は保つ。
   *   SVG 内の ID は変えない。文書内の参照（%エンコードした断片・脚注の往復・aria-*・for・headers）は改名に従う。
   * 文書間リンク: 改名後の正しい見出しへ。断片なしは最初の見出し（生HTML・引用の中は除く）へ。見出しのない文書・飛び先にない断片・
   *   対応表にないリンクは元のまま。ワークスペース基準のキーを混同しない。
   * 目次: 全文書の見出し（data-mve-heading、生HTML・引用・脚注・目次・SVG の中と空の見出しを除く）で全ての目次を作り直す。
   * 画像: 埋め込み済みは data-original-src を外し、読み込めなかったローカル画像は再解決させない。リモートなどは変えない。
   * 改ページ: 中身のある文書の間にだけ挟む。無害化: 描画器の実際の出力を結合しても script・on*・javascript: が現れない。
   * 互換: 1文書だけなら描画器の出力が変わらない。性能: 300文書・1.2万の衝突でも短時間で、全 ID が一意。
   */
  test('merge rules for ids, links, tables of contents, images, page breaks, and safety', needsBrowser, async () => {
    const { mergeRenderedDocuments } = requireCli(cli);
    const browser = await chromium.launch({ executablePath: browserPath, headless: true });
    try {
      const page = await browser.newPage();
      await page.addScriptTag({ path: renderer });
      const merge = (htmls, label = '') => page.evaluate(mergeRenderedDocuments, {
        documents: htmls.map((item) => typeof item === 'string' ? { html: item, links: {} } : item), pageBreakLabel: label
      });
      const inspect = (html) => page.evaluate((markup) => {
        const template = document.createElement('template');
        template.innerHTML = markup;
        const root = template.content;
        return {
          ids: [...root.querySelectorAll('[id]')].filter((element) => !element.closest('svg')).map((element) => element.id),
          svgIds: [...root.querySelectorAll('svg, svg [id]')].map((element) => element.id),
          links: [...root.querySelectorAll('a')].map((anchor) => [anchor.textContent, anchor.getAttribute('href'), anchor.getAttribute('data-mve-link')]),
          toc: [...root.querySelectorAll('nav.table-of-contents')].map((nav) => [...nav.querySelectorAll('li')].map((item) => [item.className, item.textContent, item.querySelector('a').getAttribute('href')])),
          images: [...root.querySelectorAll('img')].map((image) => [image.getAttribute('alt'), image.getAttribute('src'), image.getAttribute('data-original-src')]),
          attributes: [...root.querySelectorAll('input, label, td')].map((element) => ['aria-labelledby', 'aria-describedby', 'for', 'headers'].map((name) => element.getAttribute(name))),
          children: [...root.children].map((element) => [element.tagName, element.className, element.getAttribute('aria-label')]),
          breaks: root.querySelectorAll('div.page-break').length,
        };
      }, html);
      const render = (source) => page.evaluate((markdown) => globalThis.mveMarkdownFallback.renderMarkdown(markdown,
        { remoteImagesEnabled: true, renderFormat: 'mixed', language: 'en' }), source);

      // ID の改名（C1）。
      const ids = await inspect(await merge([
        '<h1 id="a">A</h1><h2 id="a-1">A1</h2><p id="x">x</p><svg id="g"><g id="n"></g></svg>',
        '<h1 id="a">A</h1><h2 id="a-2">own a-2</h2><h2 id="a">dup</h2><p id="x">x</p><p id="y">y</p><svg id="g"><g id="n"></g></svg>',
        '<h1 id="a">A</h1><h2 id="a-3">own</h2><p id="y">y</p><p id="x-1">x1</p><p id="x">x</p>',
        '<h1 id="概要">概要</h1><p id="a b">space</p><p id="&quot;q&quot;">quote</p>',
        '<h1 id="概要">概要</h1><p id="a b">space</p><p id="&quot;q&quot;">quote</p>',
      ]));
      assert.deepEqual(ids.ids, ['a', 'a-1', 'x', 'a-3', 'a-2', 'a-3', 'x-1', 'y', 'a-4', 'a-3-1', 'y-1', 'x-1-1', 'x-2', '概要', 'a b', '"q"', '概要-1', 'a b-1', '"q"-1']);
      assert.deepEqual(ids.svgIds, ['g', 'n', 'g', 'n']);
      assert.equal(ids.breaks, 4);

      // 文書内の参照（C2）。
      const footnoted = (label) => `<h2 id="概要">概要</h2><p><a href="#%E6%A6%82%E8%A6%81">enc-${label}</a> <a href="#概要">raw-${label}</a>`
        + ` <a href="#missing">missing-${label}</a> <a href="#">top-${label}</a></p><p><sup class="footnote-ref"><a href="#fn-1" id="fnref-1-1">ref-${label}</a></sup></p>`
        + `<section class="footnotes"><ol><li id="fn-1">note <a href="#fnref-1-1">back-${label}</a></li></ol></section>`
        + `<span id="label">L</span><input aria-labelledby="label other" aria-describedby="label"><label for="label">for-${label}</label>`
        + '<table><tr><th id="h">H</th></tr><tr><td headers="h label">c</td></tr></table>';
      const internal = await inspect(await merge([footnoted('1'), footnoted('2')]));
      const href = (result, text) => result.links.find(([label]) => label === text)?.slice(1);
      for (const [text, expected] of [['enc-1', '#%E6%A6%82%E8%A6%81'], ['raw-1', '#概要'], ['enc-2', '#概要-1'], ['raw-2', '#概要-1'], ['missing-2', '#missing'],
        ['top-2', '#'], ['ref-1', '#fn-1'], ['ref-2', '#fn-1-1'], ['back-1', '#fnref-1-1'], ['back-2', '#fnref-1-1-1']]) {
        assert.equal(href(internal, text)[0], expected, text);
      }
      assert.deepEqual(internal.attributes, [['label other', 'label', null, null], [null, null, 'label', null], [null, null, null, 'h label'],
        ['label-1 other', 'label-1', null, null], [null, null, 'label-1', null], [null, null, null, 'h-1 label-1']]);

      // 文書間リンク（C3）。
      const link = (text, target, rooted = false) => `<a href="#" data-mve-link="${target}"${rooted ? ' data-mve-workspace-rooted="true"' : ''}>${text}</a>`;
      const between = await inspect(await merge([
        {
          html: '<h1 id="intro" data-mve-heading="true">Intro</h1><h2 id="only-first" data-mve-heading="true">Only</h2><h2 id="s" data-mve-heading="true">S</h2>'
            + link('to-b-s', 'b.md#s') + link('to-b', 'b.md') + link('to-c', 'c.md') + link('to-d', 'd.md') + link('to-b-missing', 'b.md#only-first')
            + link('to-b-rooted', '/b.md#s', true) + link('to-other', 'other.md') + link('to-self', 'a.md#s') + link('to-e', 'e.md#%E6%A6%82%E8%A6%81'),
          links: { 'p:b.md#s': { document: 1, fragment: 's' }, 'p:b.md': { document: 1, fragment: '' }, 'p:c.md': { document: 2, fragment: '' },
            'p:d.md': { document: 3, fragment: '' }, 'p:b.md#only-first': { document: 1, fragment: 'only-first' }, 'p:a.md#s': { document: 0, fragment: 's' },
            'p:e.md#%E6%A6%82%E8%A6%81': { document: 4, fragment: '概要' } }
        },
        { html: '<h3 id="raw">Raw</h3><blockquote><h1 id="quoted" data-mve-heading="true">Q</h1></blockquote><h1 id="b" data-mve-heading="true">B</h1>'
          + '<h2 id="s" data-mve-heading="true">S</h2>' + link('back', '../a.md#s'), links: { 'p:../a.md#s': { document: 0, fragment: 's' } } },
        '<p>No heading</p>', '<h1 id="s" data-mve-heading="true">D first</h1>', '<h1 id="概要" data-mve-heading="true">概要</h1>',
      ]));
      for (const [text, expected] of [['to-b-s', ['#s-1', null]], ['to-b', ['#b', null]], ['to-c', ['#', 'c.md']], ['to-d', ['#s-2', null]],
        ['to-b-missing', ['#', 'b.md#only-first']], ['to-b-rooted', ['#', '/b.md#s']], ['to-other', ['#', 'other.md']], ['to-self', ['#s', null]],
        ['to-e', ['#概要', null]], ['back', ['#s', null]]]) {
        assert.deepEqual(href(between, text), expected, text);
      }

      // 目次（C4）。
      const toc = '<nav class="table-of-contents" aria-label="TOC"><strong>TOC</strong><ul><li class="toc-level-1"><a href="#old">Old</a></li></ul></nav>';
      const tables = await inspect(await merge([
        `<h1 id="a" data-mve-heading="true">A</h1>${toc}<h2 id="x" data-mve-heading="true">  Spaced\n  heading </h2>`,
        '<h1 id="a" data-mve-heading="true">B <span class="katex"><span class="katex-mathml"><math>x2</math></span><span class="katex-html">x²</span></span></h1>'
          + '<h2 id="n" data-mve-heading="true">Note<sup class="footnote-ref"><a href="#fn-1" id="fnref-1-1">1</a></sup></h2>'
          + '<h3 id="raw">Raw HTML</h3><blockquote><h2 id="q" data-mve-heading="true">Quoted</h2></blockquote>'
          + '<h4 id="empty" data-mve-heading="true"> </h4><h6 id="deep" data-mve-heading="true">Deep &amp; &lt;escaped&gt;</h6>'
          + `<svg><foreignObject><h2 id="svg" data-mve-heading="true">In SVG</h2></foreignObject></svg>${toc}`
          + '<section class="footnotes"><h2 id="fh" data-mve-heading="true">Footnote heading</h2><ol><li id="fn-1">n</li></ol></section>',
      ]));
      const entries = [['toc-level-1', 'A', '#a'], ['toc-level-2', 'Spaced heading', '#x'], ['toc-level-1', 'B x²', '#a-1'], ['toc-level-2', 'Note', '#n'], ['toc-level-6', 'Deep & <escaped>', '#deep']];
      assert.deepEqual(tables.toc, [entries, entries]);
      assert.deepEqual((await inspect(await merge([`<p>no headings</p>${toc}`]))).toc, [[['toc-level-1', 'Old', '#old']]]);

      // 画像（C5）。
      const images = await inspect(await merge([['<img alt="embedded" src="data:image/png;base64,AAAA" data-original-src="figure.png">',
        '<img alt="embedded-raw" src="data:image/png;base64,BBBB">', '<img alt="failed" src="missing.png" data-original-src="missing.png">',
        '<img alt="failed-raw" src="sub/missing.png">', '<img alt="failed-absolute" src="C:/images/x.png">',
        '<img alt="failed-file" src="file:///tmp/x.png" data-original-src="file:///tmp/x.png">',
        '<img alt="remote" src="https://example.com/x.png" data-original-src="https://example.com/x.png">', '<img alt="http" src="http://example.com/x.png">',
        '<img alt="blob" src="blob:https://example.com/1">', '<img alt="protocol" src="//example.com/x.png">', '<img alt="fragment" src="#x">', '<img alt="nosrc">'].join('')]));
      assert.deepEqual(images.images, [['embedded', 'data:image/png;base64,AAAA', null], ['embedded-raw', 'data:image/png;base64,BBBB', null],
        ['failed', 'missing.png', '#'], ['failed-raw', 'sub/missing.png', '#'], ['failed-absolute', 'C:/images/x.png', '#'], ['failed-file', 'file:///tmp/x.png', '#'],
        ['remote', 'https://example.com/x.png', 'https://example.com/x.png'], ['http', 'http://example.com/x.png', null], ['blob', 'blob:https://example.com/1', null],
        ['protocol', '//example.com/x.png', null], ['fragment', '#x', null], ['nosrc', null, null]]);

      // 改ページ（C6）。中身のない文書は含めず、文言は属性として安全に書く（属性値の < > のエスケープは Chromium の版で違うため DOM で比べる）。
      for (const blank of ['', '  \n ', '<div class="markdown-source-block">\n</div>', '<!-- note -->', '<p> </p>']) {
        assert.equal(await merge(['<p>A</p>', blank, '<p>B</p>']), '<p>A</p><div class="page-break" aria-label=""></div><p>B</p>', JSON.stringify(blank));
        assert.equal(await merge([blank, '<p>B</p>']), '<p>B</p>');
        assert.equal(await merge(['<p>A</p>', blank]), '<p>A</p>');
      }
      for (const visible of ['<img src="data:image/png;base64,AAAA" alt="">', '<hr>', '<table><tbody><tr><td></td></tr></tbody></table>', '<svg></svg>']) {
        assert.equal((await inspect(await merge(['<p>A</p>', visible]))).breaks, 1, visible);
      }
      assert.deepEqual((await inspect(await merge(['<p>A</p>', '<p>B</p>'], 'Page "break" <&>'))).children,
        [['P', '', null], ['DIV', 'page-break', 'Page "break" <&>'], ['P', '', null]]);

      // 無害化（C7）。閉じていない<math>…<style>は後続の行を飲み込むため最後に置く。
      const hostile = ['# Hostile', '', '`<script>` in code', '', '<script>window.bad = 1</script>', '', '<img src="x" onerror="window.bad = 2">', '',
        '[js](javascript:alert(1))', '', '<a href="javascript:alert(2)">raw js</a>', '', '<svg onload="window.bad = 3"><circle r="1"/></svg>', '',
        '<iframe src="https://example.com"></iframe>', '', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>', '',
        '<details open ontoggle="window.bad = 4"><summary>s</summary>d</details>', '', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>', ''].join('\n');
      const rendered = [await render(hostile), await render(hostile.replace('# Hostile', '# Hostile again'))];
      const merged = await merge(rendered);
      const facts = await page.evaluate(([markup, inputs]) => {
        const parse = (html) => { const template = document.createElement('template'); template.innerHTML = html; return template.content; };
        const root = parse(markup);
        const tags = (fragment) => new Set([...fragment.querySelectorAll('*')].map((element) => element.tagName.toLowerCase()));
        const allowed = new Set([...inputs.flatMap((html) => [...tags(parse(html))]), 'div']);
        return {
          scripts: root.querySelectorAll('script, iframe').length,
          handlers: [...root.querySelectorAll('*')].flatMap((element) => [...element.attributes].map((attribute) => attribute.name)).filter((name) => /^on/i.test(name)),
          javascript: [...root.querySelectorAll('[href], [src]')].filter((element) => /^\s*javascript:/i.test(element.getAttribute('href') ?? element.getAttribute('src') ?? '')).length,
          extra: [...tags(root)].filter((tag) => !allowed.has(tag)),
        };
      }, [merged, rendered]);
      assert.deepEqual(facts, { scripts: 0, handlers: [], javascript: 0, extra: [] });
      assert.match(merged, /&lt;script&gt;/);

      // 1文書だけなら描画器の出力が変わらない（C8）。
      for (const name of ['book/04-links/links.md', 'book/06-mixed.md', 'book/03-diagrams.md', 'book/10-names/外部 文書 #1.md']) {
        const html = await render(BOOK_FILES[name]);
        assert.equal(await merge([html]), html, name);
      }
      assert.equal(await merge([await render(BOOK_FILES['book/08-empty.md'])]), '');

      // 性能（C9）。同じ文書内の同名の見出し（40個）は単独の変換と同じく同じ ID のまま。
      const sections = Array.from({ length: 40 }, () => '<h2 id="s" data-mve-heading="true">S</h2><p><a href="#s">s</a></p>').join('');
      const many = Array.from({ length: 300 }, (_, index) => `<h1 id="doc" data-mve-heading="true">Doc ${index}</h1>${index === 0 ? '<nav class="table-of-contents"><ul></ul></nav>' : ''}${sections}`
        + '<p><sup class="footnote-ref"><a href="#fn-1" id="fnref-1-1">1</a></sup></p><section class="footnotes"><ol><li id="fn-1">n</li></ol></section>');
      const started = performance.now();
      const big = await inspect(await merge(many));
      const elapsed = performance.now() - started;
      assert.equal(big.ids.length, 300 * 43);
      assert.equal(new Set(big.ids).size, 300 * 4);
      assert.equal(big.toc[0].length, 300 * 41);
      assert.equal(big.breaks, 299);
      assert.ok(elapsed < 15_000, `merging 300 documents took ${elapsed} ms`);
    } finally {
      await browser.close();
    }
  });

  /**
   * サンプルの本（11章）を DOCX へ結合し、1回の変換の結果で次を確かめる。
   * 見出しの並び・しおりの一意性、文書間リンクの飛び先（全件）・存在しないしおりを指さないこと・外部リンク、目次の全項目とその飛び先、
   * 各章（中身のない章を除く）と章内の改ページの後が新しいページから始まること、脚注、画像の並び（同名の画像を章の場所から読み、
   * 読めない画像・ワークスペース外ではない外部画像・data URI を正しく扱う）、警告（入力ごとのラベル）、front matter からのタイトル。
   */
  test('the sample book merges into one DOCX with working links and every chapter intact', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      // 本の後ろに、BOM・CRLF・CR だけの改行と、空白・#・%・日本語・絵文字を含むファイル名・ディレクトリ名の文書を足す。
      const encodings = {
        'extra/index.md': '# Index\n\n[bom](%E7%AB%A0%20one/bom.md#crlf-section) [cr](cr.md) [odd](odd%20%23%20%25%20name%20%F0%9F%98%80.md#emoji)\n',
        'extra/章 one/bom.md': '\uFEFF# BOM chapter\r\n\r\n## CRLF section\r\n\r\nText.\r\n',
        'extra/cr.md': '# CR chapter\r\rLine one.\r',
        'extra/odd # % name 😀.md': '# Odd name\n\n## Emoji\n',
      };
      await writeFiles(directory, { ...BOOK_FILES, ...encodings });
      const inputs = [...BOOK, ...Object.keys(encodings)];
      const headings = [...BOOK_HEADINGS, 'Index', 'BOM chapter', 'CRLF section', 'CR chapter', 'Odd name', 'Emoji'];
      // 同じ章の重複指定（同じパス・./ 付き・Windows の大小文字違い）は最初の1回だけ結合する。出力先のディレクトリは作る。
      const duplicates = ['book/00-cover.md', `.${path.sep}book${path.sep}01-basics.md`, ...(process.platform === 'win32' ? ['BOOK/03-DIAGRAMS.MD'] : [])];
      const output = path.join(directory, 'new', 'deep dir', '結合 #1.docx');
      const result = await runOk([...inputs, ...duplicates, '--merge', '-o', output, '--language', 'ja', '--json'], { cwd: directory });
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.results.map((record) => [record.input, record.outputs]), inputs.map((name) => [path.join(directory, name), [output]]));
      const book = readDocx(await readFile(output));
      assert.deepEqual(book.headings.map((heading) => heading.text), headings);
      assert.equal(new Set(book.headings.map((heading) => heading.bookmark)).size, headings.length);
      assert.deepEqual(book.paragraphs.find((paragraph) => paragraph.text.startsWith('bom')).anchors,
        [book.headings[BOOK_HEADINGS.length + 2].bookmark, book.headings[BOOK_HEADINGS.length + 3].bookmark, book.headings[BOOK_HEADINGS.length + 5].bookmark]);
      assert.ok(!book.body.some((text) => /\uFEFF/.test(text)));
      const bookmark = (index) => book.headings[index].bookmark;
      for (const [text, targets] of [
        ['基本記法', [3]], ['基本記法の概要', [4]], ['図の章', [15]], ['図の章の概要（./ 付き）', [16]], ['図表の章の概要', [18]], ['リンクの章', [19]],
        ['Textile の章の概要', [23]], ['混在記法の章', [24]], ['スライドの章', [27]], ['記号を含む名前の章', [29]], ['空の章', []], ['front matter だけの章', []],
        ['結合しない文書', []], ['テキストファイル', []], ['Web', []], ['メール', []], ['明示 ID へ、同じ文書の概要へ。', [13, 4]], ['基本記法の概要へ戻る', [4]],
        ['リンク', [4]], ['表紙へ', [0]], ['表紙の概要へ', [2]], ['エンコードした断片', [4]], ['クエリ付き', [4]], ['明示 ID', [13]], ['Setext 見出し', [12]],
        ['存在しない断片', []], ['Textile の章', [22]], ['自分の概要', [20]], ['自分の2つ目の概要', [21]], ['自分自身のファイル', [20]], ['結合しない文書の断片', []],
        ['ディレクトリ', []], ['不正なエスケープ', []], ['基本記法の概要へ', [4]], ['表紙の使い方へ', [1]],
      ]) {
        // 見出しや目次と同じ文字列の段落があるため除き、同じ文字列のリンクが複数あれば全部が同じ飛び先であることを求める。
        const found = book.paragraphs.filter((paragraph) => paragraph.text === text && !/^(?:TOC|Heading)/.test(paragraph.style ?? ''));
        assert.ok(found.length >= 1, `paragraph ${text}`);
        for (const paragraph of found) assert.deepEqual(paragraph.anchors, targets.map(bookmark), text);
      }
      for (const paragraph of book.paragraphs) for (const anchor of paragraph.anchors) assert.ok(book.bookmarks.has(anchor), `dangling ${anchor}`);
      const rels = book.parts.get('word/_rels/document.xml.rels').toString('utf8');
      assert.match(rels, /Target="https:\/\/example\.com\/" TargetMode="External"/);
      assert.match(rels, /Target="mailto:test@example\.com" TargetMode="External"/);
      assert.doesNotMatch(rels, /not-merged|notes\.txt|javascript/);
      const toc = book.paragraphs.filter((paragraph) => /^TOC\d$/.test(paragraph.style ?? ''));
      assert.equal(toc.length, headings.length);
      toc.forEach((entry, index) => {
        if (index === 10) assert.match(entry.text, /^見出しに .+ と code を含む$/);
        else assert.equal(entry.text, headings[index], `toc ${index}`);
        assert.deepEqual(entry.anchors, [bookmark(index)], `toc ${index}`);
      });
      assert.deepEqual(book.paragraphs.filter((paragraph) => paragraph.style === 'TOCHeading').map((paragraph) => paragraph.text), ['目次']);
      assert.deepEqual(book.paragraphs.filter((paragraph) => paragraph.pageBreak).map((paragraph) => paragraph.text),
        ['基本記法', '改ページの後', '図の章', '図表', 'リンクの章', 'Textile の章', '混在記法の章', 'スライド1', '記号を含む名前の章',
          'Index', 'BOM chapter', 'CR chapter', 'Odd name']);
      // Markdown の脚注は Word の脚注になる。Textile の脚注（fn1.）は単独の変換と同じく本文の段落として残る。
      assert.deepEqual(book.footnotes.slice().sort(), ['名前付きの脚注。', '基本記法の脚注1。', '表紙の脚注。', '見出しの脚注。'].sort());
      assert.ok(book.body.some((text) => text.includes('Textile の脚注本文。')), 'the Textile footnote stays in the body');
      const files = BOOK_FILES;
      const yellow = files['book/figure.png'];
      const red = files['book/02-figures/figure.png'];
      assertImages(book.media, [yellow, red, files['book/02-figures/figure.jpg'], files['book/02-figures/figure.gif'], RASTER, RASTER,
        files['book/02-figures/my figure.png'], files['book/02-figures/my figure.png'], files['book/02-figures/図.png'], files['outside/secret.png'],
        redPng, red, red, RASTER, yellow, yellow], [...Object.values(files).filter(Buffer.isBuffer), redPng]);
      const label = (name) => `${path.join(directory, 'book', name)}: `;
      // 文書に結び付く警告はその入力の記録へ、DOCX の生成中の警告（文書を特定できない）は先頭の入力の記録へ入る。
      const recorded = (name) => report.results.find((record) => record.input === path.join(directory, 'book', name)).warnings;
      assert.equal(recorded('02-figures/chapter.md').length, 2);
      assert.equal(recorded('00-cover.md').length, 2);
      assert.deepEqual(result.stderr.split(/\r?\n/).filter(Boolean).sort(), [
        `${label('02-figures/chapter.md')}Local file "missing.png" could not be read.`,
        `${label('02-figures/chapter.md')}Local file "not-image.png" was not embedded because it is not a supported image type.`,
        `${label('03-diagrams.md')}Mermaid diagram 2 could not be rendered (Mermaid diagram could not be rendered.); an error message was embedded instead.`,
        `${label('07-marp.md')}Marp slides were merged as a regular document.`,
        'An image could not be loaded and was replaced by its alternative text: missing.png',
        'An image could not be loaded and was replaced by its alternative text: not-image.png',
      ].sort());
      assert.ok(!book.body.some((text) => /mveInjected|title: 結合テスト/.test(text)));
      assert.equal(book.title, '結合テスト総合マニュアル');
    });
  });

  /**
   * サンプルの本を PDF へ結合し、しおりが全章の見出しを順に並べ、各章が前の章より後のページから始まり、
   * 章の中の<!-- pagebreak -->の後も新しいページになり、タイトルと用紙が先頭の章の設定になることを確かめる。
   */
  test('the sample book merges into one PDF with every chapter on its own pages', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      await writeFiles(directory, BOOK_FILES);
      // ワイルドカードはパスの順に展開され、本の章の順（00〜10）と一致する。結合した PDF だけを標準出力へ書き、警告は標準エラーへ出す。
      const result = await runOk(['book/**/*', '--merge', '--format', 'pdf', '-o', '-'], { cwd: directory });
      assert.equal(result.bytes.toString('latin1', 0, 5), '%PDF-');
      assert.match(result.stderr, /02-figures[\\/]chapter\.md: Local file "missing\.png" could not be read\./);
      const book = readPdf(result.bytes);
      assert.equal(book.title, '結合テスト総合マニュアル');
      assertPageSize(book.size, [595.92, 842.88], 'A4');
      assert.equal(book.outline.length, BOOK_HEADINGS.length);
      book.outline.forEach((item, index) => {
        // しおりは Chromium が見出しの文字列から作るため、数式は空になり、脚注参照の記号（[^h] の h）は文字列に続く（単独の変換と同じ）。
        if (index === 10) assert.match(item.title, /^見出しに .* と code を含む$/);
        else if (index === 11) assert.equal(item.title, '脚注付きの見出しh');
        else assert.equal(item.title, BOOK_HEADINGS[index], `outline ${index}`);
      });
      for (const [position, start] of CHAPTER_STARTS.entries()) {
        if (position === 0) continue;
        assert.ok(book.outline[start].page > book.outline[start - 1].page, `${BOOK_HEADINGS[start]} starts a new page`);
      }
      assert.ok(book.outline[14].page > book.outline[13].page, 'the page break inside a chapter starts a new page');
      assert.equal(book.pages, book.outline.at(-1).page, 'no blank page follows the last chapter');
    });
  });

  /**
   * 結合した出力全体にかかる設定と、文書ごとの画像の扱いを、1回の変換でまとめて確かめる。
   * ページ設定: 設定ファイル（A5）と先頭の文書の front matter（横向き）から取り、2件目以降の front matter の設定（B5）は警告して無視する。
   * front matter: 2件目以降の title は使わず（タイトルは最初の H1）、YAML の対応付けでない先頭のブロックは本文に残す。
   * 出力全体: 出力置換が全文書の本文・表・タイトル・ヘッダーへ効き、ヘッダーの差し込み文字が結合後のタイトル・先頭の文書の名前・日付になり、
   *   フッターはページ番号のフィールドになる。--css と --language が効く。
   * 失敗: 図と数式の失敗では結合を止めずにその文書の警告にし、--strict では終了コード1だが出力は書く。
   * 画像: 同じ名前の画像（PNG・JPEG・GIF・WebP・SVG）を各文書の場所から読んで取り違えず、--restrict-local-files の基準は文書ごとの
   *   ディレクトリになり（2件目にしかない参照先が1件目の場所にあっても読まず、ワークスペース外の画像を読まない）、警告はその文書の記録へ入る。
   *   リモート画像は各文書から取得する。
   */
  test('one merge applies page settings, front matter, replacements, CSS, language, --strict, and per-document images', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      await withImageServer(async (base, requests) => {
        await writeFiles(directory, {
          ...imageDocuments(base, false),
          'first.md': '---\nmve-convert:\n  pdf:\n    orientation: landscape\n---\n# SECRET handbook\n\n[toc]\n\nSECRET in the first document. Broken $\\frac{1}{$ math.\n',
          'second.md': '---\nmve-convert:\n  pdf:\n    format: B5\n---\n# Second\n\nSECRET in the second document.\n\n| SECRET |\n| --- |\n| cell SECRET |\n\n'
            + '```mermaid\ngraph TD\n  A -->\n```\n\n```mermaid\ngraph TD\n  A --> B\n```\n',
          'titled.md': '---\ntitle: Second title\n---\n# Third heading\n',
          'list.md': '---\n- item one\n- item two\n---\n# List front matter\n',
          'export.json': JSON.stringify({ pdf: { format: 'A5', header: '{title}|{file}|{date}', footer: '{page}/{pages}',
            textReplacements: [{ pattern: 'SECRET', replacement: 'public' }] } }),
          'red.css': '.mve-print h1, h1 { color: rgb(200, 0, 0) !important; }\n',
        });
        const result = await run(['first.md', 'second.md', 'titled.md', 'list.md', 'docs/a/doc.md', 'docs/b/doc.md', '--merge', '-o', 'out.docx',
          '--config', 'export.json', '--css', 'red.css', '--language', 'de', '--strict', '--json', '--restrict-local-files'], { cwd: directory });
        assert.equal(result.code, 1, result.stderr);
        assert.match(result.stderr, /warning\(s\) treated as errors by --strict/);
        const report = JSON.parse(result.stdout);
        const recorded = (name) => report.results.find((record) => record.input === path.join(directory, name)).warnings;
        assert.ok(report.results.every((record) => record.outputs[0] === path.join(directory, 'out.docx')));
        assert.deepEqual(recorded('second.md').filter((warning) => /settings were ignored/.test(warning)).length, 1);
        assert.ok(recorded('second.md').some((warning) => /Mermaid diagram 1 could not be rendered/.test(warning)));
        assert.ok(recorded('docs/b/doc.md').some((warning) => /only-in-a\.png/.test(warning)), recorded('docs/b/doc.md').join('\n'));
        assert.ok(recorded('docs/b/doc.md').some((warning) => /outside\.png.*outside the workspace root/.test(warning)));
        assert.ok(!recorded('docs/a/doc.md').some((warning) => /Local file/.test(warning)));
        assert.ok(!['titled.md', 'list.md'].some((name) => recorded(name).length), 'documents without problems have no warnings');
        assert.ok(requests.some((url) => url.startsWith('/red.png')) && requests.some((url) => url.startsWith('/blue.png')), requests.join(', '));

        const docx = readDocx(await readFile(path.join(directory, 'out.docx')));
        assert.deepEqual(docx.headings.map((heading) => heading.text), ['public handbook', 'Second', 'Third heading', 'List front matter', 'A', 'B']);
        assert.match(docx.document, /<w:pgSz w:w="11906" w:h="8391" w:orient="landscape"\/>/);
        assert.equal(docx.title, 'public handbook');
        assert.ok(!docx.body.some((text) => /SECRET|Second title/.test(text)), docx.body.join(' | '));
        assert.ok(['public in the second document.', 'cell public', 'item one', 'item two'].every((text) => docx.body.includes(text)), docx.body.join(' | '));
        const header = (docx.parts.get('word/header1.xml').toString('utf8').match(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g) ?? []).map((text) => text.replace(/<[^>]+>/g, '')).join('');
        assert.match(header, /^public handbook\|first\.md\|\d{4}-\d{2}-\d{2}$/);
        assert.match(docx.parts.get('word/footer1.xml').toString('utf8'), /PAGE[\s\S]*NUMPAGES/);
        assert.deepEqual(docx.paragraphs.filter((paragraph) => paragraph.style === 'TOCHeading').map((paragraph) => paragraph.text), ['Inhaltsverzeichnis']);
        assert.match(docx.parts.get('word/styles.xml').toString('utf8'), /w:styleId="Heading1"[\s\S]*?w:color w:val="C80000"/);
        // 先頭は正常な図の画面写真。続いて a（赤の PNG・JPEG・GIF・WebP・SVG・リモートの赤）と b（青の PNG・…・リモートの青）。
        const figures = (name) => BOOK_FILES[`book/02-figures/${name}`];
        assertImages(docx.media, [RASTER, figures('figure.png'), figures('figure.jpg'), figures('figure.gif'), RASTER, RASTER, RASTER,
          bluePng, figures('figure.jpg'), figures('figure.gif'), RASTER, RASTER, RASTER], IMAGE_SOURCES);
      });
    });
  });

  /**
   * 失敗の経路を、互いに独立した変換を並列に実行して確かめる。どの場合も結合先を書かない。
   * 2件目の front matter の誤記（終了コード2、原因の文書のパス、--json の全入力に同じエラー）、
   * 生成のタイムアウトとブラウザーの起動失敗（終了コード1）、出力先の衝突（既存・入力と同じ・ハードリンク、--force でも入力は守る）。
   * ブラウザーを使うのは front matter の誤記とタイムアウトの2回だけで、どちらも生成の前後で速やかに止まる。
   */
  test('merge failures write nothing', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      await writeFiles(directory, {
        'a.md': '# A\n', 'b.md': '# B\n\n![missing](missing.png)\n', 'bad.md': '---\nmve-convert:\n  pdf:\n    format: Letter\n---\n# Bad\n', 'exists.pdf': 'sentinel',
      });
      await link(path.join(directory, 'a.md'), path.join(directory, 'alias.pdf')).catch(() => undefined);
      const [bad, timeout, browser, ...collisions] = await Promise.all([
        run(['a.md', 'bad.md', '--merge', '-o', 'bad.pdf', '--json'], { cwd: directory }),
        run(['a.md', 'b.md', '--merge', '-o', 'timeout.pdf', '--render-timeout', '0.001'], { cwd: directory }),
        runWithoutBrowser(['a.md', 'b.md', '--merge', '-o', 'browser.docx', '--browser', path.join(directory, 'no-such-browser.exe'), '--browser-timeout', '5'], { cwd: directory }),
        runWithoutBrowser(['a.md', 'b.md', '--merge', '-o', 'exists.pdf'], { cwd: directory }),
        runWithoutBrowser(['a.md', 'b.md', '--merge', '--format', 'pdf', '-o', 'b.md', '--force'], { cwd: directory }),
        runWithoutBrowser(['a.md', 'b.md', '--merge', '-o', 'alias.pdf', '--force'], { cwd: directory }),
        ...(process.platform === 'win32' ? [runWithoutBrowser(['a.md', 'b.md', '--merge', '--format', 'pdf', '-o', 'B.MD', '--force'], { cwd: directory })] : []),
      ]);
      assert.equal(bad.code, 2, bad.stderr);
      assert.ok(bad.stderr.startsWith(`${path.join(directory, 'bad.md')}: Invalid front matter mve-convert: Invalid pdf.format.`), bad.stderr);
      const report = JSON.parse(bad.stdout);
      assert.equal(report.results.length, 2);
      assert.ok(report.results.every((record) => record.outputs.length === 0 && /bad\.md: Invalid front matter/.test(record.error)));
      assert.equal(timeout.code, 1, timeout.stderr);
      assert.equal(browser.code, 1, browser.stderr);
      assert.match(collisions[0].stderr, /Output already exists/);
      for (const result of collisions) {
        assert.equal(result.code, 1, result.stderr);
        if (result !== collisions[0]) assert.match(result.stderr, /Output must differ from input/);
      }
      assert.equal(await readFile(path.join(directory, 'exists.pdf'), 'utf8'), 'sentinel');
      assert.equal(await readFile(path.join(directory, 'a.md'), 'utf8'), '# A\n');
      assert.equal(await readFile(path.join(directory, 'b.md'), 'utf8'), '# B\n\n![missing](missing.png)\n');
      for (const name of ['bad.pdf', 'timeout.pdf', 'browser.docx']) await assert.rejects(readFile(path.join(directory, name)), { code: 'ENOENT' }, name);
    });
  });

  /**
   * 中断（Ctrl+C）と監視（--watch）を確かめる。結合の途中の中断は130で速やかに終わり、何も書かず、--json に全入力の中断を記録する。
   * --watch はどの入力が変わっても全入力から作り直し、途中の失敗でも監視を続けて回復後に作り直す（2回目以降は自分が書いた結合先を
   * --force なしで上書きする）。Windows では子プロセスへ SIGINT を送れないため、読み込み前のスクリプトで SIGINT を発生させる。
   */
  test('interrupts and --watch with --merge', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      const stop = path.join(directory, 'stop');
      await writeFiles(directory, {
        'a.md': '# Alpha\n', 'b.md': '# Beta first\n', 'c.md': '# C\n\n```mermaid\ngraph TD\n  A --> B\n```\n', 'existing.docx': 'sentinel',
        'interrupt.cjs': ['const original = globalThis.setTimeout;', 'let fired = false;', 'globalThis.setTimeout = function (callback, delay, ...rest) {',
          "  if (delay === 180000 && !fired) { fired = true; original(() => process.emit('SIGINT'), 0); }", '  return original(callback, delay, ...rest);', '};', ''].join('\n'),
        'stop.cjs': ["const fs = require('node:fs');",
          `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) { clearInterval(timer); process.emit('SIGINT'); } }, 50);`, 'timer.unref();', ''].join('\n'),
      });
      const interrupted = run(['a.md', 'c.md', '--merge', '-o', 'interrupted.pdf', '--json'], { cwd: directory, node: ['--require', path.join(directory, 'interrupt.cjs')] });
      /** 監視を始め、出力を集める。 */
      const watch = (output) => {
        const child = spawn(process.execPath, ['--require', path.join(directory, 'stop.cjs'), cli, 'a.md', 'b.md', '--merge', '-o', output, '--watch',
          '--browser', browserPath, '--browser-timeout', '30'], { cwd: directory });
        const state = { stdout: '', stderr: '' };
        child.stdout.on('data', (chunk) => { state.stdout += chunk; });
        child.stderr.on('data', (chunk) => { state.stderr += chunk; });
        return { state, exited: new Promise((resolve) => child.on('exit', (code) => resolve(code))), describe: () => `stdout: ${state.stdout}\nstderr: ${state.stderr}` };
      };
      const output = path.join(directory, 'book.docx');
      const headings = async () => readDocx(await readFile(output)).headings.map((heading) => heading.text);
      const main = watch(output);
      try {
        await waitFor(() => /Watching 2 file\(s\)/.test(main.state.stderr), 'the watcher to start', main.describe);
        assert.deepEqual(await headings(), ['Alpha', 'Beta first']);
        // a を壊すと失敗を報告して前回の出力を保ち、監視を続ける。その間に b を変え、a を直すと、両方の変更を含めて全入力から作り直す。
        await writeFile(path.join(directory, 'a.md'), '---\nmve-convert:\n  pdf:\n    format: Letter\n---\n# Alpha broken\n');
        await waitFor(() => /a\.md: Invalid front matter/.test(main.state.stderr), 'the failure to be reported', main.describe);
        assert.deepEqual(await headings(), ['Alpha', 'Beta first'], 'the previous output is kept');
        await writeFile(path.join(directory, 'b.md'), '# Beta second\n');
        await writeFile(path.join(directory, 'a.md'), '# Alpha fixed\n');
        await waitFor(() => main.state.stdout.split(output).length - 1 >= 2, 'a rebuild after the fix', main.describe);
        assert.deepEqual(await headings(), ['Alpha fixed', 'Beta second']);
      } finally {
        await writeFile(stop, '');
      }
      assert.equal(await main.exited, 130, main.state.stderr);
      const result = await interrupted;
      assert.equal(result.code, 130, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).results.map((record) => [path.basename(record.input), record.outputs, record.error]),
        [['a.md', [], 'Conversion was interrupted.'], ['c.md', [], 'Conversion was interrupted.']]);
      await assert.rejects(readFile(path.join(directory, 'interrupted.pdf')), { code: 'ENOENT' });
    });
  });

});
