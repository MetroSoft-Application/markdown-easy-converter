/**
 * @fileoverview `--format docx` の出力を、生成されたDOCXパッケージ（ZIP内のWordprocessingML）から検証する。
 * 実行境界: Node（node:test）。CLIの成果物 dist/mve-convert.cjs を子プロセスで実行し、描画にはテスト用ブラウザーを使う。
 * 回帰リスク: Wordで開けない不正なXML・ZIP、見出し・リスト・表・数式・脚注・画像の欠落、
 * 出力先の上書き保護や`--html-*`との併用拒否など、HTML/PDFと共有する規則の破れ。
 * ブラウザー必須の公開ゲート（MVE_REQUIRE_BROWSER_TESTS=1）では描画テストのスキップを許さない。
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { findTestBrowser } from './browser.mjs';

/** CLI成果物はテストの配置から解決し、呼び出し側の作業ディレクトリに依存しない。 */
const cli = fileURLToPath(new URL('../dist/mve-convert.cjs', import.meta.url));
/** 子プロセスの終了コードと出力を取得するためのPromise版。 */
const execute = promisify(execFile);
/** 描画に使用するブラウザー。 */
const browserPath = findTestBrowser();
if (process.env.MVE_REQUIRE_BROWSER_TESTS === '1' && !browserPath) {
  throw new Error('Browser tests are required, but no Chromium/Edge/Chrome executable was found.');
}

/** 1x1のPNG。ローカル画像の埋め込みの検証に使う。 */
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

/**
 * 意図した入力だけを用いる一時ディレクトリを作り、テスト終了後に解放する。
 * @param {(directory: string) => Promise<void>} callback - 一時ディレクトリ内で実行する検証。
 */
async function withDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mve-docx-test-'));
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

/**
 * DOCXを変換して、パッケージの各パーツを返す。
 * @param {string} input - 入力Markdown。
 * @param {string} output - 出力DOCX。
 * @param {string[]} [extra] - 追加の引数。
 * @returns {Promise<{parts: Map<string, Buffer>, stderr: string, bytes: Buffer}>} パーツ、標準エラー、ファイルの内容。
 */
async function convertDocx(input, output, extra = []) {
  const result = await execute(process.execPath, [cli, input, '--format', 'docx', '--output', output, '--browser', browserPath, ...extra]);
  const bytes = await readFile(output);
  return { parts: readZip(bytes), stderr: result.stderr, bytes };
}

/**
 * XMLの各パーツが整形式であることを、ブラウザーのXMLパーサーで確かめる。Wordは不正なXMLを開けない。
 * @param {Map<string, Buffer>} parts - パッケージのパーツ。
 */
