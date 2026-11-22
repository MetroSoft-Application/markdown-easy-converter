/**
 * @fileoverview `--merge`（複数の文書を1つのPDF/DOCXへまとめる）を網羅的に検証する。
 * 実行境界: Node（node:test）。CLIの成果物 dist/mve-convert.cjs を子プロセスで実行し、描画にはテスト用ブラウザーを使う。
 * 構成:
 * - A: 引数の検証（ブラウザー不要）。B: 文書間リンクの解決（Node、成果物が再公開する`resolveMergedLinks`）。
 * - C: 結合の規則（成果物が再公開する`mergeRenderedDocuments`をブラウザーで直接実行）。
 * - D〜O: サンプルの「本」（11章、`BOOK_FILES`を実行時に書き出す）と、テストごとの最小の文書による PDF/DOCX の実出力の検証。
 *   DOCXは本文・しおり・リンク・脚注・画像がXMLで読めるため構造の検証に、PDFはしおり・ページ数・用紙の検証に使う。
 *   各章を単独で変換した結果の合計と結合結果を比べ、結合で内容が欠けたり入れ替わったりしないことを確かめる。
 * 回帰リスク: 見出し・脚注の ID の衝突による飛び先の誤り、文書間リンクの切れ・誤った飛び先、別の文書の場所からの画像の誤読、
 * 空の文書による白紙、1件の失敗での部分的な書き込み、`--json`・`--strict`・`--watch`・中断との組み合わせの破れ、
 * 単一文書の出力への影響、無害化の破れ、文書数が多い場合の性能。
 * ブラウザー必須の公開ゲート（MVE_REQUIRE_BROWSER_TESTS=1）では描画テストのスキップを許さない。
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { inflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { findTestBrowser } from './browser.mjs';

/** CLI成果物はテストの配置から解決し、呼び出し側の作業ディレクトリに依存しない。 */
const cli = fileURLToPath(new URL('../dist/mve-convert.cjs', import.meta.url));
/** 描画器の成果物。結合規則の単体検証で、実際の描画結果を作るために使う。 */
const renderer = fileURLToPath(new URL('../dist/markdown-fallback.js', import.meta.url));
/**
 * サンプルの本（book/）と、本の外に置くファイル（extras/ の結合しない文書、outside/ のアクセス制限の対象の画像）。
 * リポジトリにファイルとして置かず、テストの実行時に一時ディレクトリへ書き出す（`copyFixtures`）。
 * 記法の全要素、画像の全形式（同名ファイルを別のディレクトリに置いて取り違えを検出する）、リンクの全形式、同名の見出し・脚注、
 * Textile・混在記法・Marp・空の文書・front matter だけの文書・記号を含むファイル名を含む。
 * 画像は 8x8 の単色で、色で取り違えを見分ける（book/figure.png は黄、02-figures は赤・青・緑・紫・橙など）。
 */
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
    '### 数式', '', 'インライン $E = mc^2$ と別行立て:', '', '$$', '\\int_0^1 x\\,dx = \\frac{1}{2}', '$$', '',
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
    '```mermaid', 'sequenceDiagram', '  Alice->>Bob: こんにちは', '  Bob-->>Alice: やあ', '```', '',
    '```mermaid', 'classDiagram', '  class Animal {', '    +name: string', '  }', '  Animal <|-- Dog', '```', '',
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
    '|_. 見出し |_. 値 |', '| a | 1 |', '| b | 2 |', '', 'bq. Textile の引用。', '', '"基本記法の概要へ":../01-basics.md#概要', '',
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
/** 子プロセスの終了コードと出力を取得するためのPromise版。 */
const execute = promisify(execFile);
/** CLIの再公開した関数をパッケージ成果物から読み込む。 */
const require = createRequire(import.meta.url);
/** 描画に使用するブラウザー。 */
const browserPath = findTestBrowser();
if (process.env.MVE_REQUIRE_BROWSER_TESTS === '1' && !browserPath) {
  throw new Error('Browser tests are required, but no Chromium/Edge/Chrome executable was found.');
}
/** ブラウザーを使うテストの共通設定。 */
const needsBrowser = { skip: !browserPath };

/** サンプルの本の章（結合する順）。`copyFixtures`で書き出したディレクトリからの相対パス。 */
const BOOK = [
  '00-cover.md', '01-basics.md', '02-figures/chapter.md', '03-diagrams.md', '04-links/links.md', '05-textile.textile',
  '06-mixed.md', '07-marp.md', '08-empty.md', '09-front-matter-only.md', '10-names/外部 文書 #1.md'
].map((name) => path.join('book', name));

/** 結合した本の見出し（DOCXの見出しの段落の文字列、文書の順）。数式は OMML になり w:t に現れないため空白が残る。 */
const BOOK_HEADINGS = [
  '表紙', 'この本の使い方', '概要',
  '基本記法', '概要', 'リスト', '表', '引用と注意書き', 'コード', '数式', '見出しに  と code を含む', '脚注付きの見出し',
  'Setext 見出し', '明示 ID', '改ページの後',
  '図の章', '概要',
  '図表', '概要',
  'リンクの章', '概要', '概要',
  'Textile の章', '概要',
  '混在記法の章', 'Textile 記法の見出し', '概要',
  'スライド1', 'スライド2',
  '記号を含む名前の章', '概要'
];

/** 赤・青の1x1 PNG。文書ごとの画像の取り違えを、中身で見分けるために使う。 */
const redPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const bluePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC', 'base64');
/** 緑の1x1 PNG。先頭の文書の場所にだけ置き、2件目の文書から誤って読まれないことの確認に使う。 */
const greenPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgWMAAAAFEAKH5ZOq+AAAAAElFTkSuQmCC', 'base64');

/**
 * 意図した入力だけを用いる一時ディレクトリを作り、テスト終了後に解放する。
 * @param {(directory: string) => Promise<void>} callback - 一時ディレクトリ内で実行する検証。
 */
async function withDirectory(callback) {
  // macOS の一時ディレクトリ（/var/...）は /private/var/... へのシンボリックリンクで、CLI は作業ディレクトリの実体のパスで
  // 入力を解決する。結果のパスと比べられるよう、実体のパスを渡す。
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'mve-merge-test-')));
  try {
    await callback(directory);
  } finally {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(directory));
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative), 'refusing to remove a path outside the temp directory');
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * サンプルの本（`BOOK_FILES`）を一時ディレクトリへ書き出す。
 * @param {string} directory - 書き出し先。`book/`・`extras/`・`outside/`ができる。
 */
async function copyFixtures(directory) {
  await writeFiles(directory, BOOK_FILES);
}

/**
 * 一時ディレクトリへ複数のファイルを書く。親ディレクトリは作る。
 * @param {string} directory - 基準ディレクトリ。
 * @param {Record<string, string | Buffer>} files - 相対パスから内容への対応。
 */
async function writeFiles(directory, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

/**
 * CLIを実行し、失敗しても終了コードと出力を返す。ブラウザー起動の待ち時間は、CIの初回起動の遅さで失敗しないよう30秒にする。
 * @param {string[]} args - CLIの引数。
 * @param {{cwd?: string, browser?: boolean, node?: string[]}} [options] - 作業ディレクトリ、ブラウザー引数を付けるか（既定は付ける）、
 *   Node へ渡す追加の引数（`--require`など）。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} 終了コードと出力。
 */
async function run(args, options = {}) {
  const browserArgs = options.browser === false ? [] : ['--browser', browserPath, '--browser-timeout', '30'];
  try {
    const result = await execute(process.execPath, [...(options.node ?? []), cli, ...args, ...browserArgs],
      { cwd: options.cwd, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

/**
 * CLIを実行し、標準出力をバイト列のまま受け取る（PDF/DOCXを標準出力へ書く場合）。
 * @param {string[]} args - CLIの引数（ブラウザー引数は自動で付ける）。
 * @param {string} cwd - 作業ディレクトリ。
 * @returns {Promise<{code: number, stdout: Buffer, stderr: string}>} 終了コードと出力。
 */
function runBinary(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, '--browser', browserPath, '--browser-timeout', '30'], { cwd });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(chunks), stderr }));
  });
}

/** 標準エラーを行に分ける（空行を除く）。 */
function lines(text) {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

/**
 * 結合の標準エラーの行から、先頭に付く入力のパス（`<絶対パス>: `）を除く。単独の変換の警告と比べるため。
 * @param {string} line - 標準エラーの1行。
 * @param {string[]} inputs - 結合した入力の絶対パス。
 * @returns {string} 入力のパスを除いた警告。
 */
function stripInputLabel(line, inputs) {
  const input = inputs.find((candidate) => line.startsWith(`${candidate}: `));
  return input ? line.slice(input.length + 2) : line;
}

/**
 * ZIPの中央ディレクトリを読み、各エントリーを展開する。CLIが書くDOCX（ZIP64なし）だけを対象にする。
 * @param {Buffer} zip - DOCXのバイト列。
 * @returns {Map<string, Buffer>} パス名から内容への対応。
 */
function readZip(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4B, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of central directory is missing');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const body = zip.subarray(start, start + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** XMLの文字参照を戻す。DOCXの本文の文字列を比較するため。 */
function decodeXml(value) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * DOCXのパッケージを、検証に使う形へ分解する。
 * @param {Buffer} bytes - DOCXのバイト列。
 * @returns {{parts: Map<string, Buffer>, paragraphs: {text: string, bookmarks: string[], anchors: string[], pageBreak: boolean, style: string | undefined}[],
 *   headings: {text: string, bookmark: string | undefined}[], bookmarks: Set<string>, media: string[], footnotes: string[], body: string[]}}
 *   パーツ、段落、見出し、しおり名、画像の中身のハッシュ（文書の順）、脚注の文字列、目次と空の段落を除いた本文の段落の文字列。
 */
function readDocx(bytes) {
  const parts = readZip(bytes);
  const xml = parts.get('word/document.xml').toString('utf8');
  const paragraphs = [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map(([paragraph]) => ({
    text: decodeXml([...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join('')),
    bookmarks: [...paragraph.matchAll(/<w:bookmarkStart\b[^>]*w:name="([^"]+)"/g)].map((match) => match[1]),
    anchors: [...paragraph.matchAll(/w:anchor="([^"]+)"/g)].map((match) => match[1]),
    pageBreak: paragraph.includes('<w:pageBreakBefore/>'),
    style: /<w:pStyle w:val="([^"]+)"/.exec(paragraph)?.[1]
  }));
  const headings = paragraphs.filter((paragraph) => /^Heading\d$/.test(paragraph.style ?? ''))
    .map((paragraph) => ({ text: paragraph.text, bookmark: paragraph.bookmarks.find((name) => /^_mve\d+$/.test(name)) }));
  // 画像は本文の参照順（r:embed の順）に並べる。ファイル名の番号は出現順に振られるが、念のため参照から引く。
  const rels = parts.get('word/_rels/document.xml.rels').toString('utf8');
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((match) => [match[1], match[2]]));
  const media = [...xml.matchAll(/r:embed="([^"]+)"/g)].map((match) => {
    const data = parts.get(`word/${targets.get(match[1])}`);
    return createHash('sha256').update(data).digest('hex').slice(0, 16);
  });
  const footnotesXml = parts.get('word/footnotes.xml')?.toString('utf8') ?? '';
  const footnotes = [...footnotesXml.matchAll(/<w:footnote\b[^>]*>([\s\S]*?)<\/w:footnote>/g)]
    .map((match) => decodeXml([...match[1].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((text) => text[1]).join('')).trim())
    .filter((text) => text !== '');
  const body = paragraphs.filter((paragraph) => !/^TOC/.test(paragraph.style ?? '') && paragraph.text.trim() !== '')
    .map((paragraph) => paragraph.text);
  return {
    parts, paragraphs, headings, media, footnotes, body,
    bookmarks: new Set(paragraphs.flatMap((paragraph) => paragraph.bookmarks))
  };
}

/**
 * PDFの文字列（リテラルまたは16進）を復号する。Chromiumは非ASCIIをUTF-16BEの16進文字列で書く。
 * @param {string | undefined} literal - `(...)`の中身。
 * @param {string | undefined} hex - `<...>`の中身。
 * @returns {string} 文字列。
 */
function decodePdfString(literal, hex) {
  if (literal !== undefined) return literal.replace(/\\([()\\])/g, '$1');
  return Buffer.from(Buffer.from(hex, 'hex').subarray(2)).swap16().toString('utf16le');
}

