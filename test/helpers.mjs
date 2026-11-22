/**
 * @fileoverview テスト全体で共有する補助処理。CLI の実行、一時ディレクトリ、DOCX（ZIP）と PDF の読み取りをまとめる。
 * 実行境界: Node（node:test のテストファイルから import する）。CLI は成果物 dist/mve-convert.cjs を使う。
 * 不変条件: 一時ディレクトリは OS の一時領域の中だけに作って消す。CLI は子プロセスで実行し、テストのプロセスへ影響を与えない。
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { promisify } from 'node:util';
import { findTestBrowser } from './browser.mjs';

/** CLI成果物。テストの配置から解決し、呼び出し側の作業ディレクトリに依存しない。 */
export const cli = fileURLToPath(new URL('../dist/mve-convert.cjs', import.meta.url));
/** 描画器の成果物。結合規則の単体検証で、実際の描画結果を作るために使う。 */
export const renderer = fileURLToPath(new URL('../dist/markdown-fallback.js', import.meta.url));
/** CLI が再公開する関数（parseArguments など）を成果物から読み込むための require。 */
export const requireCli = createRequire(import.meta.url);
/** 子プロセスの終了コードと出力を取得するためのPromise版。 */
const execute = promisify(execFile);
/** 描画に使用するブラウザー。 */
export const browserPath = findTestBrowser();
if (process.env.MVE_REQUIRE_BROWSER_TESTS === '1' && !browserPath) {
  throw new Error('Browser tests are required, but no Chromium/Edge/Chrome executable was found.');
}
/** ブラウザーを使うテストの共通設定。 */
export const needsBrowser = { skip: !browserPath };
/**
 * 1つのテストファイルの中で同時に実行するテストの数。テストは互いに独立した一時ディレクトリだけを使う。
 * node --test はテストファイル同士も並列に実行し（既定で CPU 数 - 1）、各テストは CLI を数個並行して起動するため、
 * ファイル内は CPU 数 ÷ 4（最小1）に抑え、同時に動くブラウザーがおおむね CPU 数に収まるようにする。
 * 抑えないと、CPU の奪い合いで変換が遅くなり、ブラウザーの起動待ちや出力置換の時間制限（2秒）に誤って達する。
 * `MVE_TEST_CONCURRENCY`で変えられる。
 */
export const concurrency = Number(process.env.MVE_TEST_CONCURRENCY) || Math.max(1, Math.floor(availableParallelism() / 4));

/** 1x1のPNG。画像の埋め込みの検証に使う。 */
export const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

/**
 * 意図した入力だけを用いる一時ディレクトリを作り、テスト終了後に解放する。
 * macOS の一時ディレクトリ（/var/...）は /private/var/... へのリンクで、CLI は実体のパスで入力を解決するため、実体のパスを渡す。
 * @param {(directory: string) => Promise<void>} callback - 一時ディレクトリ内で実行する検証。
 */
export async function withDirectory(callback) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'mve-test-')));
  try {
    await callback(directory);
  } finally {
    const relative = path.relative(await realpath(tmpdir()), directory);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative), 'refusing to remove a path outside the temp directory');
    // Windows では、終了した子プロセスやブラウザーがファイルを手放すまで少し遅れ、削除が EBUSY になることがあるため、やり直す。
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

/**
 * 一時ディレクトリへ複数のファイルを書く。親ディレクトリは作る。
 * @param {string} directory - 基準ディレクトリ。
 * @param {Record<string, string | Buffer>} files - 相対パスから内容への対応。
 */
export async function writeFiles(directory, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

/**
 * CLIを実行し、失敗しても終了コードと出力を返す。
 * ブラウザーの起動の待ち時間は、CI の初回起動の遅さで失敗しないよう30秒にする（`browser: false`なら付けない）。
 * @param {string[]} args - CLIの引数。
 * @param {{cwd?: string, browser?: boolean, node?: string[], input?: string, timeout?: number}} [options] - 作業ディレクトリ、
 *   ブラウザー引数を付けるか（既定は付ける）、Node へ渡す追加の引数（`--require`など）、標準入力、待ち時間の上限。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} 終了コードと出力。
 */
export function run(args, options = {}) {
  const browserArgs = options.browser === false ? [] : ['--browser', browserPath, '--browser-timeout', '30'];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(options.node ?? []), cli, ...args, ...browserArgs], { cwd: options.cwd });
    const stdout = [];
    let stderr = '';
    const timer = setTimeout(() => child.kill(), options.timeout ?? 180_000);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr, bytes: Buffer.concat(stdout) });
    });
    child.stdin.end(options.input ?? '');
  });
}