async function assertWellFormed(parts) {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage();
    const xmlParts = [...parts].filter(([name]) => /\.(?:xml|rels)$/.test(name)).map(([name, data]) => [name, data.toString('utf8')]);
    const errors = await page.evaluate((items) => items.flatMap(([name, xml]) => {
      const error = new DOMParser().parseFromString(xml, 'application/xml').querySelector('parsererror');
      return error ? [`${name}: ${error.textContent}`] : [];
    }), xmlParts);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

/**
 * 主要なMarkdown要素がWordの対応する構造（スタイル・番号・表・数式・脚注・画像・リンク・目次）になることを検証する。
 * 回帰リスク: 要素の欠落、XMLの整形式違反、関係（rels）と本文の参照の不一致。
 */
test('DOCX export maps Markdown structures to Word structures', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.docx');
    await writeFile(path.join(directory, 'pixel.png'), onePixelPng);
    await writeFile(input, [
      '# Title & \\<Escapes\\>', '', '[toc]', '', '## Section', '',
      'Text with **bold**, *italic*, ~~strike~~, `code`, [a link](https://example.com/?a=1&b=2), and [back](#section).',
      '', '- one', '  - nested', '- two', '', '3. three', '4. four', '', '- [x] done', '- [ ] todo', '',
      '> quoted', '', '| Left | Right |', '| :--- | ---: |', '| a | b |', '',
      '```js', 'const x = 1;\n\tindented();', '```', '',
      'Inline $x^2$ and a fraction:', '', '$$\\frac{a}{b}$$', '',
      '$$\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}$$', '',
      'Note[^1].', '', '[^1]: Footnote text.', '', '![pixel](pixel.png)', '',
      '```mermaid', 'graph TD', '  A --> B', '```', '', '---', '', 'End.', ''
    ].join('\n'));
    const { parts, stderr } = await convertDocx(input, output);
    assert.equal(stderr, '');
    await assertWellFormed(parts);
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml',
      'word/footnotes.xml', 'word/settings.xml', 'word/fontTable.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) {
      assert.ok(parts.has(name), `missing part ${name}`);
    }
    const document = parts.get('word/document.xml').toString('utf8');
    const rels = parts.get('word/_rels/document.xml.rels').toString('utf8');
    // 見出しの検査は1つの段落（<w:p>…</w:p>）の中に限る。
    assert.match(document, /<w:p><w:pPr><w:pStyle w:val="Heading1"\/>(?:(?!<\/w:p>).)*Title &amp; &lt;Escapes&gt;/);
    assert.match(document, /<w:p><w:pPr><w:pStyle w:val="Heading2"\/>(?:(?!<\/w:p>).)*Section/);
    assert.match(document, /<w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">bold/);
    assert.match(document, /<w:i\/><w:iCs\/><\/w:rPr><w:t xml:space="preserve">italic/);
    assert.match(document, /<w:strike\/>.*strike/);
    assert.match(document, /<w:rFonts w:ascii="Consolas"[^>]*\/>[^]*?<w:t xml:space="preserve">code<\/w:t>/);
    // 外部リンクは関係IDで、文書内リンクは見出しのブックマークで結ぶ。
    const linkId = /<w:hyperlink r:id="(rId\d+)"/.exec(document)?.[1];
    assert.ok(linkId, 'external hyperlink is missing');
    assert.match(rels, new RegExp(`Id="${linkId}" Type="[^"]+/hyperlink" Target="https://example.com/\\?a=1&amp;b=2" TargetMode="External"`));
    const anchor = /<w:hyperlink w:anchor="([^"]+)"[^>]*><w:r>(?:<w:rPr>.*?<\/w:rPr>)?<w:t xml:space="preserve">back/.exec(document)?.[1];
    assert.ok(anchor, 'internal hyperlink is missing');
    assert.match(document, new RegExp(`<w:bookmarkStart w:id="\\d+" w:name="${anchor}"/>.*?Section`));
    // 入れ子のリストと、開始番号付きの番号付きリスト。
    assert.match(document, /<w:numPr><w:ilvl w:val="1"\/>/);
    const numbering = parts.get('word/numbering.xml').toString('utf8');
    assert.match(numbering, /<w:startOverride w:val="3"\/>/);
    assert.match(document, /☑ <\/w:t>.*done/);
    assert.match(document, /☐ <\/w:t>.*todo/);
    // 表: 見出し行の繰り返しと右揃えの列。
    assert.match(document, /<w:tbl>.*<w:tblHeader\/>.*<\/w:tbl>/);
    // 行は途中で改ページしない（印刷CSSの tr { break-inside: avoid } と同じ）。
    assert.equal(document.match(/<w:tr>/g)?.length, document.match(/<w:trPr><w:cantSplit\/>/g)?.length);
    assert.match(document, /<w:jc w:val="right"\/><\/w:pPr><w:r>(?:<w:rPr>.*?<\/w:rPr>)?<w:t xml:space="preserve">Right/);
    // コード: 改行は段落内改行、タブはw:tabとして保持する。
    assert.match(document, /<w:pStyle w:val="Code"\/>/);
    assert.match(document, /<w:br\/>.*<w:tab\/>/);
    // 数式: 行内・独立・揃え付きの数式配列。
    assert.match(document, /<m:oMath><m:sSup>/);
    assert.match(document, /<m:oMathPara><m:oMath><m:f>/);
    assert.match(document, /<m:eqArr>.*<m:aln\/>/);
    // 脚注・画像・水平線・目次フィールド。
    assert.match(document, /<w:footnoteReference w:id="1"\/>/);
    assert.match(parts.get('word/footnotes.xml').toString('utf8'), /<w:footnote w:id="1">.*Footnote text\./);
    assert.ok([...parts.keys()].filter((name) => name.startsWith('word/media/')).length >= 2, 'local image and Mermaid image');
    assert.ok(parts.get('word/media/image1.png').equals(onePixelPng) || [...parts.values()].some((data) => data.equals(onePixelPng)),
      'a PNG image is embedded byte-for-byte');
    assert.match(document, /<w:bottom w:val="single"/);
    assert.match(document, /<w:instrText xml:space="preserve"> TOC \\o "1-6" \\h \\z \\u <\/w:instrText>/);
    assert.match(parts.get('docProps/core.xml').toString('utf8'), /<dc:title>Title &amp; &lt;Escapes&gt;<\/dc:title>/);
  });
});