/**
 * PDFを、しおり（見出しと飛び先のページ）・ページ数・用紙・文書タイトルへ分解する。
 * しおりは`/Outlines`から`/First`・`/Next`をたどり、文書の順に並べる。ページは`/Pages`の`/Kids`の順で番号を振る。
 * @param {Buffer} pdf - PDFのバイト列。
 * @returns {{title: string | undefined, pages: number, size: number[], outline: {title: string, page: number}[]}} 検証に使う値。
 */
function readPdf(pdf) {
  const source = pdf.toString('latin1');
  const objects = new Map([...source.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)].map((match) => [match[1], match[2]]));
  const pagesObject = [...objects.values()].find((body) => /\/Type\s*\/Pages\b/.test(body));
  const kids = [...(/\/Kids\s*\[([^\]]*)\]/.exec(pagesObject ?? '')?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((match) => match[1]);
  const titleOf = (body) => {
    const match = /\/Title\s*(?:\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f]+)>)/.exec(body);
    return match ? decodePdfString(match[1], match[2]) : undefined;
  };
  const outline = [];
  /** しおりの項目を深さ優先でたどる。 */
  const visit = (number) => {
    for (let current = number; current; ) {
      const body = objects.get(current) ?? '';
      const page = /\/Dest\s*\[\s*(\d+) 0 R/.exec(body)?.[1];
      outline.push({ title: titleOf(body), page: kids.indexOf(page) + 1 });
      const first = /\/First\s+(\d+) 0 R/.exec(body)?.[1];
      if (first) visit(first);
      current = /\/Next\s+(\d+) 0 R/.exec(body)?.[1];
    }
  };
  const root = [...objects.values()].find((body) => /\/Type\s*\/Outlines\b/.test(body));
  const first = root && /\/First\s+(\d+) 0 R/.exec(root)?.[1];
  if (first) visit(first);
  const info = [...objects.values()].find((body) => /\/Producer\b/.test(body));
  const box = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(source);
  return {
    title: info ? titleOf(info) : undefined,
    pages: kids.length,
    size: box ? [Number(box[3]) - Number(box[1]), Number(box[4]) - Number(box[2])] : [],
    outline
  };
}

/** 用紙の幅と高さ（ポイント）が期待値と1ポイント以内で一致することを確かめる。 */
function assertPageSize(actual, [width, height], label = '') {
  assert.ok(Math.abs(actual[0] - width) <= 1 && Math.abs(actual[1] - height) <= 1,
    `${label} expected ${width}x${height}pt, received ${actual.join('x')}pt`);
}

/**
 * ブラウザーのページを1つ用意して検証を行い、終了時に閉じる。
 * @param {(page: import('playwright-core').Page) => Promise<void>} callback - 検証。
 * @param {{renderer?: boolean}} [options] - true なら描画器の成果物を読み込む。
 */
async function withPage(callback, options = {}) {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage();
    if (options.renderer) await page.addScriptTag({ path: renderer });
    await callback(page);
  } finally {
    await browser.close();
  }
}

/**
 * 結合した HTML を DOM として読み、検証しやすい値へ分解する（ブラウザー内で実行）。
 * @param {import('playwright-core').Page} page - ブラウザーのページ。
 * @param {string} html - 結合した本文HTML。
 * @returns {Promise<{ids: string[], links: [string, string | null, string | null][], toc: [string, string, string][][], images: [string, string | null, string | null][], breaks: number}>}
 *   SVG外の ID、リンク（文字列・href・data-mve-link）、目次ごとの項目（class・文字列・href）、画像（alt・src・data-original-src）、改ページの数。
 */
function inspect(page, html) {
  return page.evaluate((markup) => {
    const template = document.createElement('template');
    template.innerHTML = markup;
    const root = template.content;
    return {
      ids: [...root.querySelectorAll('[id]')].filter((element) => !element.closest('svg')).map((element) => element.id),
      links: [...root.querySelectorAll('a')].map((anchor) => [anchor.textContent, anchor.getAttribute('href'), anchor.getAttribute('data-mve-link')]),
      toc: [...root.querySelectorAll('nav.table-of-contents')].map((nav) =>
        [...nav.querySelectorAll('li')].map((item) => [item.className, item.textContent, item.querySelector('a').getAttribute('href')])),
      images: [...root.querySelectorAll('img')].map((image) => [image.getAttribute('alt'), image.getAttribute('src'), image.getAttribute('data-original-src')]),
      breaks: root.querySelectorAll('div.page-break').length
    };
  }, html);
}

/**
 * 実際の描画器で Markdown を描画する（ブラウザー内で実行）。結合規則の検証に、本物の描画結果を使うため。
 * @param {import('playwright-core').Page} page - 描画器を読み込んだページ。
 * @param {string} source - Markdown。
 * @param {string} [format] - 描画形式（既定は mixed）。
 * @returns {Promise<string>} 描画結果のHTML。
 */
function render(page, source, format = 'mixed') {
  return page.evaluate(([markdown, renderFormat]) => globalThis.mveMarkdownFallback.renderMarkdown(markdown,
    { remoteImagesEnabled: true, renderFormat, language: 'en' }), [source, format]);
}

// ---------------------------------------------------------------------------------------------------------------
// A: 引数の検証
// ---------------------------------------------------------------------------------------------------------------

/**
 * A1: --merge が、PDF/DOCX をどの指定方法でも受け付け、結合で使える指定（-o・--title・標準出力・複数入力・
 * --watch・--json・--strict・--force）を拒否しないことを検証する。オプションの位置にも依存しない。
 */
test('A1: --merge accepts PDF and DOCX however the format and output are given', () => {
  const { parseArguments } = require(cli);
  const cases = [
    [['a.md', 'b.md', '--merge', '--format', 'pdf', '-o', 'book.pdf'], { format: 'pdf', output: path.resolve('book.pdf') }],
    [['--merge', 'a.md', 'b.md', '--format', 'docx', '--output', 'book.docx'], { format: 'docx', output: path.resolve('book.docx') }],
    [['a.md', '-o', 'book.pdf', 'b.md', '--merge'], { format: 'pdf' }],
    [['a.md', '-o', 'BOOK.PDF', '--merge'], { format: 'pdf' }],
    [['a.md', '-o', 'out/book.docx', '--merge'], { format: 'docx' }],
    [['a.md', '--merge', '--format', 'pdf', '-o', '-'], { format: 'pdf', stdout: true, output: undefined }],
    [['a.md', '--merge', '--format', 'docx', '-o', '-'], { format: 'docx', stdout: true }],
    [['only.md', '--merge', '-o', 'one.pdf'], { format: 'pdf' }],
    [['a.md', 'b.md', '--merge', '-o', 'b.pdf', '--title', 'Book', '--json', '--strict', '--force'], { title: 'Book', json: true, strict: true, force: true }],
    [['a.md', 'b.md', '--merge', '-o', 'b.pdf', '--watch'], { watch: true }],
    [['a.md', 'b.md', '--merge', '-o', 'b.pdf', '--restrict-local-files', '--workspace-root', '.', '--language', 'ja'], { restrictLocalFiles: true, language: 'ja' }],
  ];
  for (const [argv, expected] of cases) {
    const parsed = parseArguments(argv);
    assert.equal(parsed.merge, true, argv.join(' '));
    for (const [key, value] of Object.entries(expected)) assert.equal(parsed[key], value, `${argv.join(' ')}: ${key}`);
  }
  assert.equal(parseArguments(['a.md', '--format', 'pdf']).merge, false);
  assert.deepEqual(parseArguments(['a.md', 'b.md', '--merge', '-o', 'x.pdf']).inputPatterns, ['a.md', 'b.md']);
});

/**
 * A2: 結合できない組み合わせを、ブラウザーを起動する前に終了コード2で拒否し、何も書かないことを検証する。
 * 回帰リスク: HTML・記法変換・標準入力・出力先未指定での結合を受け付けて不完全な出力を書く、従来の検査の文言が変わる。
 */
test('A2: invalid --merge combinations exit with code 2 before writing', async () => {
  const { parseArguments } = require(cli);
  const formats = /Invalid --merge: it supports --format pdf and docx only/;
  const output = /Invalid --merge: name the merged file with -o/;
  for (const [argv, message] of [
    [['a.md', '--merge', '--format', 'html', '-o', 'x.html'], formats],
    [['a.md', '--merge', '-o', 'x.htm'], formats],
    [['a.md', '--merge', '-o', 'x.html'], formats],
    [['a.md', '--merge', '-o', 'x.md'], formats],
    [['a.md', '--merge', '-o', 'x.markdown'], formats],
    [['a.md', '--merge', '--format', 'textile', '-o', 'x.textile'], formats],
    [['a.md', '--merge', '--format', 'md', '-o', 'x.txt'], formats],
    [['a.md', 'b.md', '--merge', '--format', 'pdf'], output],
    [['a.md', 'b.md', '--merge', '--format', 'docx'], output],
    [['a.md', 'b.md', '--merge', '--format', 'pdf', '--out-dir', 'out'], output],
    [['-', '--merge', '--format', 'pdf', '-o', 'x.pdf'], /Invalid --merge: it cannot be combined with standard input/],
    [['a.md', '--merge', '-o', 'x.pdf', '--out-dir', 'out'], /--output and --out-dir cannot be combined/],
    [['a.md', '--merge', '--format', 'pdf', '-o', '-', '--json'], /--json cannot be combined with standard output/],
    [['a.md', '--merge', '--format', 'pdf', '-o', '-', '--watch'], /Invalid --watch/],
    [['a.md', '--merge', '-o', 'x.pdf', '--watch', '--json'], /Invalid --watch/],
    [['a.md', '--merge', '-o', 'x.pdf', '--title', '   '], /Invalid title/],
    [['a.md', '--merge', '-o', 'x.pdf', '--html-outline'], /HTML-only options/],
    [['a.md', '--merge', '-o', 'x.docx', '--html-embed-images'], /HTML-only options/],
    [['a.md', '--merge'], /--format html\|pdf\|docx\|md\|textile is required/],
  ]) {
    assert.throws(() => parseArguments(argv), message, argv.join(' '));
  }
  await withDirectory(async (directory) => {
    await writeFiles(directory, { 'a.md': '# A\n', 'b.md': '# B\n' });
    for (const argv of [
      ['a.md', 'b.md', '--merge', '--format', 'html', '-o', 'x.html'],
      ['a.md', 'b.md', '--merge', '--format', 'pdf'],
      ['a.md', 'b.md', '--merge', '-o', 'x.md'],
    ]) {
      const result = await run(argv, { cwd: directory, browser: false });
      assert.equal(result.code, 2, `${argv.join(' ')}\n${result.stderr}`);
      assert.match(result.stderr, /Invalid --merge/);
    }
    const json = await run(['a.md', 'b.md', '--merge', '--format', 'pdf', '--json'], { cwd: directory, browser: false });
    assert.equal(json.code, 2);
    const report = JSON.parse(json.stdout);
    assert.equal(report.ok, false);
    assert.match(report.error, /Invalid --merge/);
    assert.deepEqual(report.results, []);
    assert.deepEqual((await import('node:fs')).readdirSync(directory).sort(), ['a.md', 'b.md']);
  });
});

/** A3: --help が --merge の使い方（使用例・オプション・--title の対象）を示すことを検証する。 */
test('A3: --help documents --merge', async () => {
  const help = await run(['--help'], { browser: false });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /mve-convert INPUT\.md "docs\/\*\*\/\*\.md" --merge --format pdf\|docx -o OUTPUT/);
  assert.match(help.stdout, /--merge\s+Combine all inputs, in order, into one PDF or DOCX \(-o\)/);
  assert.match(help.stdout, /--title TEXT\s+Document title \(single input or --merge\)/);
});

// ---------------------------------------------------------------------------------------------------------------
// B: 文書間リンクの解決
// ---------------------------------------------------------------------------------------------------------------

/**
 * B1: 結合する文書を指すローカルリンクを、すべての書き方で飛び先の文書と断片へ解決することを検証する。
 * 回帰リスク: `%23`（#）を含むファイル名を2回デコードして断片と誤認する、`?query`や`./`・`../`・`\`・絶対パス・
 * `file:` URIを解決できない、%エンコードした断片を戻さない、不正な%エスケープで例外になる。
 */
