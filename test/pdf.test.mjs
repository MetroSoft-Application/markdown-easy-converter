/**
 * @fileoverview PDF 出力を検証する。文書タイトル、front matter、出力置換、ヘッダー/フッターの差し込み文字、
 * 用紙と向き（設定ファイルと front matter）、利用者の CSS、Marp（縦横比・図の失敗）、画像の警告、タイムアウト、front matter の誤りを対象にする。
 * 実行境界: Node（node:test）。CLI を子プロセスで実行し、描画にはテスト用ブラウザーを使う。
 * PDF の本文の文字は字形番号で出力され検索できないため、文書情報・用紙・描画命令（展開したストリーム）で確かめる。
 * 時間を短くするため、PDF の生成は3回の変換で計6件にまとめ、タイムアウトの2回は生成の前に止まる。
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  assertPageSize, browserPath, concurrency, inflatePdfStreams, localDate, needsBrowser, onePixelPng, readPdf, run, withDirectory, writeFiles
} from './helpers.mjs';

/** 純粋な赤の塗りつぶしの描画命令。利用者の CSS で見出しを赤にしたことを PDF から確かめるために使う。 */
const redFill = /(?:^|\s)1 0 0 rg\b/;

describe('pdf', { concurrency }, () => {
  /**
   * PDFとDOCXの正常終了時にコンテキスト終了の監視タイマーを残さない。
   * 残ったタイマーは出力後もCLIの終了を2秒遅らせるため、子プロセス終了時のタイマー状態を検証する。
   */
  test('releases context close timers after PDF and DOCX output', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      await writeFiles(directory, {
        'input.md': '# Timer cleanup\n',
        'track-timers.cjs': [
          "const fs = require('node:fs');",
          'const pending = new Set();',
          'let created = 0;',
          'let cleared = 0;',
          'let fired = 0;',
          'const originalSet = globalThis.setTimeout;',
          'const originalClear = globalThis.clearTimeout;',
          'globalThis.setTimeout = function (callback, delay, ...rest) {',
          "  const tracksCloseTimer = delay === 2000 && (new Error().stack || '').includes('closePdfContext');",
          '  if (!tracksCloseTimer) return originalSet(callback, delay, ...rest);',
          '  let handle;',
          '  const trackedCallback = (...args) => {',
          '    if (pending.delete(handle)) fired++;',
          '    return callback(...args);',
          '  };',
          '  handle = originalSet(trackedCallback, delay, ...rest);',
          '  created++;',
          '  pending.add(handle);',
          '  return handle;',
          '};',
          'globalThis.clearTimeout = function (handle) { if (pending.delete(handle)) cleared++; return originalClear(handle); };',
          "process.on('exit', () => fs.writeFileSync(process.argv[process.argv.indexOf('--format') + 1] + '-timers.json', JSON.stringify({ created, cleared, fired, pending: pending.size })));"
        ].join('\n')
      });
      for (const format of ['pdf', 'docx']) {
        const report = path.join(directory, `${format}-timers.json`);
        const result = await run(['input.md', '--format', format, '--out-dir', format, '--no-config'], {
          cwd: directory, node: ['--require', path.join(directory, 'track-timers.cjs')]
        });
        assert.equal(result.code, 0, result.stderr);
        const timers = JSON.parse(await readFile(report, 'utf8'));
        assert.ok(timers.created > 0, `${format} must create a context close timer`);
        assert.equal(timers.cleared, timers.created, `${format} must clear every context close timer`);
        assert.equal(timers.fired, 0, `${format} must not wait for the close timer to expire`);
        assert.equal(timers.pending, 0, `${format} left context close timers pending`);
      }
    });
  });

  /**
   * 3回の変換（既定の一括変換、設定と CSS を付けた一括変換、展開後と同じ文字を直接書いたヘッダーでの変換）の結果を突き合わせて確かめる。
   * 既定: タイトルは front matter（日本語）で`about:blank`にならず、作者などの front matter を文書情報に出さない。画像でないファイルは
   *   埋め込まずに警告する。Marp は 16:9 のスライド1枚が1ページになり、スライド内の図の失敗でも全スライドを出力する（通常の文書の
   *   図の失敗は HTML と同じ処理のため html.test.mjs で確かめる）。明示したタイムアウトで成功する。front matter の mve-convert の誤記（用紙・未知のキー・オブジェクトでない
   *   値）は、その文書だけを失敗にして書かず、他の文書は出力する（終了コード1）。
   * 設定: 設定ファイルの A5 と front matter の横向きを項目単位で重ね、front matter のない文書は設定ファイルのまま。出力置換はタイトル
   *   （文書情報）にも効く。ヘッダーの {title}・{file}・{date} を展開し、展開後と同じ文字を直接書いた PDF と描画命令が一致する。
   *   --css で見出しを赤にした PDF には赤の描画命令があり、既定の PDF にはない。
   */
  test('titles, headers, page settings, CSS, Marp, diagrams, and invalid settings in PDF output', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      const settings = { format: 'A5', margins: { top: 20 }, headerAlign: 'right', footerAlign: 'left', headerFooterFontSize: 9, headerFooterPadding: 5,
        textReplacements: [{ pattern: 'SecretWord', replacement: 'XXX' }] };
      await writeFiles(directory, {
        'main/title.md': '---\ntitle: 日本語タイトル\nauthor: PdfAuthorMarker\n---\n\n# 見出し\n\n![a](secret.txt)\n\n![d](real.png)\n',
        'main/input.md': '# Body\n',
        'main/secret.txt': 'TOP-SECRET-TEXT', 'main/real.png': onePixelPng,
        'main/marp.md': '---\nmarp: true\ntheme: default\n---\n\n# Valid diagram slide\n\n```mermaid\ngraph TD\n  A[Start] --> B[Finish]\n```\n\n---\n\n'
          + '# Broken diagram slide\n\n```mermaid\nflowchart THIS_IS_NOT_VALID\n  broken -->\n```\n',
        'main/bad-letter.md': '---\nmve-convert:\n  pdf:\n    format: Letter\n---\n# Bad\n',
        'main/bad-html.md': '---\nmve-convert:\n  html: {}\n---\n# Bad\n',
        'main/bad-scalar.md': '---\nmve-convert: landscape\n---\n# Bad\n',
        'header/input.md': '# Body\n',
        'header/landscape.md': '---\ntitle: Project SecretWord\nmve-convert:\n  pdf:\n    orientation: landscape\n---\n# Wide SecretWord\n',
        'literal/input.md': '# Body\n',
        'header.json': JSON.stringify({ pdf: { ...settings, header: '{title} {file} {date}' } }),
        'literal.json': JSON.stringify({ pdf: { ...settings, header: `Body input.md ${localDate()}` } }),
        'red.css': '.mve-print h1 { color: #ff0000; }',
      });
      const [main, header, literal] = await Promise.all([
        run(['main/*.md', '--format', 'pdf', '--out-dir', 'out-main', '--json', '--render-timeout', '120', '--no-config'], { cwd: directory }),
        run(['header/*.md', '--format', 'pdf', '--out-dir', 'out-header', '--config', 'header.json', '--css', 'red.css'], { cwd: directory }),
        run(['literal/input.md', '--format', 'pdf', '-o', 'out-literal/input.pdf', '--config', 'literal.json', '--css', 'red.css'], { cwd: directory }),
      ]);
      assert.equal(main.code, 1, main.stderr);
      for (const result of [header, literal]) assert.equal(result.code, 0, result.stderr);
      const pdf = async (file) => readFile(path.join(directory, file));
      const report = JSON.parse(main.stdout);
      const record = (name) => report.results.find((item) => item.input === path.join(directory, 'main', name));

      for (const [name, message] of [['bad-letter.md', /Invalid front matter mve-convert: Invalid pdf\.format\./],
        ['bad-html.md', /Invalid front matter mve-convert: Unknown mve-convert key: html/], ['bad-scalar.md', /Invalid front matter mve-convert: mve-convert must be an object\./]]) {
        assert.match(record(name).error, message, name);
        assert.deepEqual(record(name).outputs, [], name);
      }
      assert.deepEqual((await readdir(path.join(directory, 'out-main'))).sort(), ['input.pdf', 'marp.pdf', 'title.pdf']);
      for (const [file, title] of [['out-main/title.pdf', '日本語タイトル'], ['out-header/landscape.pdf', 'Project XXX']]) {
        const titles = readPdf(await pdf(file)).titles;
        assert.ok(titles.includes(title), `${file}: ${titles.join(', ')}`);
        assert.ok(!titles.includes('about:blank') && !titles.some((value) => /PdfAuthorMarker|SecretWord/.test(value)), titles.join(', '));
      }
      assert.deepEqual(record('title.md').warnings, ['Local file "secret.txt" was not embedded because it is not a supported image type.']);
      const marp = readPdf(await pdf('out-main/marp.pdf'));
      assert.equal(marp.pages, 2, 'both Marp slides must be exported, one page each');
      assert.ok(Math.abs(marp.size[0] / marp.size[1] - 16 / 9) < 0.02, `expected a 16:9 page, received ${marp.size.join('x')}`);
      assert.deepEqual(record('marp.md').warnings, ['Mermaid diagram 1 on slide 2 could not be rendered (Mermaid diagram could not be rendered.); an error message was embedded instead.']);

      const expanded = inflatePdfStreams(await pdf('out-header/input.pdf'));
      assert.deepEqual(expanded, inflatePdfStreams(await pdf('out-literal/input.pdf')), 'placeholders must expand to the title, file, and date');
      assertPageSize(readPdf(await pdf('out-header/landscape.pdf')).size, [595.92, 419.53], 'A5 landscape');
      assertPageSize(readPdf(await pdf('out-header/input.pdf')).size, [419.53, 595.92], 'A5 portrait');
      assert.ok(expanded.some((stream) => redFill.test(stream)), 'custom CSS must change the PDF');
      assert.ok(!inflatePdfStreams(await pdf('out-main/input.pdf')).some((stream) => redFill.test(stream)), 'the default heading is not red');
    });
  });

  /** 生成と起動のタイムアウトでは終了コード1で止まり、出力を書かない（どちらも PDF の生成の前に止まる）。 */
  test('timeouts write nothing', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      await writeFiles(directory, { 'input.md': '# Timeout\n' });
      const direct = (args) => run([...args, '--browser', browserPath], { cwd: directory, browser: false });
      const [render, browser] = await Promise.all([
        direct(['input.md', '--output', 'render.pdf', '--render-timeout', '0.001']),
        direct(['input.md', '--output', 'browser.pdf', '--browser-timeout', '0.001']),
      ]);
      assert.equal(render.code, 1, render.stderr);
      assert.match(render.stderr, /PDF .*timed out/);
      assert.equal(browser.code, 1, browser.stderr);
      assert.match(browser.stderr, /[Tt]imeout/);
      assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.pdf')), []);
    });
  });
});