/**
 * 出力形式の推定、既定の拡張子、`--html-*`との併用拒否、既存ファイルの保護、標準出力を検証する。
 * 回帰リスク: HTML/PDFと異なる規則で、既存ファイルを上書きしたり、HTML専用の指定を黙って無視したりすること。
 */
test('DOCX output paths follow the shared CLI rules', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    await writeFile(input, '# Paths\n');
    await assert.rejects(execute(process.execPath, [cli, input, '--format', 'docx', '--html-outline']),
      (error) => error.code === 2 && /HTML-only options/.test(error.stderr));
    await assert.rejects(execute(process.execPath, [cli, input, '--format', 'word']),
      (error) => error.code === 2 && /Invalid format/.test(error.stderr));
    // -o の拡張子から形式を決め、--format を省略できる。
    const inferred = path.join(directory, 'inferred.docx');
    await execute(process.execPath, [cli, input, '-o', inferred, '--browser', browserPath]);
    assert.equal((await readFile(inferred)).toString('latin1', 0, 2), 'PK');
    // 出力先を省略すると入力の隣に .docx を書く。
    await execute(process.execPath, [cli, input, '--format', 'docx', '--browser', browserPath]);
    const besideInput = path.join(directory, 'input.docx');
    const original = await readFile(besideInput);
    // 既存の出力は --force なしでは上書きしない。
    await writeFile(besideInput, 'keep');
    await assert.rejects(execute(process.execPath, [cli, input, '--format', 'docx', '--browser', browserPath]),
      (error) => error.code === 1 && /Output already exists/.test(error.stderr));
    assert.equal(await readFile(besideInput, 'utf8'), 'keep');
    await execute(process.execPath, [cli, input, '--format', 'docx', '--force', '--browser', browserPath]);
    assert.ok((await readFile(besideInput)).equals(original), 'the same input produces identical DOCX bytes');
    // 標準出力へはバイナリのまま書く。
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, input, '--format', 'docx', '-o', '-', '--browser', browserPath]);
      const chunks = [];
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`exit ${code}`)));
    });
    assert.ok(stdout.equals(original), 'standard output carries the same DOCX bytes');
  });
});

/**
 * PDFと共有する設定（用紙・向き・余白・ヘッダー/フッター・本文置換）がDOCXのページ設定と本文へ反映されることを検証する。
 * 回帰リスク: 用紙サイズの寸法違い、Letterへの暗黙の変更、ページ番号のプレースホルダーが文字のまま残ること。
 */