test('B1: resolveMergedLinks resolves every form of a link to a merged document', () => {
  const { resolveMergedLinks } = require(cli);
  const root = path.join(tmpdir(), 'mve-merge-links', 'book');
  const a = path.join(root, 'a.md');
  const b = path.join(root, 'sub', 'b.md');
  const odd = path.join(root, '外部 文書 #1.md');
  const textile = path.join(root, 'c.textile');
  const inputs = [a, b, odd, textile];
  const cases = [
    ['sub/b.md', 1, ''],
    ['./sub/b.md#x', 1, 'x'],
    ['sub/b.md?view=1#x', 1, 'x'],
    ['sub/b.md?view=1', 1, ''],
    ['sub/b.md#', 1, ''],
    ['sub/../sub/./b.md#x', 1, 'x'],
    ['sub\\b.md#x', 1, 'x'],
    ['sub/b.md#%E6%A6%82%E8%A6%81', 1, '概要'],
    ['sub/b.md#概要', 1, '概要'],
    ['sub/b.md#%E6%A6', 1, '%E6%A6'],
    ['sub/b.md#a%20b', 1, 'a b'],
    ['%E5%A4%96%E9%83%A8%20%E6%96%87%E6%9B%B8%20%231.md', 2, ''],
    ['%E5%A4%96%E9%83%A8%20%E6%96%87%E6%9B%B8%20%231.md#%E6%A6%82%E8%A6%81', 2, '概要'],
    ['c.textile#t', 3, 't'],
    ['a.md#self', 0, 'self'],
    [b, 1, ''],
    [`${b}#x`, 1, 'x'],
    [pathToFileURL(b).href, 1, ''],
    [`${pathToFileURL(b).href}#x`, 1, 'x'],
    [pathToFileURL(odd).href, 2, ''],
  ];
  if (process.platform === 'win32') cases.push(['SUB/B.MD#x', 1, 'x'], ['Sub\\B.md', 1, '']);
  const references = cases.map(([href]) => ({ href, workspaceRooted: false }));
  const links = resolveMergedLinks(references, a, inputs, root);
  for (const [href, document, fragment] of cases) {
    assert.deepEqual(links[`p:${href}`], { document, fragment }, href);
  }
  assert.equal(Object.keys(links).length, cases.length);
});

/**
 * B2: 結合しない文書・ディレクトリ・リモートやファイル以外のURI・空のリンクを解決しないことを検証する。
 * 回帰リスク: `mailto:`やドライブ文字に似たスキームをファイルと誤認する、別の文書へ誤って結び付ける。
 */
test('B2: resolveMergedLinks ignores links that do not point to a merged document', () => {
  const { resolveMergedLinks } = require(cli);
  const root = path.join(tmpdir(), 'mve-merge-links', 'book');
  const a = path.join(root, 'a.md');
  const inputs = [a, path.join(root, 'sub', 'b.md')];
  const hrefs = ['other.md', 'sub/', 'sub', 'sub/b.markdown', 'sub/b.md.bak', 'https://example.com/sub/b.md', 'http://localhost/a.md',
    'mailto:a@example.com', 'tel:000', 'ftp://example.com/a.md', '//example.com/a.md', 'data:text/plain,a', 'javascript:alert(1)',
    'vscode://file/a.md', '', '#', '?x', `${path.join(root, 'sub', 'c.md')}`, pathToFileURL(path.join(root, 'z.md')).href, 'file:///%'];
  const links = resolveMergedLinks(hrefs.map((href) => ({ href, workspaceRooted: false })), a, inputs, root);
  assert.deepEqual(links, {});
});

/**
 * B3: ワークスペース基準のリンク（`/`で始まる）を、ワークスペースルートから解決し、同じ文字列の通常のリンクと区別することを検証する。
 * ルートの外にある文書からのワークスペース基準のリンクは解決しない（HTML 出力と同じ規則）。
 */
test('B3: resolveMergedLinks resolves workspace-rooted links from the workspace root only', () => {
  const { resolveMergedLinks } = require(cli);
  const root = path.join(tmpdir(), 'mve-merge-links', 'book');
  const a = path.join(root, 'a.md');
  const b = path.join(root, 'sub', 'b.md');
  const rooted = { href: '/sub/b.md#x', workspaceRooted: true };
  const plain = { href: '/sub/b.md#x', workspaceRooted: false };
  assert.deepEqual(resolveMergedLinks([rooted, plain], a, [a, b], root), { 'r:/sub/b.md#x': { document: 1, fragment: 'x' } });
  assert.deepEqual(resolveMergedLinks([rooted], a, [a, b], path.join(root, 'sub')), {});
  const outside = path.join(tmpdir(), 'mve-merge-links', 'outside.md');
  assert.deepEqual(resolveMergedLinks([rooted], outside, [outside, b], root), {});
});

// ---------------------------------------------------------------------------------------------------------------
// C: 結合の規則
// ---------------------------------------------------------------------------------------------------------------

/**
 * C1: 先の文書と重なる ID だけを改名し、先の文書の ID・重ならない ID・同じ文書内の重複を保つことを検証する。
 * 改名後の名前は、先の文書・同じ文書の既存の ID・同じ文書で既に割り当てた名前のどれとも重ならない。SVG 内の ID は変えない。
 */
test('C1: ids that collide with earlier documents are renamed without new collisions', needsBrowser, async () => {
  const { mergeRenderedDocuments } = require(cli);
  await withPage(async (page) => {
    const documents = [
      { html: '<h1 id="a">A</h1><h2 id="a-1">A1</h2><p id="x">x</p><svg id="g"><g id="n"></g></svg>', links: {} },
      { html: '<h1 id="a">A</h1><h2 id="a-2">own a-2</h2><h2 id="a">dup</h2><p id="x">x</p><p id="y">y</p><svg id="g"><g id="n"></g></svg>', links: {} },
      { html: '<h1 id="a">A</h1><h2 id="a-3">own</h2><p id="y">y</p><p id="x-1">x1</p><p id="x">x</p>', links: {} },
      { html: '<h1 id="概要">概要</h1><p id="a b">space</p><p id="&quot;q&quot;">quote</p>', links: {} },
      { html: '<h1 id="概要">概要</h1><p id="a b">space</p><p id="&quot;q&quot;">quote</p>', links: {} },
    ];
    const result = await inspect(page, await page.evaluate(mergeRenderedDocuments, { documents, pageBreakLabel: '' }));
    assert.deepEqual(result.ids, [
      'a', 'a-1', 'x',
      'a-3', 'a-2', 'a-3', 'x-1', 'y',
      'a-4', 'a-3-1', 'y-1', 'x-1-1', 'x-2',
      '概要', 'a b', '"q"',
      '概要-1', 'a b-1', '"q"-1'
    ]);
    const svg = await page.evaluate((markup) => {
      const template = document.createElement('template');
      template.innerHTML = markup;
      return [...template.content.querySelectorAll('svg, svg [id]')].map((element) => element.id);
    }, await page.evaluate(mergeRenderedDocuments, { documents, pageBreakLabel: '' }));
    assert.deepEqual(svg, ['g', 'n', 'g', 'n']);
    assert.equal(result.breaks, 4);
  });
});

/**
 * C2: 文書内の参照（`href="#..."`、%エンコードした断片、脚注の往復リンク、`aria-labelledby`・`aria-describedby`・
 * `for`・`headers`）が、その文書で改名した ID へ向き直ることを検証する。他の文書の参照や、改名していない ID は変えない。
 */
test('C2: references inside a document follow its renamed ids', needsBrowser, async () => {
  const { mergeRenderedDocuments } = require(cli);
  await withPage(async (page) => {
    const footnoted = (label) => `<h2 id="概要">概要</h2><p><a href="#%E6%A6%82%E8%A6%81">enc-${label}</a> <a href="#概要">raw-${label}</a>`
      + ` <a href="#missing">missing-${label}</a> <a href="#">top-${label}</a></p>`
      + `<p><sup class="footnote-ref"><a href="#fn-1" id="fnref-1-1">ref-${label}</a></sup></p>`
      + `<section class="footnotes"><ol><li id="fn-1">note <a href="#fnref-1-1">back-${label}</a></li></ol></section>`
      + `<span id="label">L</span><input aria-labelledby="label other" aria-describedby="label"><label for="label">for-${label}</label>`
      + '<table><tr><th id="h">H</th></tr><tr><td headers="h label">c</td></tr></table>';
    const html = await page.evaluate(mergeRenderedDocuments, {
      documents: [{ html: footnoted('1'), links: {} }, { html: footnoted('2'), links: {} }], pageBreakLabel: ''
    });
    const result = await inspect(page, html);
    const href = (text) => result.links.find(([label]) => label === text)?.[1];
    assert.equal(href('enc-1'), '#%E6%A6%82%E8%A6%81');
    assert.equal(href('raw-1'), '#概要');
    assert.equal(href('enc-2'), '#概要-1');
    assert.equal(href('raw-2'), '#概要-1');
    assert.equal(href('missing-2'), '#missing');
    assert.equal(href('top-2'), '#');
    assert.equal(href('ref-1'), '#fn-1');
    assert.equal(href('ref-2'), '#fn-1-1');
    assert.equal(href('back-1'), '#fnref-1-1');
    assert.equal(href('back-2'), '#fnref-1-1-1');
    const attributes = await page.evaluate((markup) => {
      const template = document.createElement('template');
      template.innerHTML = markup;
      return [...template.content.querySelectorAll('input, label, td')].map((element) =>
        [element.getAttribute('aria-labelledby'), element.getAttribute('aria-describedby'), element.getAttribute('for'), element.getAttribute('headers')]);
    }, html);
    assert.deepEqual(attributes, [
      ['label other', 'label', null, null], [null, null, 'label', null], [null, null, null, 'h label'],
      ['label-1 other', 'label-1', null, null], [null, null, 'label-1', null], [null, null, null, 'h-1 label-1']
    ]);
  });
});

/**
 * C3: 文書間リンクを、改名後の正しい見出しへの文書内リンクへ書き換えることを検証する。
 * 断片なしは飛び先の最初の見出し（生HTMLの見出しや引用の中の見出しは除く）へ。見出しのない文書、飛び先にない断片
 * （先の文書にだけ同じ ID がある場合を含む）、対応表にないリンクは元のまま（data-mve-link を残す）。
 * ワークスペース基準のキー（r:）と通常のキー（p:）を混同しない。
 */
test('C3: links between documents go to the right heading or stay as they were', needsBrowser, async () => {
  const { mergeRenderedDocuments } = require(cli);
  await withPage(async (page) => {
    const link = (text, href, rooted = false) => `<a href="#" data-mve-link="${href}"${rooted ? ' data-mve-workspace-rooted="true"' : ''}>${text}</a>`;
    const documents = [
      {
        html: '<h1 id="intro" data-mve-heading="true">Intro</h1><h2 id="only-first" data-mve-heading="true">Only</h2><h2 id="s" data-mve-heading="true">S</h2>'
          + link('to-b-s', 'b.md#s') + link('to-b', 'b.md') + link('to-c', 'c.md') + link('to-d', 'd.md') + link('to-b-missing', 'b.md#only-first')
          + link('to-b-rooted', '/b.md#s', true) + link('to-other', 'other.md') + link('to-self', 'a.md#s') + link('to-e', 'e.md#%E6%A6%82%E8%A6%81'),
        links: {
          'p:b.md#s': { document: 1, fragment: 's' }, 'p:b.md': { document: 1, fragment: '' }, 'p:c.md': { document: 2, fragment: '' },
          'p:d.md': { document: 3, fragment: '' }, 'p:b.md#only-first': { document: 1, fragment: 'only-first' },
          'p:a.md#s': { document: 0, fragment: 's' }, 'p:e.md#%E6%A6%82%E8%A6%81': { document: 4, fragment: '概要' }
        }
      },
      {
        html: '<h3 id="raw">Raw</h3><blockquote><h1 id="quoted" data-mve-heading="true">Q</h1></blockquote><h1 id="b" data-mve-heading="true">B</h1>'
          + '<h2 id="s" data-mve-heading="true">S</h2>' + link('back', '../a.md#s'),
        links: { 'p:../a.md#s': { document: 0, fragment: 's' } }
      },
      { html: '<p>No heading</p>', links: {} },
      { html: '<h1 id="s" data-mve-heading="true">D first</h1>', links: {} },
      { html: '<h1 id="概要" data-mve-heading="true">概要</h1>', links: {} },
    ];
    const result = await inspect(page, await page.evaluate(mergeRenderedDocuments, { documents, pageBreakLabel: '' }));
    const anchor = (text) => result.links.find(([label]) => label === text);
    assert.deepEqual(anchor('to-b-s'), ['to-b-s', '#s-1', null]);
    assert.deepEqual(anchor('to-b'), ['to-b', '#b', null]);
    assert.deepEqual(anchor('to-c'), ['to-c', '#', 'c.md']);
    assert.deepEqual(anchor('to-d'), ['to-d', '#s-2', null]);
    assert.deepEqual(anchor('to-b-missing'), ['to-b-missing', '#', 'b.md#only-first']);
    assert.deepEqual(anchor('to-b-rooted'), ['to-b-rooted', '#', '/b.md#s']);
    assert.deepEqual(anchor('to-other'), ['to-other', '#', 'other.md']);
    assert.deepEqual(anchor('to-self'), ['to-self', '#s', null]);
    assert.deepEqual(anchor('to-e'), ['to-e', '#概要', null]);
    assert.deepEqual(anchor('back'), ['back', '#s', null]);
  });
});

