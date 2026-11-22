/**
 * @fileoverview `--format docx` の出力を、生成されたDOCXパッケージ（ZIP内のWordprocessingML）から検証する。
 * 実行境界: Node（node:test）。CLI を子プロセスで実行し、描画にはテスト用ブラウザーを使う。
 * 回帰リスク: Wordで開けない不正なXML・ZIP、見出し・リスト・表・数式・脚注・画像の欠落、
 * 出力先の上書き保護や`--html-*`との併用拒否など、HTML/PDFと共有する規則の破れ。
 * 時間を短くするため、同じ設定で済む確認は複数の文書の一括変換（--out-dir）1回にまとめる。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { chromium } from 'playwright-core';
import { browserPath, concurrency, needsBrowser, onePixelPng, readZip, run, withDirectory, writeFiles } from './helpers.mjs';

/**
 * XMLの各パーツが整形式であることを、ブラウザーのXMLパーサーで確かめる。Wordは不正なXMLを開けない。
 * @param {Map<string, Buffer>[]} packages - 検査する DOCX のパーツ（複数の DOCX をまとめて1回のブラウザー起動で調べる）。
 */
async function assertWellFormed(packages) {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage();
    const xmlParts = packages.flatMap((parts) => [...parts].filter(([name]) => /\.(?:xml|rels)$/.test(name)).map(([name, data]) => [name, data.toString('utf8')]));
    const errors = await page.evaluate((items) => items.flatMap(([name, xml]) => {
      const error = new DOMParser().parseFromString(xml, 'application/xml').querySelector('parsererror');
      return error ? [`${name}: ${error.textContent}`] : [];
    }), xmlParts);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

describe('docx', { concurrency }, () => {
  /**
   * 5つの文書を1回の一括変換で DOCX にし、それぞれの構造を確かめる。全文書に、PDF と共有する設定（A5横・余白・ヘッダー/フッター・出力置換）、
   * 利用者の CSS（h2 の色と文字サイズ）、--restrict-local-files を付ける（各確認と干渉しない）。同じ設定で settings を標準出力へ書く
   * 変換を並行して行い、ファイルへの出力とバイト列が一致することも確かめる。
   * structures: 見出し・強調・コード・外部リンク（関係ID）・文書内リンク（しおり）・入れ子のリスト・開始番号・タスクリスト・
   *   表（見出し行の繰り返し・行の分割禁止・右揃え）・コード（改行・タブ）・数式（行内・独立・揃え）・脚注・画像（PNGはそのまま）・
   *   水平線・目次フィールド・文書のタイトル。警告なし。
   * edge: 脚注の自己参照・同じ脚注への複数の参照・不正なhref、空の表、寸法0の要素、空白を含むURL、結合セル、閉じたdetails、
   *   数式や入れ子のリストで始まるリスト項目（Wordが修復しない構造で、時間がかからないこと）。
   * spacing: <br>の直後の空白、連続する引用・コードの枠、インラインコードの文字サイズ、行の高さ、壊れた画像、white-space: pre、
   *   本文より高い画像の縮小、画像を含む段落の孤立行制御。
   * equation: OMMLへ変換できない数式は、その式だけ画像にして警告し、他の式は数式のまま。
   * settings: 用紙（A5横）・余白・ヘッダー（右揃え、タイトルの差し込み）・フッター（ページ番号のフィールド）・本文とタイトルの出力置換、
   *   --css の見出しの色と文字サイズが Word の見出しスタイルになること、ワークスペース外の画像を埋め込まず代替テキストにすること。
   */
  test('Markdown structures, edge cases, spacing, equations, and shared settings map to Word', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      await writeFiles(directory, {
        'docs/pixel.png': onePixelPng,
        'docs/structures.md': [
          '# Title & \\<Escapes\\>', '', '[toc]', '', '## Section', '',
          'Text with **bold**, *italic*, ~~strike~~, `code`, [a link](https://example.com/?a=1&b=2), and [back](#section).',
          '', '- one', '  - nested', '- two', '', '3. three', '4. four', '', '- [x] done', '- [ ] todo', '',
          '> quoted', '', '| Left | Right |', '| :--- | ---: |', '| a | b |', '',
          '```js', 'const x = 1;\n\tindented();', '```', '',
          'Inline $x^2$ and a fraction:', '', '$$\\frac{a}{b}$$', '',
          '$$\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}$$', '',
          'Note[^1].', '', '[^1]: Footnote text.', '', '![pixel](pixel.png)', '',
          '```mermaid', 'graph TD', '  A --> B', '```', '', '---', '', 'End.', ''
        ].join('\n'),
        'docs/edge.md': [
          'Self<sup class="footnote-ref"><a href="#fy">1</a></sup> twice<sup class="footnote-ref"><a href="#fx">2</a></sup>'
            + ' again<sup class="footnote-ref"><a href="#fx">3</a></sup> bad<sup class="footnote-ref"><a href="#%E0%A4%A">4</a></sup>', '',
          '<ol><li id="fy">loop <sup class="footnote-ref"><a href="#fy">1</a></sup></li>'
            + '<li id="fx">note <svg width="20" height="20"><rect width="20" height="20" fill="red"/></svg></li></ol>',
          '', '<table></table>', '', '<svg width="0" height="0"></svg>', '', '[spaced](<http://a b>)', '',
          '<table><tr><td rowspan="2">A</td><td colspan="2">B</td></tr><tr><td>C</td><td>D</td></tr></table>', '',
          '<details><summary>Summary</summary>Hidden body</details>', '', '- $$x=1$$', '- - nested first', ''
        ].join('\n'),
        'docs/spacing.md': [
          'First line<br>', 'second line after a break.', '', '> [!NOTE]', '> Note body.', '', '> [!TIP]', '> Tip body.', '',
          'Inline `code` here.', '', '| A |', '| - |', '| cell |', '', '<pre>first_block</pre>', '', '<pre>second_block</pre>', '',
          'Broken ![](missing.png) image.', '', 'Keep <span style="white-space:pre">  two spaces</span> here.', '',
          '<svg width="200" height="3000"><rect width="200" height="3000" fill="#9ab"/></svg>', ''
        ].join('\n'),
        'docs/equation.md': 'Angle $\\phase{-78^\\circ}$ and $y=1$.\n',
        'docs/settings.md': '# Report SecretWord\n\nBody SecretWord.\n\n## Red heading\n\n![outside](../outside.png)\n',
        'outside.png': onePixelPng,
        'export.json': JSON.stringify({ pdf: {
          format: 'A5', orientation: 'landscape', margins: { top: 20, right: 10, bottom: 20, left: 10 },
          header: '{title}', footer: 'Page {page} of {pages}', headerAlign: 'right', textReplacements: [{ pattern: 'SecretWord', replacement: 'XXX' }]
        } }),
        'custom.css': '.mve-print h2 { color: #ff0000 !important; font-size: 30pt !important; }\n',
      });
      const options = ['--config', 'export.json', '--css', 'custom.css', '--restrict-local-files'];
      const started = Date.now();
      // 標準出力への変換（同じ設定・同じ文書）を並行して行い、ファイルへの出力とバイト列が一致することを後で確かめる。
      const [result, stdout] = await Promise.all([
        run(['docs/*.md', '--format', 'docx', '--out-dir', 'out', '--json', ...options], { cwd: directory }),
        run(['docs/settings.md', '--format', 'docx', '-o', '-', ...options], { cwd: directory }),
      ]);
      // 寸法0の要素や重複登録で1件ごとに5秒待つ実装では、ここで大きく遅れる。
      assert.ok(Date.now() - started < 90_000, `conversion took ${Date.now() - started}ms`);
      assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      const warnings = (name) => report.results.find((record) => record.input === path.join(directory, 'docs', name)).warnings;
      const read = async (name) => readZip(await readFile(path.join(directory, 'out', name)));
      const [structures, edge, spacing, equation] = await Promise.all(['structures.docx', 'edge.docx', 'spacing.docx', 'equation.docx'].map(read));
      const settings = await read('settings.docx');
      await assertWellFormed([structures, edge, spacing, equation, settings]);

      assert.deepEqual(warnings('structures.md'), []);
      for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml',
        'word/footnotes.xml', 'word/settings.xml', 'word/fontTable.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) {
        assert.ok(structures.has(name), `missing part ${name}`);
      }
      let document = structures.get('word/document.xml').toString('utf8');
      const rels = structures.get('word/_rels/document.xml.rels').toString('utf8');
      assert.match(document, /<w:p><w:pPr><w:pStyle w:val="Heading1"\/>(?:(?!<\/w:p>).)*Title &amp; &lt;Escapes&gt;/);
      assert.match(document, /<w:p><w:pPr><w:pStyle w:val="Heading2"\/>(?:(?!<\/w:p>).)*Section/);
      assert.match(document, /<w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">bold/);
      assert.match(document, /<w:i\/><w:iCs\/><\/w:rPr><w:t xml:space="preserve">italic/);
      assert.match(document, /<w:strike\/>.*strike/);
      assert.match(document, /<w:rFonts w:ascii="Consolas"[^>]*\/>[^]*?<w:t xml:space="preserve">code<\/w:t>/);
      const linkId = /<w:hyperlink r:id="(rId\d+)"/.exec(document)?.[1];
      assert.ok(linkId, 'external hyperlink is missing');
      assert.match(rels, new RegExp(`Id="${linkId}" Type="[^"]+/hyperlink" Target="https://example.com/\\?a=1&amp;b=2" TargetMode="External"`));
      const anchor = /<w:hyperlink w:anchor="([^"]+)"[^>]*><w:r>(?:<w:rPr>.*?<\/w:rPr>)?<w:t xml:space="preserve">back/.exec(document)?.[1];
      assert.ok(anchor, 'internal hyperlink is missing');
      assert.match(document, new RegExp(`<w:bookmarkStart w:id="\\d+" w:name="${anchor}"/>.*?Section`));
      assert.match(document, /<w:numPr><w:ilvl w:val="1"\/>/);
      assert.match(structures.get('word/numbering.xml').toString('utf8'), /<w:startOverride w:val="3"\/>/);
      assert.match(document, /☑ <\/w:t>.*done/);
      assert.match(document, /☐ <\/w:t>.*todo/);
      assert.match(document, /<w:tbl>.*<w:tblHeader\/>.*<\/w:tbl>/);
      assert.equal(document.match(/<w:tr>/g)?.length, document.match(/<w:trPr><w:cantSplit\/>/g)?.length);
      assert.match(document, /<w:jc w:val="right"\/><\/w:pPr><w:r>(?:<w:rPr>.*?<\/w:rPr>)?<w:t xml:space="preserve">Right/);
      assert.match(document, /<w:pStyle w:val="Code"\/>/);
      assert.match(document, /<w:br\/>.*<w:tab\/>/);
      assert.match(document, /<m:oMath><m:sSup>/);
      assert.match(document, /<m:oMathPara><m:oMath><m:f>/);
      assert.match(document, /<m:eqArr>.*<m:aln\/>/);
      assert.match(document, /<w:footnoteReference w:id="1"\/>/);
      assert.match(structures.get('word/footnotes.xml').toString('utf8'), /<w:footnote w:id="1">.*Footnote text\./);
      assert.ok([...structures.keys()].filter((name) => name.startsWith('word/media/')).length >= 2, 'local image and Mermaid image');
      assert.ok([...structures.values()].some((data) => data.equals(onePixelPng)), 'a PNG image is embedded byte-for-byte');
      assert.match(document, /<w:bottom w:val="single"/);
      assert.match(document, /<w:instrText xml:space="preserve"> TOC \\o "1-6" \\h \\z \\u <\/w:instrText>/);
      assert.match(structures.get('docProps/core.xml').toString('utf8'), /<dc:title>Title &amp; &lt;Escapes&gt;<\/dc:title>/);

      document = edge.get('word/document.xml').toString('utf8');
      assert.equal(document.match(/<w:footnoteReference /g)?.length, 2);
      assert.equal(document.match(/w:instr=" NOTEREF _mveFn\d+ \\f \\h "/g)?.length, 2);
      for (const name of document.match(/NOTEREF (_mveFn\d+)/g)?.map((text) => text.slice(8)) ?? []) {
        assert.match(document, new RegExp(`<w:bookmarkStart w:id="\\d+" w:name="${name}"/>`));
      }
      assert.doesNotMatch(edge.get('word/footnotes.xml').toString('utf8'), /<w:footnoteReference /);
      assert.equal([...edge.keys()].filter((name) => name.startsWith('word/media/')).length, 1);
      for (const table of document.match(/<w:tbl>.*?<\/w:tbl>/g) ?? []) {
        assert.match(table, /<w:gridCol /);
        assert.match(table, /<w:tr>/);
      }
      assert.match(document, /<w:gridSpan w:val="2"\/>/);
      assert.match(document, /<w:vMerge w:val="restart"\/>.*<w:vMerge\/>/);
      assert.match(edge.get('word/_rels/document.xml.rels').toString('utf8'), /Target="http:\/\/a%20b\/" TargetMode="External"/);
      assert.match(document, /▶ <\/w:t>.*Summary/);
      assert.doesNotMatch(document, /Hidden body/);
      assert.ok((document.match(/<w:numPr><w:ilvl w:val="0"\/>/g)?.length ?? 0) >= 2, 'outer list items keep their bullets');

      document = spacing.get('word/document.xml').toString('utf8');
      const styles = spacing.get('word/styles.xml').toString('utf8');
      assert.match(document, /<w:br\/><\/w:r><w:r><w:t xml:space="preserve">second line/);
      assert.match(document, /Note body\.(?:(?!Tip body).)*<w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="exact"\/>(?:(?!Note body).)*Tip body/);
      assert.match(document, /<w:sz w:val="18"\/><w:szCs w:val="18"\/><\/w:rPr><w:t xml:space="preserve">code<\/w:t>/);
      assert.match(styles, /<w:pPrDefault><w:pPr><w:spacing w:after="\d+" w:line="352" w:lineRule="atLeast"\/>/);
      assert.match(styles, /w:styleId="Code">(?:(?!<\/w:style>).)*w:line="288" w:lineRule="atLeast"/);
      assert.match(styles, /w:styleId="MveTable">(?:(?!<\/w:style>).)*<w:pPr><w:spacing w:after="0"\/><\/w:pPr>/);
      assert.match(document, /first_block(?:(?!second_block).)*w:line="120" w:lineRule="exact"(?:(?!first_block).)*second_block/);
      assert.doesNotMatch(document, /\[image\]/);
      assert.match(document, /Broken <\/w:t><\/w:r><w:r><w:t xml:space="preserve">image\./);
      assert.match(document, /<w:t xml:space="preserve">  two spaces<\/w:t>/);
      const extent = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(document);
      assert.ok(extent, 'tall image is embedded');
      assert.ok(Number(extent[2]) <= (297 - 30) * 36000, `image height ${extent[2]} EMU exceeds the page body`);
      assert.ok(Math.abs(Number(extent[1]) / Number(extent[2]) - 200 / 3000) < 0.01, 'aspect ratio is kept');
      assert.match(document, /<w:widowControl w:val="0"\/>(?:(?!<\/w:p>).)*<w:drawing>/);

      assert.ok(warnings('equation.md').some((warning) => /could not be converted to a Word equation .*phase/.test(warning)));
      document = equation.get('word/document.xml').toString('utf8');
      assert.match(document, /<w:drawing>/);
      assert.match(document, /<m:oMath>.*y.*<\/m:oMath>/);
      assert.ok(equation.has('word/media/image1.png'));
      assert.ok(warnings('settings.md').some((warning) => /outside/.test(warning)));
      document = settings.get('word/document.xml').toString('utf8');
      assert.match(document, /<w:pgSz w:w="11906" w:h="8391" w:orient="landscape"\/>/);
      assert.match(document, /<w:pgMar w:top="1134" w:right="567" w:bottom="1134" w:left="567"/);
      assert.doesNotMatch(document, /SecretWord/);
      assert.match(document, /Body XXX\./);
      assert.match(settings.get('word/header1.xml').toString('utf8'), /<w:jc w:val="right"\/>.*Report XXX/);
      const footer = settings.get('word/footer1.xml').toString('utf8');
      assert.match(footer, /Page <\/w:t>.*<w:fldSimple w:instr=" PAGE ">.*<w:fldSimple w:instr=" NUMPAGES ">/);
      assert.doesNotMatch(footer, /\{page\}/);
      assert.match(settings.get('docProps/core.xml').toString('utf8'), /<dc:title>Report XXX<\/dc:title>/);
      const settingsStyles = settings.get('word/styles.xml').toString('utf8');
      assert.match(settingsStyles, /w:styleId="Heading2">(?:(?!<\/w:style>).)*<w:color w:val="FF0000"\/>/);
      assert.match(settingsStyles, /w:styleId="Heading2">(?:(?!<\/w:style>).)*<w:sz w:val="60"\/>/);
      assert.ok(![...settings.keys()].some((name) => name.startsWith('word/media/')), 'no image may be embedded');
      assert.match(document, /\[outside\]/);

      // 標準出力へはバイナリのまま書き、同じ入力と設定からはファイルへの出力と同じバイト列になる。
      assert.equal(stdout.code, 0, stdout.stderr);
      const file = await readFile(path.join(directory, 'out', 'settings.docx'));
      assert.equal(file.toString('latin1', 0, 2), 'PK');
      assert.ok(stdout.bytes.equals(file), 'standard output carries the same DOCX bytes');
    });
  });
});