test('DOCX export applies the shared page settings and replacements', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.docx');
    const config = path.join(directory, 'export.json');
    await writeFile(input, '# Report SecretWord\n\nBody SecretWord.\n');
    await writeFile(config, JSON.stringify({
      pdf: {
        format: 'A5', orientation: 'landscape', margins: { top: 20, right: 10, bottom: 20, left: 10 },
        header: '{title}', footer: 'Page {page} of {pages}', headerAlign: 'right',
        textReplacements: [{ pattern: 'SecretWord', replacement: 'XXX' }]
      }
    }));
    const { parts } = await convertDocx(input, output, ['--config', config]);
    await assertWellFormed(parts);
    const document = parts.get('word/document.xml').toString('utf8');
    // A5横: 210mm × 148mm = 11906 × 8391 twip。
    assert.match(document, /<w:pgSz w:w="11906" w:h="8391" w:orient="landscape"\/>/);
    assert.match(document, /<w:pgMar w:top="1134" w:right="567" w:bottom="1134" w:left="567"/);
    assert.doesNotMatch(document, /SecretWord/);
    assert.match(document, /Body XXX\./);
    const header = parts.get('word/header1.xml').toString('utf8');
    assert.match(header, /<w:jc w:val="right"\/>.*Report XXX/);
    const footer = parts.get('word/footer1.xml').toString('utf8');
    assert.match(footer, /Page <\/w:t>.*<w:fldSimple w:instr=" PAGE ">.*<w:fldSimple w:instr=" NUMPAGES ">/);
    assert.doesNotMatch(footer, /\{page\}/);
    assert.match(parts.get('docProps/core.xml').toString('utf8'), /<dc:title>Report XXX<\/dc:title>/);
  });
});

/**
 * OMMLへ変換できない数式は、その式だけ画像にして警告し、文書全体の出力は続けることを検証する。
 * 回帰リスク: 未対応の式で変換全体が失敗すること、または式が黙って消えること。
 */
test('an unsupported equation is embedded as an image with a warning', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.docx');
    await writeFile(input, 'Angle $\\phase{-78^\\circ}$ and $y=1$.\n');
    const { parts, stderr } = await convertDocx(input, output);
    assert.match(stderr, /could not be converted to a Word equation .*phase/);
    const document = parts.get('word/document.xml').toString('utf8');
    assert.match(document, /<w:drawing>/);
    assert.match(document, /<m:oMath>.*y.*<\/m:oMath>/);
    assert.ok(parts.has('word/media/image1.png'));
  });
});

/**
 * 生HTMLを含む境界条件でも、変換全体を失敗させず、Wordが修復しない構造を出すことを検証する。
 * 回帰リスク（第三者レビューの指摘）: 脚注の自己参照による無限再帰、不正なパーセントエンコードの脚注hrefでの例外、
 * 寸法0の要素や2回参照された脚注内の図による1件5秒の待機、空の表からの不正なw:tbl、
 * 閉じたdetailsの中の文字列の出力、空白を含むURLの未正規化、結合セルの欠落、リスト項目の記号の欠落。
 */