/**
 * C4: すべての`[toc]`を、全文書の見出しで作り直すことを検証する。
 * 対象は data-mve-heading の付いた見出しだけで、生HTMLの見出し・引用・脚注・目次・SVG の中の見出しと、文字のない見出しは除く。
 * 文字列からは KaTeX の MathML 側と脚注参照の番号を除き、空白をまとめる。見出しがなければ目次は変えない。
 */
test('C4: every table of contents lists the headings of all documents', needsBrowser, async () => {
  const { mergeRenderedDocuments } = require(cli);
  await withPage(async (page) => {
    const toc = '<nav class="table-of-contents" aria-label="TOC"><strong>TOC</strong><ul><li class="toc-level-1"><a href="#old">Old</a></li></ul></nav>';
    const documents = [
      { html: `<h1 id="a" data-mve-heading="true">A</h1>${toc}<h2 id="x" data-mve-heading="true">  Spaced\n  heading </h2>`, links: {} },
      {
        html: '<h1 id="a" data-mve-heading="true">B <span class="katex"><span class="katex-mathml"><math>x2</math></span><span class="katex-html">x²</span></span></h1>'
          + '<h2 id="n" data-mve-heading="true">Note<sup class="footnote-ref"><a href="#fn-1" id="fnref-1-1">1</a></sup></h2>'
          + '<h3 id="raw">Raw HTML</h3><blockquote><h2 id="q" data-mve-heading="true">Quoted</h2></blockquote>'
          + '<h4 id="empty" data-mve-heading="true"> </h4><h6 id="deep" data-mve-heading="true">Deep &amp; &lt;escaped&gt;</h6>'
          + `<svg><foreignObject><h2 id="svg" data-mve-heading="true">In SVG</h2></foreignObject></svg>${toc}`
          + '<section class="footnotes"><h2 id="fh" data-mve-heading="true">Footnote heading</h2><ol><li id="fn-1">n</li></ol></section>',
        links: {}
      },
    ];
    const result = await inspect(page, await page.evaluate(mergeRenderedDocuments, { documents, pageBreakLabel: '' }));
    const expected = [
      ['toc-level-1', 'A', '#a'], ['toc-level-2', 'Spaced heading', '#x'], ['toc-level-1', 'B x²', '#a-1'],
      ['toc-level-2', 'Note', '#n'], ['toc-level-6', 'Deep & <escaped>', '#deep']
    ];
    assert.deepEqual(result.toc, [expected, expected]);
    const untouched = await inspect(page, await page.evaluate(mergeRenderedDocuments, {
      documents: [{ html: `<p>no headings</p>${toc}`, links: {} }], pageBreakLabel: ''
    }));
    assert.deepEqual(untouched.toc, [[['toc-level-1', 'Old', '#old']]]);
  });
});

/**
 * C5: ローカル画像を別の文書の場所から解決し直さない印を付けることを検証する。
 * 埋め込み済み（src が data:）は data-original-src を外し、読み込めなかったローカル画像は src を残して data-original-src を`#`にする。
 * リモート・blob・プロトコル相対・断片だけの画像と、src のない画像は変えない。
 */
test('C5: local images are never resolved again from another location', needsBrowser, async () => {
  const { mergeRenderedDocuments } = require(cli);
  await withPage(async (page) => {
    const html = [
      '<img alt="embedded" src="data:image/png;base64,AAAA" data-original-src="figure.png">',
      '<img alt="embedded-raw" src="data:image/png;base64,BBBB">',
      '<img alt="failed" src="missing.png" data-original-src="missing.png">',
      '<img alt="failed-raw" src="sub/missing.png">',
      '<img alt="failed-absolute" src="C:/images/x.png">',
      '<img alt="failed-file" src="file:///tmp/x.png" data-original-src="file:///tmp/x.png">',
      '<img alt="remote" src="https://example.com/x.png" data-original-src="https://example.com/x.png">',
      '<img alt="http" src="http://example.com/x.png">',
      '<img alt="blob" src="blob:https://example.com/1">',
      '<img alt="protocol" src="//example.com/x.png">',
      '<img alt="fragment" src="#x">',
      '<img alt="nosrc">',
    ].join('');
    const result = await inspect(page, await page.evaluate(mergeRenderedDocuments, { documents: [{ html, links: {} }], pageBreakLabel: '' }));
    assert.deepEqual(result.images, [
      ['embedded', 'data:image/png;base64,AAAA', null],
      ['embedded-raw', 'data:image/png;base64,BBBB', null],
      ['failed', 'missing.png', '#'],
      ['failed-raw', 'sub/missing.png', '#'],
      ['failed-absolute', 'C:/images/x.png', '#'],
      ['failed-file', 'file:///tmp/x.png', '#'],
      ['remote', 'https://example.com/x.png', 'https://example.com/x.png'],
      ['http', 'http://example.com/x.png', null],
      ['blob', 'blob:https://example.com/1', null],
      ['protocol', '//example.com/x.png', null],
      ['fragment', '#x', null],
      ['nosrc', null, null],
    ]);
  });
});

/**
 * C6: 改ページを、中身のある文書の間にだけ挟むことを検証する。中身のない文書（空、空白だけ、空の囲みだけ、コメントだけ）は
 * 出力に含めず、画像・罫線・表・改ページだけの文書は中身があるものとして扱う。改ページの文言は属性として安全に書く。
 */
test('C6: page breaks are inserted only between documents with content', needsBrowser, async () => {
  const { mergeRenderedDocuments } = require(cli);
  await withPage(async (page) => {
    const merge = (htmls, label = '') => page.evaluate(mergeRenderedDocuments,
      { documents: htmls.map((html) => ({ html, links: {} })), pageBreakLabel: label });
    const empty = ['', '  \n ', '<div class="markdown-source-block">\n</div>', '<!-- note -->', '<p> </p>'];
    for (const blank of empty) {
      assert.equal(await merge(['<p>A</p>', blank, '<p>B</p>']), '<p>A</p><div class="page-break" aria-label=""></div><p>B</p>', JSON.stringify(blank));
      assert.equal(await merge([blank, '<p>B</p>']), '<p>B</p>');
      assert.equal(await merge(['<p>A</p>', blank]), '<p>A</p>');
    }
    assert.equal(await merge(empty), '');
    for (const visible of ['<img src="data:image/png;base64,AAAA" alt="">', '<hr>', '<table><tbody><tr><td></td></tr></tbody></table>',
      '<svg></svg>', '<div class="page-break" aria-label=""></div>']) {
      assert.equal((await inspect(page, await merge(['<p>A</p>', visible]))).breaks, visible.includes('page-break') ? 2 : 1, visible);
    }
    // 属性値の`<`・`>`をエスケープするかは Chromium の版で違うため、文字列ではなく DOM として読んだ値で比べる。
    const labelled = await merge(['<p>A</p>', '<p>B</p>'], 'Page "break" <&>');
    assert.deepEqual(await page.evaluate((markup) => {
      const template = document.createElement('template');
      template.innerHTML = markup;
      return [...template.content.children].map((element) => [element.tagName, element.className, element.getAttribute('aria-label'), element.textContent]);
    }, labelled), [['P', '', null, 'A'], ['DIV', 'page-break', 'Page "break" <&>', ''], ['P', '', null, 'B']]);
    assert.equal(await merge(['<p>A</p>', '<p>B</p>', '<p>C</p>', '<p>D</p>']).then((html) => html.split('page-break').length - 1), 3);
  });
});

/**
 * C7: 描画器が無害化した危険な入力を、結合（再解析と再出力）で再び有効にしないことを検証する。
 * 描画器の実際の出力を使い、結合後に script 要素・on* 属性・javascript: の URL が現れず、元にない要素が増えないことを確かめる。
 */
test('C7: merging keeps sanitized markup inert', needsBrowser, async () => {
  const { mergeRenderedDocuments } = require(cli);
  await withPage(async (page) => {
    // 閉じていない<math>…<style>は後続の行をすべて飲み込むため、最後に置く。確認用のコードの行はその前に置く。
    const hostile = [
      '# Hostile', '', '`<script>` in code', '', '<script>window.bad = 1</script>', '', '<img src="x" onerror="window.bad = 2">', '',
      '[js](javascript:alert(1))', '', '<a href="javascript:alert(2)">raw js</a>', '', '<svg onload="window.bad = 3"><circle r="1"/></svg>', '',
      '<iframe src="https://example.com"></iframe>', '', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>', '',
      '<details open ontoggle="window.bad = 4"><summary>s</summary>d</details>', '',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>', ''
    ].join('\n');
    const first = await render(page, hostile);
    const second = await render(page, hostile.replace('# Hostile', '# Hostile again'));
    const merged = await page.evaluate(mergeRenderedDocuments, { documents: [{ html: first, links: {} }, { html: second, links: {} }], pageBreakLabel: '' });
    const facts = await page.evaluate(([markup, inputs]) => {
      const parse = (html) => {
        const template = document.createElement('template');
        template.innerHTML = html;
        return template.content;
      };
      const root = parse(markup);
      const tags = (fragment) => new Set([...fragment.querySelectorAll('*')].map((element) => element.tagName.toLowerCase()));
      const allowed = new Set([...inputs.flatMap((html) => [...tags(parse(html))]), 'div']);
      return {
        scripts: root.querySelectorAll('script, iframe').length,
        handlers: [...root.querySelectorAll('*')].flatMap((element) => [...element.attributes].map((attribute) => attribute.name)).filter((name) => /^on/i.test(name)),
        javascript: [...root.querySelectorAll('[href], [src], [xlink\\:href]')].filter((element) =>
          /^\s*javascript:/i.test(element.getAttribute('href') ?? element.getAttribute('src') ?? '')).length,
        extra: [...tags(root)].filter((tag) => !allowed.has(tag))
      };
    }, [merged, [first, second]]);
    assert.deepEqual(facts, { scripts: 0, handlers: [], javascript: 0, extra: [] });
    assert.match(merged, /&lt;script&gt;/);
  }, { renderer: true });
});

/**
 * C8: 1文書だけの結合では、ID の衝突も目次もないため、描画器の出力が変わらないことを検証する（単独の変換との互換性）。
 * サンプルの本の、目次と画像を持たない章を実際の描画器で描画して使う。
 */
test('C8: a single document without a table of contents passes through unchanged', needsBrowser, async () => {
  const { mergeRenderedDocuments } = require(cli);
  await withPage(async (page) => {
    for (const [name, format] of [['04-links/links.md', 'mixed'], ['06-mixed.md', 'mixed'], ['03-diagrams.md', 'mixed'],
      ['10-names/外部 文書 #1.md', 'mixed'], ['08-empty.md', 'mixed']]) {
      const html = await render(page, BOOK_FILES[`book/${name}`], format);
      const merged = await page.evaluate(mergeRenderedDocuments, { documents: [{ html, links: {} }], pageBreakLabel: '' });
      assert.equal(merged, name === '08-empty.md' ? '' : html, name);
    }
  }, { renderer: true });
});

/**
 * C9: 文書数と見出しの数が多くても、結合が短時間で終わり、すべての ID が一意で目次が全見出しを並べることを検証する。
 * 300文書 × 同名の見出し40個 + 脚注（合計約3万の ID の衝突）。上限は CI のばらつきを見込んだ値で、計測値を出力する。
 * 回帰リスク: 改名の候補探しや目次の作り直しが文書数の2乗以上に遅くなる。
 */