/**
 * CLIを実行し、成功を求める。失敗したら標準エラーを添えて例外にする。
 * @param {string[]} args - CLIの引数。
 * @param {Parameters<typeof run>[1]} [options] - `run`と同じ。
 * @returns {Promise<{code: number, stdout: string, stderr: string, bytes: Buffer}>} 出力。
 */
export async function runOk(args, options) {
  const result = await run(args, options);
  assert.equal(result.code, 0, `${args.join(' ')}\n${result.stderr}`);
  return result;
}

/** ブラウザーを使わない CLI の実行（引数・設定の誤りの検出など）。`execFile`より起動が軽い必要はないが、出力を文字列で返す。 */
export async function runWithoutBrowser(args, options = {}) {
  try {
    const result = await execute(process.execPath, [cli, ...args], { cwd: options.cwd, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

/**
 * ZIPの中央ディレクトリを読み、各エントリーを展開する。CLIが書くDOCX（ZIP64なし）だけを対象にする。
 * @param {Buffer} zip - DOCXのバイト列。
 * @returns {Map<string, Buffer>} パス名から内容への対応。
 */
export function readZip(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4B, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of central directory is missing');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(zip.readUInt32LE(offset), 0x02014B50, 'central directory signature');
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
export function decodeXml(value) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * 画像の中身を比べるための短いハッシュ。
 * @param {Buffer} data - 画像のバイト列。
 * @returns {string} SHA-256 の先頭16桁。
 */
export function imageHash(data) {
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/**
 * DOCXのパッケージを、検証に使う形へ分解する。
 * @param {Buffer} bytes - DOCXのバイト列。
 * @returns {{parts: Map<string, Buffer>, document: string, paragraphs: {text: string, bookmarks: string[], anchors: string[], pageBreak: boolean, style: string | undefined}[],
 *   headings: {text: string, bookmark: string | undefined}[], bookmarks: Set<string>, media: string[], footnotes: string[], body: string[], title: string}}
 *   パーツ、本文XML、段落、見出し、しおり名、画像の中身のハッシュ（本文の参照順）、脚注の文字列、目次と空の段落を除いた段落の文字列、文書のタイトル。
 */
export function readDocx(bytes) {
  const parts = readZip(bytes);
  const document = parts.get('word/document.xml').toString('utf8');
  const textOf = (xml) => decodeXml([...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join(''));
  const paragraphs = [...document.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map(([paragraph]) => ({
    text: textOf(paragraph),
    bookmarks: [...paragraph.matchAll(/<w:bookmarkStart\b[^>]*w:name="([^"]+)"/g)].map((match) => match[1]),
    anchors: [...paragraph.matchAll(/w:anchor="([^"]+)"/g)].map((match) => match[1]),
    pageBreak: paragraph.includes('<w:pageBreakBefore/>'),
    style: /<w:pStyle w:val="([^"]+)"/.exec(paragraph)?.[1]
  }));
  const headings = paragraphs.filter((paragraph) => /^Heading\d$/.test(paragraph.style ?? ''))
    .map((paragraph) => ({ text: paragraph.text, bookmark: paragraph.bookmarks.find((name) => /^_mve\d+$/.test(name)) }));
  const rels = parts.get('word/_rels/document.xml.rels').toString('utf8');
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((match) => [match[1], match[2]]));
  const media = [...document.matchAll(/r:embed="([^"]+)"/g)].map((match) => imageHash(parts.get(`word/${targets.get(match[1])}`)));
  const footnotesXml = parts.get('word/footnotes.xml')?.toString('utf8') ?? '';
  const footnotes = [...footnotesXml.matchAll(/<w:footnote\b[^>]*>([\s\S]*?)<\/w:footnote>/g)]
    .map((match) => textOf(match[1]).trim()).filter((text) => text !== '');
  const body = paragraphs.filter((paragraph) => !/^TOC/.test(paragraph.style ?? '') && paragraph.text.trim() !== '').map((paragraph) => paragraph.text);
  const title = decodeXml(/<dc:title>([^<]*)<\/dc:title>/.exec(parts.get('docProps/core.xml').toString('utf8'))?.[1] ?? '');
  return { parts, document, paragraphs, headings, media, footnotes, body, title, bookmarks: new Set(paragraphs.flatMap((paragraph) => paragraph.bookmarks)) };
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
 * PDFを、文書タイトル・しおり（見出しと飛び先のページ）・ページ数・各ページの用紙へ分解する。
 * しおりは`/Outlines`から`/First`・`/Next`をたどって文書の順に並べ、ページは Catalog の`/Pages`から入れ子をたどって番号を振る。
 * @param {Buffer} pdf - PDFのバイト列。
 * @returns {{title: string | undefined, pages: number, size: number[], sizes: number[][], outline: {title: string, page: number}[], titles: string[]}}
 *   検証に使う値。`titles`は PDF 内のすべての`/Title`。
 */
export function readPdf(pdf) {
  const source = pdf.toString('latin1');
  const objects = new Map([...source.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)].map((match) => [match[1], match[2]]));
  const titleOf = (body) => {
    const match = /\/Title\s*(?:\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f]+)>)/.exec(body);
    return match ? decodePdfString(match[1], match[2]) : undefined;
  };
  const catalog = [...objects.values()].find((body) => /\/Type\s*\/Catalog\b/.test(body)) ?? '';
  const kids = [];
  /** ページの一覧の節をたどる。ページが多いと`/Pages`の中に`/Pages`がある。 */
  const collectPages = (number) => {
    const body = objects.get(number) ?? '';
    if (!/\/Type\s*\/Pages\b/.test(body)) {
      kids.push(number);
      return;
    }
    for (const match of (/\/Kids\s*\[([^\]]*)\]/.exec(body)?.[1] ?? '').matchAll(/(\d+) 0 R/g)) collectPages(match[1]);
  };
  const rootPages = /\/Pages\s+(\d+) 0 R/.exec(catalog)?.[1];
  if (rootPages) collectPages(rootPages);
  const outline = [];
  /** しおりの項目を深さ優先でたどる。 */
  const visit = (number) => {
    for (let current = number; current;) {
      const body = objects.get(current) ?? '';
      const page = /\/Dest\s*\[\s*(\d+) 0 R/.exec(body)?.[1];
      outline.push({ title: titleOf(body), page: kids.indexOf(page) + 1 });
      const first = /\/First\s+(\d+) 0 R/.exec(body)?.[1];
      if (first) visit(first);
      current = /\/Next\s+(\d+) 0 R/.exec(body)?.[1];
    }
  };
  const outlines = [...objects.values()].find((body) => /\/Type\s*\/Outlines\b/.test(body));
  const first = outlines && /\/First\s+(\d+) 0 R/.exec(outlines)?.[1];
  if (first) visit(first);
  const info = [...objects.values()].find((body) => /\/Producer\b/.test(body));
  const sizes = kids.map((number) => {
    const box = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(objects.get(number) ?? '');
    return box ? [Number(box[3]) - Number(box[1]), Number(box[4]) - Number(box[2])] : [];
  });
  const titles = [...source.matchAll(/\/Title\s*(?:\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f]+)>)/g)].map((match) => decodePdfString(match[1], match[2]));
  return { title: info ? titleOf(info) : undefined, pages: kids.length, size: sizes[0] ?? [], sizes, outline, titles };
}

/** 用紙の幅と高さ（ポイント）が期待値と1ポイント以内で一致することを確かめる。 */
export function assertPageSize(actual, [width, height], label = '') {
  assert.ok(Math.abs(actual[0] - width) <= 1 && Math.abs(actual[1] - height) <= 1,
    `${label} expected ${width}x${height}pt, received ${actual.join('x')}pt`);
}

/**
 * PDFの圧縮ストリームをすべて展開する。文字は字形番号で出力され検索できないため、描画命令の比較に使う。
 * @param {Buffer} pdf - 生成されたPDFのバイト列。
 * @returns {string[]} 展開できたストリームの文字列（latin1）。
 */
export function inflatePdfStreams(pdf) {
  const streams = [];
  const source = pdf.toString('latin1');
  for (const match of source.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = source.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      streams.push(inflateSync(pdf.subarray(start, end)).toString('latin1'));
    } catch {
      // 圧縮されていないストリームは比較の対象外とする。
    }
  }
  return streams;
}

/**
 * 条件が満たされるまで待つ。固定の待ち時間で隠さず、満たされなければ状況を添えて失敗する。
 * @param {() => boolean} condition - 条件。
 * @param {string} label - 失敗時に表示する説明。
 * @param {() => string} [describe] - 失敗時に添える状況（子プロセスの出力など）。
 * @param {number} [timeout] - 待つ上限（ミリ秒）。
 */
export async function waitFor(condition, label, describe = () => '', timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\n${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 今日の日付（ローカル時刻、YYYY-MM-DD）。ヘッダーの`{date}`の期待値に使う。 */
export function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