test('edge cases in raw HTML produce a valid DOCX without failing', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.docx');
    await writeFile(input, [
      'Self<sup class="footnote-ref"><a href="#fy">1</a></sup> twice<sup class="footnote-ref"><a href="#fx">2</a></sup>'
        + ' again<sup class="footnote-ref"><a href="#fx">3</a></sup> bad<sup class="footnote-ref"><a href="#%E0%A4%A">4</a></sup>',
      '',
      '<ol><li id="fy">loop <sup class="footnote-ref"><a href="#fy">1</a></sup></li>'
        + '<li id="fx">note <svg width="20" height="20"><rect width="20" height="20" fill="red"/></svg></li></ol>',
      '', '<table></table>', '', '<svg width="0" height="0"></svg>', '',
      '[spaced](<http://a b>)', '',
      '<table><tr><td rowspan="2">A</td><td colspan="2">B</td></tr><tr><td>C</td><td>D</td></tr></table>', '',
      '<details><summary>Summary</summary>Hidden body</details>', '',
      '- $$x=1$$', '- - nested first', ''
    ].join('\n'));
    const started = Date.now();
    const { parts } = await convertDocx(input, output);
    // 寸法0の要素や重複登録で1件ごとに5秒待つと、ここで10秒以上かかる。
    assert.ok(Date.now() - started < 30_000, `conversion took ${Date.now() - started}ms`);
    await assertWellFormed(parts);
    const document = parts.get('word/document.xml').toString('utf8');
    const rels = parts.get('word/_rels/document.xml.rels').toString('utf8');
    // 脚注は2つ（#fy と #fx）。同じ脚注への2回目以降の参照（again と、本文にも表示される生HTMLのリスト内の参照）は
    // 脚注を増やさず、最初の参照のブックマークをNOTEREFで参照して同じ番号を表示する。
    // 不正なhrefの参照は脚注にせず、脚注本文の中の参照（自己参照）も脚注にしない。
    assert.equal(document.match(/<w:footnoteReference /g)?.length, 2);
    assert.equal(document.match(/w:instr=" NOTEREF _mveFn\d+ \\f \\h "/g)?.length, 2);
    for (const name of document.match(/NOTEREF (_mveFn\d+)/g)?.map((text) => text.slice(8)) ?? []) {
      assert.match(document, new RegExp(`<w:bookmarkStart w:id="\\d+" w:name="${name}"/>`));
    }
    const footnotes = parts.get('word/footnotes.xml').toString('utf8');
    assert.doesNotMatch(footnotes, /<w:footnoteReference /);
    // 2回参照された脚注の中の図は、同じ画像を再利用して埋め込む。
    assert.equal([...parts.keys()].filter((name) => name.startsWith('word/media/')).length, 1);
    // 空の表は出さず、すべての表が行と列を持つ。
    for (const table of document.match(/<w:tbl>.*?<\/w:tbl>/g) ?? []) {
      assert.match(table, /<w:gridCol /);
      assert.match(table, /<w:tr>/);
    }
    // 結合セル: 横結合（gridSpan）と縦結合（vMerge）。
    assert.match(document, /<w:gridSpan w:val="2"\/>/);
    assert.match(document, /<w:vMerge w:val="restart"\/>.*<w:vMerge\/>/);
    assert.match(rels, /Target="http:\/\/a%20b\/" TargetMode="External"/);
    assert.match(document, /▶ <\/w:t>.*Summary/);
    assert.doesNotMatch(document, /Hidden body/);
    // 数式や入れ子のリストで始まる項目にも、番号・記号だけの段落を置く。
    assert.ok((document.match(/<w:numPr><w:ilvl w:val="0"\/>/g)?.length ?? 0) >= 2, 'outer list items keep their bullets');
  });
});

/**
 * 印刷（PDF）と見た目を揃えるための細部を検証する。第三者の目視比較で見つかった差の回帰テスト。
 * 回帰リスク: <br>の直後の行頭に空白が入る、連続する引用（GitHub Alerts）が1つの枠にまとまる、
 * インラインコードが本文と同じ文字サイズになる、表のセルとコードの行間が本文より詰まる。
 */