test('C9: merging 300 documents with 12,000 colliding headings stays fast', needsBrowser, async () => {
  const { mergeRenderedDocuments } = require(cli);
  await withPage(async (page) => {
    const sections = Array.from({ length: 40 }, () => '<h2 id="s" data-mve-heading="true">S</h2><p><a href="#s">s</a></p>').join('');
    const documents = Array.from({ length: 300 }, (_, index) => ({
      html: `<h1 id="doc" data-mve-heading="true">Doc ${index}</h1>${index === 0 ? '<nav class="table-of-contents"><ul></ul></nav>' : ''}${sections}`
        + '<p><sup class="footnote-ref"><a href="#fn-1" id="fnref-1-1">1</a></sup></p><section class="footnotes"><ol><li id="fn-1">n</li></ol></section>',
      links: {}
    }));
    const started = performance.now();
    const html = await page.evaluate(mergeRenderedDocuments, { documents, pageBreakLabel: '' });
    const elapsed = performance.now() - started;
    const facts = await page.evaluate((markup) => {
      const template = document.createElement('template');
      template.innerHTML = markup;
      const ids = [...template.content.querySelectorAll('[id]')].map((element) => element.id);
      const firstIds = new Set(ids.slice(0, 43));
      return {
        total: ids.length, unique: new Set(ids).size, toc: template.content.querySelectorAll('nav li').length,
        breaks: template.content.querySelectorAll('.page-break').length, firstIds: [...firstIds].sort()
      };
    }, html);
    test.diagnostic?.(`merge of 300 documents took ${elapsed.toFixed(0)} ms`);
    console.log(`# C9: merge of 300 documents took ${elapsed.toFixed(0)} ms`);
    // 同じ文書内の同名の見出し（40個）は単独の変換と同じく同じ ID のまま。文書ごとの名前は一意。
    assert.equal(facts.total, 300 * 43);
    assert.equal(facts.unique, 300 * 4);
    assert.equal(facts.toc, 300 * 41);
    assert.equal(facts.breaks, 299);
    assert.deepEqual(facts.firstIds, ['doc', 'fn-1', 'fnref-1-1', 's']);
    assert.ok(elapsed < 15_000, `merge took ${elapsed} ms`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// D・E: サンプルの本
// ---------------------------------------------------------------------------------------------------------------

/**
 * D1: サンプルの本（11章）を結合したDOCXが、各章を単独でDOCXへ変換した結果の合計と同じ内容を持つことを検証する。
 * 比べるもの: 目次を除く本文の段落の文字列（順序を含む）、画像の中身（順序を含む）、脚注の文字列、警告（Marp の警告だけ増える）。
 * 回帰リスク: 結合で段落・画像・脚注が欠ける、別の章の画像（同名ファイル）へすり替わる、警告が消える・増える。
 */
test('D1: the merged DOCX of the sample book contains exactly the content of every chapter', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await copyFixtures(directory);
    const inputs = BOOK.map((name) => path.join(directory, name));
    const merged = await run([...BOOK, '--merge', '-o', 'out/book.docx', '--language', 'ja'], { cwd: directory });
    assert.equal(merged.code, 0, merged.stderr);
    const book = readDocx(await readFile(path.join(directory, 'out', 'book.docx')));
    const expected = { body: [], media: [], footnotes: [], warnings: ['Marp slides were merged as a regular document.'] };
    for (const [index, name] of BOOK.entries()) {
      const output = path.join(directory, 'single', `${index}.docx`);
      const single = await run([name, '--format', 'docx', '-o', output, '--language', 'ja'], { cwd: directory });
      assert.equal(single.code, 0, `${name}\n${single.stderr}`);
      const chapter = readDocx(await readFile(output));
      expected.body.push(...chapter.body.filter((text) => text !== '目次'));
      expected.media.push(...chapter.media);
      expected.footnotes.push(...chapter.footnotes);
      expected.warnings.push(...lines(single.stderr));
    }
    assert.deepEqual(book.body.filter((text) => text !== '目次'), expected.body);
    assert.deepEqual(book.media, expected.media);
    assert.deepEqual(book.footnotes, expected.footnotes);
    const warnings = lines(merged.stderr).filter((line) => line !== path.join(directory, 'out', 'book.docx'))
      .map((line) => stripInputLabel(line, inputs));
    assert.deepEqual(warnings.slice().sort(), expected.warnings.slice().sort());
    // 本文に危険な入力の痕跡がない（スクリプトの中身は文字として出ない）。
    assert.ok(!book.body.some((text) => /mveInjected/.test(text)));
  });
});

/**
 * D2: 結合したDOCXで、見出し・しおり・文書間リンク・外部リンク・目次・改ページが期待どおりになることを検証する。
 * リンクは「リンクの文字列 → 飛び先の見出し（結合後の見出しの番号）」の表で全件確かめ、解決できないリンクは文字だけになる。
 */
test('D2: links, bookmarks, the table of contents, and page breaks in the merged DOCX', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await copyFixtures(directory);
    const result = await run([...BOOK, '--merge', '-o', 'book.docx', '--language', 'ja'], { cwd: directory });
    assert.equal(result.code, 0, result.stderr);
    const book = readDocx(await readFile(path.join(directory, 'book.docx')));
    assert.deepEqual(book.headings.map((heading) => heading.text), BOOK_HEADINGS);
    assert.equal(new Set(book.headings.map((heading) => heading.bookmark)).size, BOOK_HEADINGS.length);
    const bookmark = (index) => book.headings[index].bookmark;
    const anchorsOf = (text) => {
      const found = book.paragraphs.filter((paragraph) => paragraph.text === text && !/^TOC/.test(paragraph.style ?? ''));
      assert.equal(found.length, 1, `paragraph ${text}`);
      return found[0].anchors;
    };
    const expectations = [
      ['基本記法', [3]], ['基本記法の概要', [4]], ['図の章', [15]], ['図の章の概要（./ 付き）', [16]], ['図表の章の概要', [18]],
      ['リンクの章', [19]], ['Textile の章の概要', [23]], ['混在記法の章', [24]], ['スライドの章', [27]], ['記号を含む名前の章', [29]],
      ['空の章', []], ['front matter だけの章', []], ['結合しない文書', []], ['テキストファイル', []], ['Web', []], ['メール', []],
      ['明示 ID へ、同じ文書の概要へ。', [13, 4]], ['基本記法の概要へ戻る', [4]],
      ['表紙へ', [0]], ['表紙の概要へ', [2]], ['エンコードした断片', [4]], ['クエリ付き', [4]], ['明示 ID', [13]], ['Setext 見出し', [12]],
      ['存在しない断片', []], ['Textile の章', [22]], ['自分の概要', [20]], ['自分の2つ目の概要', [21]], ['自分自身のファイル', [20]],
      ['結合しない文書の断片', []], ['ディレクトリ', []], ['不正なエスケープ', []], ['基本記法の概要へ', [4]], ['表紙の使い方へ', [1]],
    ];
    for (const [text, targets] of expectations) {
      assert.deepEqual(anchorsOf(text), targets.map(bookmark), text);
    }
    // 表の中のリンクは段落の文字列が「リンク」の1件。
    assert.deepEqual(book.paragraphs.filter((paragraph) => paragraph.text === 'リンク').map((paragraph) => paragraph.anchors), [[bookmark(4)]]);
    // どのリンクも、存在するしおりを指す。
    for (const paragraph of book.paragraphs) {
      for (const anchor of paragraph.anchors) assert.ok(book.bookmarks.has(anchor), `dangling ${anchor} in ${paragraph.text}`);
    }
    const rels = book.parts.get('word/_rels/document.xml.rels').toString('utf8');
    assert.match(rels, /Target="https:\/\/example\.com\/" TargetMode="External"/);
    assert.match(rels, /Target="mailto:test@example\.com" TargetMode="External"/);
    assert.doesNotMatch(rels, /not-merged|notes\.txt|javascript/);
    // 目次（Word の目次フィールドの既定の項目）は全見出しを並べ、各項目は見出しのしおりへリンクする。
    const toc = book.paragraphs.filter((paragraph) => /^TOC\d$/.test(paragraph.style ?? ''));
    assert.equal(toc.length, BOOK_HEADINGS.length);
    toc.forEach((entry, index) => {
      if (index === 10) assert.match(entry.text, /^見出しに .+ と code を含む$/);
      else assert.equal(entry.text, BOOK_HEADINGS[index], `toc ${index}`);
      assert.deepEqual(entry.anchors, [bookmark(index)], `toc ${index}`);
    });
    assert.deepEqual(book.paragraphs.filter((paragraph) => paragraph.style === 'TOCHeading').map((paragraph) => paragraph.text), ['目次']);
    // 2章目以降の各章（空の章を除く）と、章の中の<!-- pagebreak -->の後が新しいページから始まる。
    assert.deepEqual(book.paragraphs.filter((paragraph) => paragraph.pageBreak).map((paragraph) => paragraph.text),
      ['基本記法', '改ページの後', '図の章', '図表', 'リンクの章', 'Textile の章', '混在記法の章', 'スライド1', '記号を含む名前の章']);
    assert.match(book.parts.get('docProps/core.xml').toString('utf8'), /<dc:title>結合テスト総合マニュアル<\/dc:title>/);
  });
});

/**
 * E1: サンプルの本の結合PDFで、しおりが各章のしおりを順に並べ、各章が単独の変換と同じページ数を占めて新しいページから始まり、
 * タイトルと用紙が先頭の章の設定になることを検証する。Marp の章は単独ではスライドとして別の用紙になるため除き、別に確かめる。
 * 単独の変換も先頭の章と同じ余白（設定ファイル）で行い、ページ数を比べられるようにする。
 */
test('E1: the merged PDF of the sample book outlines every chapter on its own pages', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await copyFixtures(directory);
    await writeFiles(directory, { 'export.json': JSON.stringify({ pdf: { margins: { top: 12 } } }) });
    const chapters = BOOK.filter((name) => !name.endsWith('07-marp.md'));
    const merged = await run([...chapters, '--merge', '-o', 'book.pdf', '--config', 'export.json'], { cwd: directory });
    assert.equal(merged.code, 0, merged.stderr);
    const book = readPdf(await readFile(path.join(directory, 'book.pdf')));
    assert.equal(book.title, '結合テスト総合マニュアル');
    assertPageSize(book.size, [595.92, 842.88], 'A4');
    let page = 1;
    const outline = [];
    for (const [index, name] of chapters.entries()) {
      const output = path.join(directory, 'single', `${index}.pdf`);
      const single = await run([name, '--format', 'pdf', '-o', output, '--config', 'export.json'], { cwd: directory });
      assert.equal(single.code, 0, `${name}\n${single.stderr}`);
      const chapter = readPdf(await readFile(output));
      // 中身のない章（空・front matter だけ）は単独では白紙1ページだが、結合ではページを増やさない。
      if (!chapter.outline.length) continue;
      outline.push(...chapter.outline.map((item) => ({ title: item.title, page: item.page + page - 1 })));
      page += chapter.pages;
    }
    assert.deepEqual(book.outline, outline);
    assert.equal(book.pages, page - 1);

    // Marp の章は通常の文書として結合し、スライドの見出しもしおりに入る。用紙は先頭の章（A4 縦）のまま。
    const withMarp = await run(['book/00-cover.md', 'book/07-marp.md', '--merge', '-o', 'marp.pdf'], { cwd: directory });
    assert.equal(withMarp.code, 0, withMarp.stderr);
    assert.match(withMarp.stderr, /07-marp\.md: Marp slides were merged as a regular document\./);
    const marp = readPdf(await readFile(path.join(directory, 'marp.pdf')));
    assert.deepEqual(marp.outline.map((item) => item.title), ['表紙', 'この本の使い方', '概要', 'スライド1', 'スライド2']);
    assertPageSize(marp.size, [595.92, 842.88], 'A4 with Marp');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// F: 画像
// ---------------------------------------------------------------------------------------------------------------

/**
 * F1: 同じ名前の画像（PNG・JPEG・GIF・WebP・SVG）を各文書の場所から読み、別の文書の場所の同名ファイルを使わないことを、
 * 各文書を単独で変換した結果の画像と比べて検証する。2件目にしかない参照先が1件目の場所にあっても読まず、警告はその文書へ付く。
 */
test('F1: images with the same names in different directories are never mixed up', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    const doc = (title) => `# ${title}\n\n![png](figure.png)\n\n![jpg](figure.jpg)\n\n![gif](figure.gif)\n\n![webp](figure.webp)\n\n![svg](figure.svg)\n\n![only](only-in-a.png)\n`;
    await copyFixtures(directory);
    await writeFiles(directory, {
      'a/doc.md': doc('A'),
      'a/only-in-a.png': greenPng,
      'b/doc.md': doc('B'),
      'b/figure.png': bluePng,
      'b/figure.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#00ffff"/></svg>',
    });
    for (const name of ['figure.png', 'figure.jpg', 'figure.gif', 'figure.webp', 'figure.svg']) {
      await cp(path.join(directory, 'book', '02-figures', name), path.join(directory, 'a', name));
    }
    await cp(path.join(directory, 'book', '02-figures', 'figure.jpg'), path.join(directory, 'b', 'figure.jpg'));
    await writeFiles(directory, { 'b/figure.gif': await readFile(path.join(directory, 'book', '02-figures', 'figure.gif')) });
    await writeFiles(directory, { 'b/figure.webp': await readFile(path.join(directory, 'book', '02-figures', 'figure.webp')) });
    const merged = await run(['a/doc.md', 'b/doc.md', '--merge', '-o', 'merged.docx', '--json'], { cwd: directory });
    assert.equal(merged.code, 0, merged.stderr);
    const media = readDocx(await readFile(path.join(directory, 'merged.docx'))).media;
    const singles = [];
    for (const name of ['a', 'b']) {
      const single = await run([`${name}/doc.md`, '--format', 'docx', '-o', `${name}.docx`], { cwd: directory });
      assert.equal(single.code, 0, single.stderr);
      singles.push(...readDocx(await readFile(path.join(directory, `${name}.docx`))).media);
    }
    assert.deepEqual(media, singles);
    assert.equal(media.length, 11, 'five images per document plus a/only-in-a.png');
    const report = JSON.parse(merged.stdout);
    assert.ok(report.results[1].warnings.some((warning) => /only-in-a\.png/.test(warning)), report.results[1].warnings.join('\n'));
    assert.ok(!report.results[0].warnings.some((warning) => /Local file/.test(warning)), report.results[0].warnings.join('\n'));
  });
});