test('DOCX keeps print-like spacing, separate quotes and inline code size', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.docx');
    await writeFile(input, [
      'First line<br>', 'second line after a break.', '',
      '> [!NOTE]', '> Note body.', '', '> [!TIP]', '> Tip body.', '',
      'Inline `code` here.', '', '| A |', '| - |', '| cell |', '',
      // 言語ラベルのないコードブロック（Textileのbc.や生HTMLのpre）が続く場合。Markdownのコードは間にラベルの段落が入る。
      '<pre>first_block</pre>', '', '<pre>second_block</pre>', '',
      'Broken ![](missing.png) image.', '',
      'Keep <span style="white-space:pre">  two spaces</span> here.', '',
      // 本文の高さ（A4・余白15mmで267mm）を大きく超える縦長の図。
      '<svg width="200" height="3000"><rect width="200" height="3000" fill="#9ab"/></svg>', ''
    ].join('\n'));
    const { parts } = await convertDocx(input, output);
    const document = parts.get('word/document.xml').toString('utf8');
    const styles = parts.get('word/styles.xml').toString('utf8');
    assert.match(document, /<w:br\/><\/w:r><w:r><w:t xml:space="preserve">second line/);
    // 2つのAlertの間に枠を分ける区切りの段落がある。
    assert.match(document, /Note body\.(?:(?!Tip body).)*<w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="exact"\/>(?:(?!Note body).)*Tip body/);
    // 既定の本文11pt・コード9pt: インラインコードには18（半ポイント）の文字サイズが付く。
    assert.match(document, /<w:sz w:val="18"\/><w:szCs w:val="18"\/><\/w:rPr><w:t xml:space="preserve">code<\/w:t>/);
    // 既定の行の高さ1.6: 本文11pt×1.6=17.6pt（352twip）、コード9pt×1.6=14.4pt（288twip）を最小値で指定する。
    // Wordの倍数指定はフォント固有の行の高さに掛けるため、CSSより行間が広がる（回帰防止）。表のスタイルは行の高さを固定しない。
    assert.match(styles, /<w:pPrDefault><w:pPr><w:spacing w:after="\d+" w:line="352" w:lineRule="atLeast"\/>/);
    assert.match(styles, /w:styleId="Code">(?:(?!<\/w:style>).)*w:line="288" w:lineRule="atLeast"/);
    assert.match(styles, /w:styleId="MveTable">(?:(?!<\/w:style>).)*<w:pPr><w:spacing w:after="0"\/><\/w:pPr>/);
    // 連続するコードブロックも別々の枠にする。
    assert.match(document, /first_block(?:(?!second_block).)*w:line="120" w:lineRule="exact"(?:(?!first_block).)*second_block/);
    // 代替テキストのない壊れた画像は、印刷と同じく何も表示しない。
    assert.doesNotMatch(document, /\[image\]/);
    assert.match(document, /Broken <\/w:t><\/w:r><w:r><w:t xml:space="preserve">image\./);
    // white-space: pre の文字列は、前の空白に続いても先頭の空白を保つ。
    assert.match(document, /<w:t xml:space="preserve">  two spaces<\/w:t>/);
    // Wordは画像をページで分割できないため、本文の高さを超える画像は1ページに収まるよう縮める（縦横比は保つ）。
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(document);
    assert.ok(extent, 'tall image is embedded');
    const [width, height] = [Number(extent[1]), Number(extent[2])];
    assert.ok(height <= (297 - 30) * 36000, `image height ${height} EMU exceeds the page body`);
    assert.ok(Math.abs(width / height - 200 / 3000) < 0.01, 'aspect ratio is kept');
    // 画像を含む段落は孤立行の制御を外す（連続した画像が1ページに1枚ずつ送られるのを防ぐ）。
    assert.match(document, /<w:widowControl w:val="0"\/>(?:(?!<\/w:p>).)*<w:drawing>/);
  });
});

/**
 * `--css`で変えた見出しの色が、Wordの見出しスタイルの色になることを検証する。
 * 回帰リスク: 見出しスタイルの色が固定のテーマ色のままで、`--css`がDOCXに反映されないこと。
 */
test('custom CSS heading colors become the Word heading style color', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.docx');
    const css = path.join(directory, 'custom.css');
    await writeFile(input, '## Red heading\n\nBody.\n');
    await writeFile(css, '.mve-print h2 { color: #ff0000 !important; font-size: 30pt !important; }\n');
    const { parts } = await convertDocx(input, output, ['--css', css]);
    const styles = parts.get('word/styles.xml').toString('utf8');
    assert.match(styles, /w:styleId="Heading2">(?:(?!<\/w:style>).)*<w:color w:val="FF0000"\/>/);
    // 文字サイズも--cssの値（30pt = 60半ポイント）が見出しスタイルになる。
    assert.match(styles, /w:styleId="Heading2">(?:(?!<\/w:style>).)*<w:sz w:val="60"\/>/);
  });
});

/**
 * `--restrict-local-files`はDOCXでもワークスペース外の画像を読まず、代替テキストに置き換えることを検証する。
 * 回帰リスク: PDFと同じ制限がDOCXで効かず、ワークスペース外のファイルが配布物へ埋め込まれること。
 */
test('--restrict-local-files keeps outside images out of DOCX output', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    const input = path.join(workspace, 'input.md');
    const output = path.join(workspace, 'output.docx');
    await writeFile(path.join(directory, 'outside.png'), onePixelPng);
    await writeFile(input, '![outside](../outside.png)\n');
    const { parts, stderr } = await convertDocx(input, output, ['--restrict-local-files']);
    assert.match(stderr, /outside/);
    assert.ok(![...parts.keys()].some((name) => name.startsWith('word/media/')), 'no image may be embedded');
    assert.match(parts.get('word/document.xml').toString('utf8'), /\[outside\]/);
  });
});