/**
 * F2: --restrict-local-files の基準が文書ごとのディレクトリ（または --workspace-root）になることを検証する。
 * 回帰リスク: 先頭の文書の場所を基準にして、2件目の文書から外部のファイルを読める、または読めるはずの画像を拒否する。
 */
test('F2: --restrict-local-files applies to each merged document', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await writeFiles(directory, {
      'outside.png': bluePng,
      'docs/a.md': '# A\n\n![inside](sub/inside.png)\n',
      'docs/sub/inside.png': redPng,
      'docs/sub/b.md': '# B\n\n![outside](../../outside.png)\n\n![sibling](inside.png)\n',
    });
    const media = async (file) => readDocx(await readFile(path.join(directory, file))).media.length;
    const restricted = await run(['docs/a.md', 'docs/sub/b.md', '--merge', '-o', 'restricted.docx', '--restrict-local-files'], { cwd: directory });
    assert.equal(restricted.code, 0, restricted.stderr);
    assert.match(restricted.stderr, /sub[\\/]b\.md: .*outside\.png/);
    assert.doesNotMatch(restricted.stderr, /a\.md: .*inside/);
    assert.equal(await media('restricted.docx'), 2, 'a/sub/inside.png and b/inside.png are inside each document directory');
    const rooted = await run(['docs/a.md', 'docs/sub/b.md', '--merge', '-o', 'rooted.docx', '--restrict-local-files', '--workspace-root', '.'], { cwd: directory });
    assert.equal(rooted.code, 0, rooted.stderr);
    assert.equal(await media('rooted.docx'), 3);
    const narrow = await run(['docs/a.md', 'docs/sub/b.md', '--merge', '-o', 'narrow.docx', '--restrict-local-files', '--workspace-root', 'docs/sub'], { cwd: directory });
    assert.equal(narrow.code, 0, narrow.stderr);
    assert.equal(await media('narrow.docx'), 2, 'docs/a.md is outside docs/sub, so its image is refused');
    const open = await run(['docs/a.md', 'docs/sub/b.md', '--merge', '-o', 'open.docx'], { cwd: directory });
    assert.equal(open.code, 0, open.stderr);
    assert.equal(await media('open.docx'), 3);
  });
});

/**
 * F3: リモート画像を各文書から取得し、`rendering.remoteImagesEnabled: false`では取得も表示もしないことを、
 * テスト内の HTTP サーバーへの要求数で検証する。
 */
test('F3: remote images are fetched for every document and can be disabled', needsBrowser, async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(request.url.includes('blue') ? bluePng : redPng);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await withDirectory(async (directory) => {
      await writeFiles(directory, {
        'a.md': `# A\n\n![red](${base}/red.png)\n`,
        'b.md': `# B\n\n![blue](${base}/blue.png)\n`,
        'off.json': JSON.stringify({ rendering: { remoteImagesEnabled: false } }),
      });
      const shown = await run(['a.md', 'b.md', '--merge', '-o', 'shown.docx', '--no-config'], { cwd: directory });
      assert.equal(shown.code, 0, shown.stderr);
      assert.ok(requests.some((url) => url.startsWith('/red.png')) && requests.some((url) => url.startsWith('/blue.png')), requests.join(', '));
      assert.equal(readDocx(await readFile(path.join(directory, 'shown.docx'))).media.length, 2);
      requests.length = 0;
      const hidden = await run(['a.md', 'b.md', '--merge', '-o', 'hidden.docx', '--config', 'off.json'], { cwd: directory });
      assert.equal(hidden.code, 0, hidden.stderr);
      assert.deepEqual(requests, []);
      assert.equal(readDocx(await readFile(path.join(directory, 'hidden.docx'))).media.length, 0);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// G: ページ設定と front matter
// ---------------------------------------------------------------------------------------------------------------

/**
 * G1: ページ設定が「設定ファイル → 先頭の文書の front matter」の順で決まり、2件目以降の front matter の設定は
 * 警告して無視することを、PDF の用紙で検証する。2件目以降に設定がなければ警告しない。
 */
test('G1: page settings come from the configuration and the first document only', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await writeFiles(directory, {
      'export.json': JSON.stringify({ pdf: { format: 'A5' } }),
      'wide.md': '---\nmve-convert:\n  pdf:\n    orientation: landscape\n---\n# Wide\n',
      'b5.md': '---\nmve-convert:\n  pdf:\n    format: B5\n---\n# B5\n',
      'plain.md': '# Plain\n',
      'empty-settings.md': '---\nmve-convert: {}\n---\n# Empty settings\n',
    });
    const cases = [
      [['wide.md', 'plain.md'], [595.92, 419.53], []],
      [['wide.md', 'b5.md'], [595.92, 419.53], ['b5.md']],
      [['plain.md', 'wide.md', 'b5.md'], [419.53, 595.92], ['wide.md', 'b5.md']],
      // B5 は JIS の寸法（182 x 257 mm）。
      [['b5.md', 'plain.md'], [516, 729.12], []],
      [['plain.md', 'empty-settings.md'], [419.53, 595.92], []],
    ];
    for (const [inputs, size, ignored] of cases) {
      const result = await run([...inputs, '--merge', '-o', 'out.pdf', '--force', '--config', 'export.json'], { cwd: directory });
      assert.equal(result.code, 0, result.stderr);
      assertPageSize(readPdf(await readFile(path.join(directory, 'out.pdf'))).size, size, inputs.join(' '));
      const warned = lines(result.stderr).filter((line) => /settings were ignored/.test(line))
        .map((line) => path.basename(line.slice(0, line.indexOf(': '))));
      assert.deepEqual(warned, ignored, inputs.join(' '));
    }
  });
});

/**
 * G2: front matter の各種パターンを検証する。2件目以降の title は使わない、`--front-matter render`では各文書の front matter を
 * 本文に残す、YAML の対応付けでない先頭の`---`ブロックは本文として残す、mve-convert の誤記は先頭でも2件目以降でも
 * その文書のパスを付けて終了コード2で止め、何も書かない。
 */
test('G2: front matter in each merged document', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await writeFiles(directory, {
      'a.md': '# First heading\n',
      'titled.md': '---\ntitle: Second title\n---\n# Second heading\n',
      'list.md': '---\n- item one\n- item two\n---\n# List front matter\n',
      'bad.md': '---\nmve-convert:\n  pdf:\n    format: Letter\n---\n# Bad\n',
      'bad2.md': '---\nmve-convert:\n  html: {}\n---\n# Bad 2\n',
    });
    const titled = await run(['a.md', 'titled.md', '--merge', '-o', 'titled.docx'], { cwd: directory });
    assert.equal(titled.code, 0, titled.stderr);
    const docx = readDocx(await readFile(path.join(directory, 'titled.docx')));
    assert.match(docx.parts.get('docProps/core.xml').toString('utf8'), /<dc:title>First heading<\/dc:title>/);
    assert.ok(!docx.body.some((text) => /Second title/.test(text)));
    const rendered = await run(['a.md', 'titled.md', '--merge', '-o', 'rendered.docx', '--front-matter', 'render'], { cwd: directory });
    assert.equal(rendered.code, 0, rendered.stderr);
    assert.ok(readDocx(await readFile(path.join(directory, 'rendered.docx'))).body.some((text) => /title: Second title/.test(text)));
    const list = await run(['a.md', 'list.md', '--merge', '-o', 'list.docx'], { cwd: directory });
    assert.equal(list.code, 0, list.stderr);
    const listBody = readDocx(await readFile(path.join(directory, 'list.docx'))).body;
    assert.ok(listBody.includes('item one') && listBody.includes('item two'), listBody.join(' | '));
    for (const [inputs, failing, message] of [
      [['bad.md', 'a.md'], 'bad.md', /Invalid front matter mve-convert: Invalid pdf\.format\./],
      [['a.md', 'bad.md'], 'bad.md', /Invalid front matter mve-convert: Invalid pdf\.format\./],
      [['a.md', 'bad2.md', 'bad.md'], 'bad2.md', /Invalid front matter mve-convert: Unknown mve-convert key: html/],
    ]) {
      const result = await run([...inputs, '--merge', '-o', 'bad.pdf', '--json'], { cwd: directory });
      assert.equal(result.code, 2, result.stderr);
      assert.equal(lines(result.stderr).length, 1, result.stderr);
      assert.ok(result.stderr.startsWith(`${path.join(directory, failing)}: `), result.stderr);
      assert.match(result.stderr, message);
      const report = JSON.parse(result.stdout);
      assert.equal(report.results.length, inputs.length);
      assert.ok(report.results.every((record) => record.outputs.length === 0 && message.test(record.error)));
      await assert.rejects(readFile(path.join(directory, 'bad.pdf')), { code: 'ENOENT' });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// H: タイトル・置換・ヘッダー/フッター・CSS・言語
// ---------------------------------------------------------------------------------------------------------------

/**
 * H1: タイトルが --title、先頭の文書の front matter、結合後の最初の H1（2件目以降の H1 も含む）、先頭のファイル名
 * （拡張子なし）の順で決まることを、PDF の文書情報と DOCX の文書のプロパティの両方で検証する。
 */
test('H1: the merged title follows --title, front matter, the first heading, then the file name', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await writeFiles(directory, {
      'fm.md': '---\ntitle: "Front & <matter>"\n---\n# Heading one\n',
      'h1.md': '# C++ heading\n',
      'h2only.md': '## Not a title\n\nText.\n',
      'plain.md': 'No heading.\n',
    });
    const cases = [
      [['fm.md', 'h1.md', '--title', 'Explicit title'], 'Explicit title'],
      [['fm.md', 'h1.md'], 'Front & <matter>'],
      [['h1.md', 'fm.md'], 'C++ heading'],
      [['h2only.md', 'h1.md'], 'C++ heading'],
      [['plain.md', 'h2only.md'], 'plain'],
    ];
    for (const [argv, title] of cases) {
      for (const format of ['pdf', 'docx']) {
        const result = await run([...argv, '--merge', '-o', `t.${format}`, '--force'], { cwd: directory });
        assert.equal(result.code, 0, result.stderr);
        const bytes = await readFile(path.join(directory, `t.${format}`));
        const actual = format === 'pdf' ? readPdf(bytes).title
          : decodeXml(/<dc:title>([^<]*)<\/dc:title>/.exec(readDocx(bytes).parts.get('docProps/core.xml').toString('utf8'))?.[1] ?? '');
        assert.equal(actual, title, `${format} ${argv.join(' ')}`);
      }
    }
  });
});

/**
 * H2: 出力置換（textReplacements）が全文書の本文・タイトル・ヘッダーへ効き、ヘッダー/フッターのプレースホルダーが
 * 結合後のタイトル・先頭の文書の名前・日付・ページ番号になることを、DOCX のヘッダー/フッターで検証する。
 */
test('H2: replacements and header placeholders apply to the whole merged output', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await writeFiles(directory, {
      'first.md': '# SECRET handbook\n\nSECRET in the first document.\n',
      'second.md': '# Second\n\nSECRET in the second document.\n\n| SECRET |\n| --- |\n| cell SECRET |\n',
      'export.json': JSON.stringify({
        pdf: { header: '{title}|{file}|{date}', footer: '{page}/{pages}', textReplacements: [{ pattern: 'SECRET', replacement: 'public' }] }
      }),
    });
    const result = await run(['first.md', 'second.md', '--merge', '-o', 'out.docx', '--config', 'export.json'], { cwd: directory });
    assert.equal(result.code, 0, result.stderr);
    const docx = readDocx(await readFile(path.join(directory, 'out.docx')));
    assert.ok(!docx.body.some((text) => /SECRET/.test(text)), docx.body.join(' | '));
    assert.ok(docx.body.includes('public in the second document.'));
    assert.ok(docx.body.includes('cell public'));
    const header = decodeXml([...docx.parts.get('word/header1.xml').toString('utf8').matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join(''));
    assert.match(header, /^public handbook\|first\.md\|\d{4}-\d{2}-\d{2}$/);
    const footer = docx.parts.get('word/footer1.xml').toString('utf8');
    assert.match(footer, /PAGE/);
    assert.match(footer, /NUMPAGES/);
    assert.match(docx.parts.get('docProps/core.xml').toString('utf8'), /<dc:title>public handbook<\/dc:title>/);
  });
});

/**
 * H3: 利用者の CSS（--css）と言語（--language）が結合した出力にも効くことを検証する。
 * CSS の見出しの色は Word の見出しのスタイルの色になり、言語は目次の見出しの文言になる。
 */
test('H3: --css and --language apply to merged output', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await writeFiles(directory, {
      'a.md': '# A\n\n[toc]\n',
      'b.md': '# B\n',
      'red.css': '.mve-print h1, h1 { color: rgb(200, 0, 0) !important; }\n',
    });
    for (const [language, label] of [['ja', '目次'], ['en', 'Table of contents'], ['de', 'Inhaltsverzeichnis']]) {
      const result = await run(['a.md', 'b.md', '--merge', '-o', `${language}.docx`, '--language', language, '--css', 'red.css'], { cwd: directory });
      assert.equal(result.code, 0, result.stderr);
      const docx = readDocx(await readFile(path.join(directory, `${language}.docx`)));
      assert.deepEqual(docx.paragraphs.filter((paragraph) => paragraph.style === 'TOCHeading').map((paragraph) => paragraph.text), [label]);
      assert.match(docx.parts.get('word/styles.xml').toString('utf8'), /w:styleId="Heading1"[\s\S]*?w:color w:val="C80000"/);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// I: 失敗
// ---------------------------------------------------------------------------------------------------------------

/**
 * I1: 出力先の衝突（既存のファイル、入力と同じパス、大文字小文字だけ違うパス、入力へのハードリンク）では、
 * --force の有無にかかわらず入力を壊さず、既存の出力を --force なしでは上書きしないことを検証する。
 */
test('I1: output collisions never overwrite inputs or existing files', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await writeFiles(directory, { 'a.md': '# A\n', 'b.md': '# B\n', 'exists.pdf': 'sentinel' });
    const exists = await run(['a.md', 'b.md', '--merge', '-o', 'exists.pdf'], { cwd: directory });
    assert.equal(exists.code, 1);
    assert.match(exists.stderr, /Output already exists/);
    assert.equal(await readFile(path.join(directory, 'exists.pdf'), 'utf8'), 'sentinel');
    for (const output of ['b.md', process.platform === 'win32' ? 'B.MD' : undefined].filter(Boolean)) {
      for (const force of [[], ['--force']]) {
        const same = await run(['a.md', 'b.md', '--merge', '--format', 'pdf', '-o', output, ...force], { cwd: directory });
        assert.equal(same.code, 1, `${output} ${force}`);
        assert.match(same.stderr, /Output must differ from input/);
      }
    }
    let linked = false;
    try {
      await link(path.join(directory, 'a.md'), path.join(directory, 'alias.pdf'));
      linked = true;
    } catch {
      // ハードリンクを作れないファイルシステムでは、この確認を省く。
    }
    if (linked) {
      const alias = await run(['a.md', 'b.md', '--merge', '-o', 'alias.pdf', '--force'], { cwd: directory });
      assert.equal(alias.code, 1);
      assert.match(alias.stderr, /Output must differ from input/);
    }
    assert.equal(await readFile(path.join(directory, 'a.md'), 'utf8'), '# A\n');
    assert.equal(await readFile(path.join(directory, 'b.md'), 'utf8'), '# B\n');
    const forced = await run(['a.md', 'b.md', '--merge', '-o', 'exists.pdf', '--force'], { cwd: directory });
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(readPdf(await readFile(path.join(directory, 'exists.pdf'))).pages, 2);
  });
});

/**
 * I2: 入力の誤り（存在しないファイル、ディレクトリ、何にも一致しないワイルドカード）では、原因を示して終了コード1で止め、
 * 何も書かないことを検証する。失敗する入力が何件目でも同じ。
 */
test('I2: input errors name the document and write nothing', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await writeFiles(directory, { 'a.md': '# A\n', 'folder.md/inner.md': '# Inner\n' });
    for (const [inputs, message] of [
      [['missing.md', 'a.md'], /missing\.md: .*(?:ENOENT|no such file)/i],
      [['a.md', 'missing.md'], /missing\.md: .*(?:ENOENT|no such file)/i],
      [['a.md', 'folder.md'], /folder\.md: Input must be a file\./],
      [['a.md', 'nothing/*.md'], /No documents matched: nothing\/\*\.md/],
    ]) {
      const result = await run([...inputs, '--merge', '-o', 'out.pdf'], { cwd: directory });
      assert.equal(result.code, 1, `${inputs.join(' ')}\n${result.stderr}`);
      assert.match(result.stderr, message);
      await assert.rejects(readFile(path.join(directory, 'out.pdf')), { code: 'ENOENT' });
    }
  });
});

/**
 * I3: 図や数式の失敗では結合を止めず、その文書の警告として報告することを検証する。--strict では終了コード1だが出力は書く。
 */
test('I3: diagram and math failures do not stop the merge', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await writeFiles(directory, {
      'math.md': '# Math\n\nBroken $\\frac{1}{$ math.\n',
      'diagram.md': '# Diagram\n\n```mermaid\ngraph TD\n  A -->\n```\n\n```mermaid\ngraph TD\n  A --> B\n```\n',
    });
    for (const strict of [false, true]) {
      const result = await run(['math.md', 'diagram.md', '--merge', '-o', 'out.docx', '--force', ...(strict ? ['--strict'] : [])], { cwd: directory });
      assert.equal(result.code, strict ? 1 : 0, result.stderr);
      assert.match(result.stderr, /diagram\.md: Mermaid diagram 1 could not be rendered/);
      const docx = readDocx(await readFile(path.join(directory, 'out.docx')));
      assert.deepEqual(docx.headings.map((heading) => heading.text), ['Math', 'Diagram']);
      assert.equal(docx.media.length >= 1, true);
    }
  });
});

/**
 * I4: 生成のタイムアウトとブラウザーの起動失敗では、終了コード1で止め、何も書かないことを検証する。
 */
test('I4: render timeouts and browser failures write nothing', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await writeFiles(directory, { 'a.md': '# A\n', 'b.md': '# B\n' });
    const timeout = await run(['a.md', 'b.md', '--merge', '-o', 'out.pdf', '--render-timeout', '0.001'], { cwd: directory });
    assert.equal(timeout.code, 1, timeout.stderr);
    await assert.rejects(readFile(path.join(directory, 'out.pdf')), { code: 'ENOENT' });
    const browser = await execute(process.execPath, [cli, 'a.md', 'b.md', '--merge', '-o', 'out.docx',
      '--browser', path.join(directory, 'no-such-browser.exe'), '--browser-timeout', '5'], { cwd: directory }).then(
      () => ({ code: 0 }), (error) => ({ code: error.code, stderr: error.stderr }));
    assert.equal(browser.code, 1, browser.stderr);
    await assert.rejects(readFile(path.join(directory, 'out.docx')), { code: 'ENOENT' });
  });
});

/**
 * I5: 結合の途中の中断（Ctrl+C）で、終了コード130で速やかに終わり、何も書かず、--json に全入力の中断を記録することを検証する。
 * Windows では子プロセスへ SIGINT を送れないため、図の描画のタイマー（180秒）が設定された時点で SIGINT を発生させる
 * 読み込み前のスクリプトを使う（既存の中断テストと同じ方法）。
 */
test('I5: an interrupt during a merge exits with 130 and writes nothing', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await writeFiles(directory, {
      'a.md': '# A\n',
      'b.md': '# B\n\n```mermaid\ngraph TD\n  A --> B\n```\n',
      'interrupt.cjs': [
        'const original = globalThis.setTimeout;',
        'let fired = false;',
        'globalThis.setTimeout = function (callback, delay, ...rest) {',
        '  if (delay === 180000 && !fired) {',
        '    fired = true;',
        "    original(() => process.emit('SIGINT'), 0);",
        '  }',
        '  return original(callback, delay, ...rest);',
        '};',
        ''
      ].join('\n'),
    });
    const started = performance.now();
    const result = await run(['a.md', 'b.md', '--merge', '-o', 'out.pdf', '--json'],
      { cwd: directory, node: ['--require', path.join(directory, 'interrupt.cjs')] });
    assert.equal(result.code, 130, result.stderr);
    assert.ok(performance.now() - started < 60_000);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.deepEqual(report.results.map((record) => [path.basename(record.input), record.outputs, record.error]),
      [['a.md', [], 'Conversion was interrupted.'], ['b.md', [], 'Conversion was interrupted.']]);
    await assert.rejects(readFile(path.join(directory, 'out.pdf')), { code: 'ENOENT' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// J: 出力の方法
// ---------------------------------------------------------------------------------------------------------------

/**
 * J1: `-o -`で結合結果のバイト列だけを標準出力へ書き、警告は標準エラーへ出すことを検証する（PDF と DOCX）。
 * 標準出力の内容は、同じ入力をファイルへ書いた結果と同じ構造になる。
 */
test('J1: merged output can be written to standard output', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await writeFiles(directory, { 'a.md': '# A\n', 'b.md': '# B\n\n![missing](missing.png)\n' });
    const pdf = await runBinary(['a.md', 'b.md', '--merge', '--format', 'pdf', '-o', '-'], directory);
    assert.equal(pdf.code, 0, pdf.stderr);
    assert.equal(pdf.stdout.toString('latin1', 0, 5), '%PDF-');
    assert.deepEqual(readPdf(pdf.stdout).outline.map((item) => [item.title, item.page]), [['A', 1], ['B', 2]]);
    assert.match(pdf.stderr, /b\.md: Local file "missing\.png" could not be read\./);
    const docx = await runBinary(['a.md', 'b.md', '--merge', '-o', '-', '--format', 'docx'], directory);
    assert.equal(docx.code, 0, docx.stderr);
    assert.deepEqual(readDocx(docx.stdout).headings.map((heading) => heading.text), ['A', 'B']);
  });
});

/**
 * J2: 通常の出力・--json・--strict・--force・存在しないディレクトリへの出力の組み合わせを検証する。
 * 標準出力には結合先が1行だけ出る、--json は入力ごとの記録で全入力の outputs が同じ結合先、警告は原因の文書の記録へ入る、
 * --strict は警告を失敗として数えるが出力は書く。
 */
test('J2: --json, --strict, --force, and new output directories', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await writeFiles(directory, { 'a.md': '# A\n', 'b.md': '# B\n\n![missing](missing.png)\n', 'c.md': '# C\n' });
    const output = path.join(directory, 'new', 'deep', 'book.pdf');
    const plain = await run(['a.md', 'b.md', 'c.md', '--merge', '-o', output], { cwd: directory });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, `${output}\n`);
    assert.equal(readPdf(await readFile(output)).pages, 3);
    const strict = await run(['a.md', 'b.md', 'c.md', '--merge', '-o', output, '--force', '--json', '--strict'], { cwd: directory });
    assert.equal(strict.code, 1, strict.stderr);
    assert.match(strict.stderr, /1 warning\(s\) treated as errors by --strict\./);
    const report = JSON.parse(strict.stdout);
    assert.equal(report.ok, false);
    assert.deepEqual(report.results.map((record) => [path.basename(record.input), record.outputs, record.warnings.length, record.error]),
      [['a.md', [output], 0, undefined], ['b.md', [output], 1, undefined], ['c.md', [output], 0, undefined]]);
    const single = await run(['c.md', '--merge', '-o', output, '--force', '--json'], { cwd: directory });
    assert.equal(single.code, 0, single.stderr);
    assert.deepEqual(JSON.parse(single.stdout), { ok: true, results: [{ input: path.join(directory, 'c.md'), outputs: [output], warnings: [] }] });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// K・L: 順序・重複・文字コード・ファイル名
// ---------------------------------------------------------------------------------------------------------------

/**
 * K1: 結合の順序がコマンドラインの順になり、ワイルドカードはパターンごとにパスの順（文字の順）で展開し、
 * 重複する指定（同じファイル、パターンとの重なり、Windows での大文字小文字違い）は最初の1回だけ結合することを検証する。
 */
test('K1: documents are merged in command-line order without duplicates', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await writeFiles(directory, {
      'c.md': '# C\n', 'b.md': '# B\n', 'a.md': '# A\n',
      'p/10.md': '# P10\n', 'p/2.md': '# P2\n', 'p/a.md': '# Pa\n', 'p/.hidden.md': '# Hidden\n', 'p/note.txt': 'x',
    });
    const cases = [
      [['c.md', 'b.md', 'a.md'], ['C', 'B', 'A']],
      [['p/*.md'], ['P10', 'P2', 'Pa']],
      [['p/2.md', 'p/*.md', 'a.md'], ['P2', 'P10', 'Pa', 'A']],
      [['a.md', 'a.md', './a.md', 'b.md'], ['A', 'B']],
    ];
    if (process.platform === 'win32') cases.push([['a.md', 'A.MD', 'b.md'], ['A', 'B']]);
    for (const [inputs, headings] of cases) {
      const result = await run([...inputs, '--merge', '-o', 'order.docx', '--force', '--json'], { cwd: directory });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(readDocx(await readFile(path.join(directory, 'order.docx'))).headings.map((heading) => heading.text), headings, inputs.join(' '));
      assert.equal(JSON.parse(result.stdout).results.length, headings.length);
    }
  });
});

/**
 * L1: BOM・CRLF・CR だけの改行、空白・`#`・`%`・日本語・絵文字を含むファイル名とディレクトリ名の文書を結合し、
 * 見出しとリンクが保たれることを検証する。
 */
test('L1: encodings, line endings, and unusual file names', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await writeFiles(directory, {
      'index.md': '# Index\n\n[bom](%E7%AB%A0%20one/bom.md#crlf-section) [cr](cr.md) [odd](odd%20%23%20%25%20name%20%F0%9F%98%80.md#emoji)\n',
      '章 one/bom.md': '\uFEFF# BOM chapter\r\n\r\n## CRLF section\r\n\r\nText.\r\n',
      'cr.md': '# CR chapter\r\rLine one.\r',
      'odd # % name 😀.md': '# Odd name\n\n## Emoji\n',
    });
    const result = await run(['index.md', '章 one/bom.md', 'cr.md', 'odd # % name 😀.md', '--merge', '-o', 'out dir/結合 #1.docx'], { cwd: directory });
    assert.equal(result.code, 0, result.stderr);
    const docx = readDocx(await readFile(path.join(directory, 'out dir', '結合 #1.docx')));
    assert.deepEqual(docx.headings.map((heading) => heading.text), ['Index', 'BOM chapter', 'CRLF section', 'CR chapter', 'Odd name', 'Emoji']);
    const links = docx.paragraphs.find((paragraph) => paragraph.text.startsWith('bom')).anchors;
    assert.deepEqual(links, [docx.headings[2].bookmark, docx.headings[3].bookmark, docx.headings[5].bookmark]);
    assert.ok(!docx.body.some((text) => /\uFEFF/.test(text)));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// M: 監視
// ---------------------------------------------------------------------------------------------------------------

/**
 * M1: --watch と --merge で、どの入力が変わっても全入力から作り直し、途中で失敗しても監視を続けて回復後に作り直し、
 * 実行前からあった結合先は --force なしでは上書きしないことを検証する。
 * Windows では子プロセスへ SIGINT を送れないため、停止用ファイルを見て SIGINT を発生させる読み込み前のスクリプトを使う。
 */
test('M1: --watch rebuilds the merged output, survives failures, and protects existing files', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    const stop = path.join(directory, 'stop');
    await writeFiles(directory, {
      'a.md': '# Alpha\n',
      'b.md': '# Beta first\n',
      'existing.docx': 'sentinel',
      'stop.cjs': [
        "const fs = require('node:fs');",
        `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) { clearInterval(timer); process.emit('SIGINT'); } }, 50);`,
        'timer.unref();',
        ''
      ].join('\n')
    });
    /** 監視を始め、出力を集め、条件を待つ道具を返す。 */
    const watch = (output) => {
      const child = spawn(process.execPath, ['--require', path.join(directory, 'stop.cjs'), cli, 'a.md', 'b.md', '--merge', '-o', output, '--watch',
        '--browser', browserPath, '--browser-timeout', '30'], { cwd: directory });
      const state = { stdout: '', stderr: '' };
      child.stdout.on('data', (chunk) => { state.stdout += chunk; });
      child.stderr.on('data', (chunk) => { state.stderr += chunk; });
      const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
      const waitFor = async (condition, label) => {
        const deadline = Date.now() + 90_000;
        while (!condition(state)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\nstdout: ${state.stdout}\nstderr: ${state.stderr}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      return { state, exited, waitFor };
    };
    const output = path.join(directory, 'book.docx');
    const headings = async () => readDocx(await readFile(output)).headings.map((heading) => heading.text);
    const first = watch(output);
    try {
      await first.waitFor((state) => /Watching 2 file\(s\)/.test(state.stderr), 'the watcher to start');
      assert.deepEqual(await headings(), ['Alpha', 'Beta first']);
      await writeFile(path.join(directory, 'b.md'), '# Beta second\n');
      await first.waitFor((state) => state.stdout.split(output).length - 1 >= 2, 'a rebuild after b.md changed');
      assert.deepEqual(await headings(), ['Alpha', 'Beta second']);
      await writeFile(path.join(directory, 'a.md'), '---\nmve-convert:\n  pdf:\n    format: Letter\n---\n# Alpha broken\n');
      await first.waitFor((state) => /a\.md: Invalid front matter/.test(state.stderr), 'the failure to be reported');
      assert.deepEqual(await headings(), ['Alpha', 'Beta second'], 'the previous output is kept');
      await writeFile(path.join(directory, 'a.md'), '# Alpha fixed\n');
      await first.waitFor((state) => state.stdout.split(output).length - 1 >= 3, 'a rebuild after the fix');
      assert.deepEqual(await headings(), ['Alpha fixed', 'Beta second']);
      assert.doesNotMatch(first.state.stderr, /Output already exists/);
    } finally {
      await writeFile(stop, '');
    }
    assert.equal(await first.exited, 130, first.state.stderr);
    await rm(stop);

    const existing = path.join(directory, 'existing.docx');
    const second = watch(existing);
    try {
      await second.waitFor((state) => /Watching 2 file\(s\)/.test(state.stderr), 'the second watcher to start');
      assert.match(second.state.stderr, /Output already exists/);
      await writeFile(path.join(directory, 'a.md'), '# Alpha again\n');
      await second.waitFor((state) => state.stderr.split('Output already exists').length - 1 >= 2, 'the protected output to be refused again');
      assert.equal(await readFile(existing, 'utf8'), 'sentinel');
    } finally {
      await writeFile(stop, '');
    }
    assert.equal(await second.exited, 130, second.state.stderr);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// N・O: 規模と互換性
// ---------------------------------------------------------------------------------------------------------------

/**
 * N1: 40文書（各文書に同名の見出し・脚注・次の文書の同名の見出しへのリンク）を結合し、全見出しのしおりが一意で、
 * 全リンクが正しい次の文書の見出しを指すことを検証する。所要時間を出力する。
 */
test('N1: forty documents with identical headings link to the right chapters', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    const count = 40;
    const files = {};
    for (let index = 0; index < count; index += 1) {
      const next = (index + 1) % count;
      files[`ch/${String(index).padStart(2, '0')}.md`] = `# Chapter ${index}\n\n## 概要\n\n[next ${index}](${String(next).padStart(2, '0')}.md#概要)\n\n`
        + `## 詳細\n\nNote[^1].\n\n[^1]: Footnote ${index}.\n`;
    }
    await writeFiles(directory, files);
    const started = performance.now();
    const result = await run(['ch/*.md', '--merge', '-o', 'big.docx'], { cwd: directory });
    console.log(`# N1: merging ${count} documents to DOCX took ${(performance.now() - started).toFixed(0)} ms`);
    assert.equal(result.code, 0, result.stderr);
    const docx = readDocx(await readFile(path.join(directory, 'big.docx')));
    assert.equal(docx.headings.length, count * 3);
    assert.equal(new Set(docx.headings.map((heading) => heading.bookmark)).size, count * 3);
    for (let index = 0; index < count; index += 1) {
      const paragraph = docx.paragraphs.find((item) => item.text === `next ${index}`);
      assert.deepEqual(paragraph.anchors, [docx.headings[((index + 1) % count) * 3 + 1].bookmark], `link ${index}`);
    }
    assert.deepEqual(docx.footnotes, Array.from({ length: count }, (_, index) => `Footnote ${index}.`));
  });
});

/**
 * O1: 1文書だけの --merge が、同じ文書の通常の変換と同じ内容（DOCX の本文・画像・見出し、PDF のページ数・しおり・タイトル）に
 * なることを、サンプルの本の各種の章で検証する（Marp は PDF ではスライドになるため DOCX だけ比べる）。
 */
test('O1: a single input with --merge matches a normal conversion', needsBrowser, async () => {
  await withDirectory(async (directory) => {
    await copyFixtures(directory);
    for (const name of ['book/01-basics.md', 'book/02-figures/chapter.md', 'book/05-textile.textile', 'book/07-marp.md']) {
      const normal = await run([name, '--format', 'docx', '-o', 'normal.docx', '--force'], { cwd: directory });
      const merged = await run([name, '--merge', '-o', 'merged.docx', '--force'], { cwd: directory });
      assert.equal(normal.code, 0, normal.stderr);
      assert.equal(merged.code, 0, merged.stderr);
      const a = readDocx(await readFile(path.join(directory, 'normal.docx')));
      const b = readDocx(await readFile(path.join(directory, 'merged.docx')));
      assert.deepEqual(b.body, a.body, name);
      assert.deepEqual(b.media, a.media, name);
      assert.deepEqual(b.headings, a.headings, name);
      assert.deepEqual(b.footnotes, a.footnotes, name);
      if (name.endsWith('07-marp.md')) continue;
      const pdfNormal = await run([name, '--format', 'pdf', '-o', 'normal.pdf', '--force'], { cwd: directory });
      const pdfMerged = await run([name, '--merge', '-o', 'merged.pdf', '--force'], { cwd: directory });
      assert.equal(pdfNormal.code, 0, pdfNormal.stderr);
      assert.equal(pdfMerged.code, 0, pdfMerged.stderr);
      const x = readPdf(await readFile(path.join(directory, 'normal.pdf')));
      const y = readPdf(await readFile(path.join(directory, 'merged.pdf')));
      assert.deepEqual(y, x, name);
    }
  });
});
