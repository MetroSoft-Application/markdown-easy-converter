/**
 * @fileoverview CLI の引数・設定の検証、終了コード、記法の書き換え、設定ファイルの自動検出と、
 * 標準入出力・一括変換・同時実行・監視・中断といったプロセスとしての振る舞いを検証する。
 * 実行境界: Node（node:test）。引数の解析とエラー文の整形は成果物の関数を直接呼び、プロセスの振る舞いは CLI を子プロセスで実行する。
 * 時間を短くするため、1つのテストで同じ実行結果に対して複数の項目を確かめ、互いに独立したテストは並列に実行する。
 * ブラウザー必須の公開ゲート（MVE_REQUIRE_BROWSER_TESTS=1）では描画テストのスキップを許さない。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { link, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  browserPath, cli, concurrency, needsBrowser, onePixelPng, requireCli, run, runWithoutBrowser, waitFor, withDirectory, writeFiles
} from './helpers.mjs';

describe('cli', { concurrency }, () => {
  /**
   * 引数の解析を、成果物の parseArguments を直接呼んで網羅的に検証する（CLI を起動しない）。
   * 対象: 出力の拡張子からの形式の推定、無効な形式、HTML 専用の指定、タイムアウトの値、標準入出力と他の指定の組み合わせ、
   * --watch・--merge・--config/--no-config・--title の検証。
   * 回帰リスク: 誤った形式で黙って処理する、無効な値を0やタイムアウトなしへ丸める、組み合わせられない指定を受け付ける。
   */
  test('arguments are parsed and rejected without starting a conversion', () => {
    const { parseArguments } = requireCli(cli);
    for (const [argv, format] of [
      [['a.md', '-o', 'a.PDF'], 'pdf'], [['a.md', '-o', 'a.htm'], 'html'], [['a.md', '-o', 'a.pdf', '--format', 'html'], 'html'],
      [['a.md', '-o', 'a.DOCX'], 'docx'], [['a.md', '-o', 'a.docx', '--format', 'pdf'], 'pdf'], [['a.textile', '-o', 'a.MD'], 'md'],
      [['a.textile', '-o', 'a.markdown'], 'md'], [['a.md', '-o', 'a.textile'], 'textile'],
    ]) {
      assert.equal(parseArguments(argv).format, format, argv.join(' '));
    }
    assert.equal(parseArguments(['a.md', '--format', 'html', '--watch']).watch, true);
    assert.equal(parseArguments(['a.md', 'b.md', '--merge', '-o', 'b.docx', '--title', 'T']).merge, true);
    assert.equal(parseArguments(['-h']), undefined);
    const required = /--format html\|pdf\|docx\|md\|textile is required/;
    for (const [argv, message] of [
      [['a.md'], required], [['a.md', '-o', 'a.txt'], required], [['a.md', '-o', 'a.doc'], required],
      [['a.md', '--format', 'unknown'], /Invalid format/], [['a.md', '--format', 'word'], /Invalid format/],
      [['a.md', '--format'], /Missing value for --format/], [['a.md', '--nope', 'x'], /Unknown argument: --nope/],
      ...['--html-embed-images', '--html-no-embed-images', '--html-linked', '--html-outline'].flatMap((option) => [
        [['a.md', '--format', 'pdf', option], /HTML-only options/], [['a.md', '--format', 'docx', option], /HTML-only options/]]),
      ...['--browser-timeout', '--render-timeout'].flatMap((option) => ['0', '0.0001', 'abc', '3601'].map((value) =>
        [['a.md', '--format', 'pdf', option, value], /Invalid .* timeout/])),
      [['-', 'b.md', '--format', 'html'], /Only one input is supported when reading standard input/],
      [['a.md', '--format', 'html', '--base-dir', '.'], /Invalid --base-dir/],
      [['-', '--format', 'html', '--json'], /--json cannot be combined with standard output/],
      [['-', '--format', 'html', '--out-dir', 'x'], /--out-dir cannot be combined with standard input/],
      [['a.md', '--format', 'html', '-o', 'x.html', '--out-dir', 'x'], /--output and --out-dir cannot be combined/],
      [['-', '--format', 'html', '--watch'], /Invalid --watch/], [['a.md', '-o', '-', '--format', 'html', '--watch'], /Invalid --watch/],
      [['a.md', '--format', 'html', '--watch', '--json'], /Invalid --watch/],
      [['a.md', '--format', 'html', '--config', 'c.json', '--no-config'], /--config and --no-config cannot be combined/],
      [['a.md', '--format', 'html', '--title', '  '], /Invalid title/],
      [['a.md', '--format', 'html', '--front-matter', 'unknown'], /Invalid front matter mode/],
      [['a.md', '--format', 'html', '--language', 'xx'], /Invalid language/],
      [['a.md', '--format', 'html', '--theme', 'blue'], /Invalid theme/],
      [['a.md', '--format', 'html', '--mermaid-theme', 'forest'], /Invalid Mermaid theme/],
      [['a.md', '--merge', '-o', 'x.html'], /Invalid --merge: it supports --format pdf and docx only/],
      [['a.md', '--merge', '--format', 'pdf'], /Invalid --merge: name the merged file with -o/],
      [['-', '--merge', '--format', 'pdf', '-o', 'x.pdf'], /Invalid --merge: it cannot be combined with standard input/],
    ]) {
      assert.throws(() => parseArguments(argv), message, argv.join(' '));
    }
  });

  /**
   * CLI 向けのエラー文と、PDF のヘッダー/フッターのテンプレートを、成果物の関数を直接呼んで検証する。
   * 回帰リスク: ブラウザーの自動検出の失敗で VS Code の設定画面を案内する、起動ログ全体を表示する、
   * 依存ライブラリ不足の原因行を落とす、ヘッダーの既定の見た目が変わる、展開した値の`{page}`をページ番号にする。
   */
  test('error messages and header templates', () => {
    const { PdfBrowserUnavailableError, formatCliError, headerFooterTemplate } = requireCli(cli);
    const edgeError = new Error('edge missing');
    const chromeError = new Error('chrome missing');
    const error = new PdfBrowserUnavailableError('Could not start a PDF browser. Specify Edge or Chrome in the settings.', edgeError, chromeError);
    assert.deepEqual(error.cause, { edgeError, chromeError });
    const message = formatCliError(error);
    assert.match(message, /--browser/);
    assert.match(message, /browserPath/);
    assert.doesNotMatch(message, /in the settings/);
    assert.ok(message.endsWith('\n  Edge: edge missing\n  Chrome: chrome missing'), message);
    const multiline = formatCliError(new PdfBrowserUnavailableError('x', new Error("browserType.launch: Executable doesn't exist\n=== logs ===\nlong log"), ''));
    assert.ok(multiline.endsWith("\n  Edge: browserType.launch: Executable doesn't exist\n  Chrome: unknown error"), multiline);
    const missingLibrary = formatCliError(new PdfBrowserUnavailableError('x', new Error('a'), new Error(
      'browserType.launch: Browser closed.\n<launching> /opt/chrome\n[pid=1][err] chrome: error while loading shared libraries: libnss3.so: cannot open shared object file')));
    assert.ok(missingLibrary.endsWith('Chrome: browserType.launch: Browser closed. — [pid=1][err] chrome: '
      + 'error while loading shared libraries: libnss3.so: cannot open shared object file'), missingLibrary);
    assert.equal(formatCliError(new Error('Output already exists: x')), 'Output already exists: x');
    assert.equal(formatCliError('plain failure'), 'plain failure');

    const defaults = { headerFooterFontSize: 6, headerFooterPadding: 15 };
    assert.equal(headerFooterTemplate('', 'left', defaults), '<span></span>');
    assert.equal(headerFooterTemplate('<b> {page}/{pages}', 'center', defaults),
      '<div style="font-size:6pt;width:100%;padding:0 15mm;text-align:center;color:#666">&lt;b&gt; <span class="pageNumber"></span>/<span class="totalPages"></span></div>');
    assert.match(headerFooterTemplate('x', 'right', { headerFooterFontSize: 10, headerFooterPadding: 0 }), /font-size:10pt;width:100%;padding:0 0mm;text-align:right/);
    const literal = headerFooterTemplate('\uE000page} {page}', 'left', defaults);
    assert.ok(literal.includes('{page} <span class="pageNumber"></span>'), literal);
  });

  /**
   * 配布物のライセンス文書と、中断済みの要求を検証する。
   * 回帰リスク: バンドルした Playwright の包括通知の欠落、未使用の BiDi 実装の配布、中断後に描画や書き込みへ進むこと。
   */
  test('license notices are bundled and a cancelled conversion writes nothing', async () => {
    const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
    const version = lock.packages['node_modules/playwright-core'].version;
    const licenseRoot = path.join(path.dirname(fileURLToPath(new URL('../package-lock.json', import.meta.url))), 'dist', 'third-party-licenses', `playwright-core@${version}`);
    for (const licenseFile of ['ThirdPartyNotices.txt', 'lib/webp_codec.LICENSE', 'lib/serverRegistry.js.LICENSE', 'lib/utilsBundle.js.LICENSE']) {
      assert.ok((await readFile(path.join(licenseRoot, licenseFile), 'utf8')).trim().length > 0, `${licenseFile} must contain its license text`);
    }
    assert.doesNotMatch(await readFile(path.join(licenseRoot, '..', 'README.md'), 'utf8'), /chromium-bidi@/);
    await withDirectory(async (directory) => {
      const controller = new AbortController();
      controller.abort();
      const output = path.join(directory, 'cancelled.html');
      const { convert } = requireCli(cli);
      await assert.rejects(convert({ input: path.join(directory, 'input.md'), output, format: 'html', language: 'ja', theme: 'dark',
        mermaidTheme: 'dark', linked: false, embedImages: false, outline: false, signal: controller.signal }), (cause) => cause.name === 'AbortError');
      await assert.rejects(readFile(output), { code: 'ENOENT' });
    });
  });

  /**
   * 変換を始める前に止まる誤り（設定ファイル・引数・入出力の組み合わせ・出力先の衝突）を、実際の CLI で検証する。
   * ブラウザーを起動しない経路だけを集め、全ケースを並列に実行する。各ケースで終了コード・文言・書き込みの有無を確かめる。
   * 回帰リスク: 誤記を正規化で隠して既定値で変換する、終了コード（引数・設定は2、変換の失敗は1）が変わる、
   * BOM 付きの設定を「Invalid JSON」とする、既存の出力・入力・ハードリンクの別名を上書きする、--json の形が変わる。
   */
  test('configuration and input errors exit before any conversion', async () => {
    await withDirectory(async (directory) => {
      const config = (name, value) => [name, typeof value === 'string' ? value : JSON.stringify(value)];
      await writeFiles(directory, Object.fromEntries([
        ['input.md', '# Source\n'], ['b.md', '# B\n'], ['exists.html', 'sentinel'], ['conflict/same.md', '# One\n'], ['conflict/same.textile', 'h1. Two\n'],
        config('bad-json.json', '{ invalid json'), config('letter.json', { pdf: { format: 'Letter' } }),
        config('pattern.json', { pdf: { textReplacements: [{ pattern: '[', replacement: 'x' }] } }),
        config('margins.json', { pdf: { margins: { top: 'invalid' } } }), config('align.json', { pdf: { headerAlign: 'middle' } }),
        config('bom.json', '\uFEFF' + JSON.stringify({ pdf: { format: 'Letter' } })),
        config('front-matter.json', { rendering: { frontMatter: 'unknown' } }), config('timeout.json', { rendering: { renderTimeout: 'abc' } }),
        config('unknown.json', { pdf: { paper: 'A4' } }), config('top.json', { output: 'x' }),
      ]));
      await link(path.join(directory, 'input.md'), path.join(directory, 'alias.pdf')).catch(() => undefined);
      const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
      const cases = [
        [['--help'], 0, /^$/, (result) => assert.match(result.stdout, /mve-convert INPUT\.md/)],
        [['--version'], 0, /^$/, (result) => assert.equal(result.stdout, `${version}\n`)],
        [['input.md', '--format', 'html', '--config', 'bad-json.json'], 2, /JSON/],
        [['input.md', '--format', 'pdf', '-o', 'letter.pdf', '--config', 'letter.json'], 2, /Invalid pdf\.format/],
        [['input.md', '--format', 'pdf', '-o', 'pattern.pdf', '--config', 'pattern.json'], 2, /Invalid pdf\.textReplacements/],
        [['input.md', '--format', 'pdf', '-o', 'margins.pdf', '--config', 'margins.json'], 2, /Invalid pdf/],
        [['input.md', '--format', 'pdf', '-o', 'align.pdf', '--config', 'align.json'], 2, /Invalid pdf\.headerAlign/],
        [['input.md', '--format', 'pdf', '-o', 'bom.pdf', '--config', 'bom.json'], 2, /^(?![\s\S]*Invalid JSON)[\s\S]*Invalid pdf/],
        [['input.md', '--format', 'html', '--config', 'front-matter.json'], 2, /Invalid frontMatter/],
        [['input.md', '--format', 'pdf', '--config', 'timeout.json'], 2, /Invalid renderTimeout/],
        [['input.md', '--format', 'pdf', '--config', 'unknown.json'], 1, /Unknown pdf key: paper/],
        [['input.md', '--format', 'pdf', '--config', 'top.json'], 2, /Unknown configuration key: output/],
        [['input.md', '--format', 'pdf', '--browser-timeout', '0'], 2, /Invalid browser timeout/],
        [['input.md', '--json'], 2, /--format/, (result) => assert.match(JSON.parse(result.stdout).error, /--format/)],
        [['missing.md', '--format', 'html', '--json'], 1, /ENOENT/, (result) => {
          const report = JSON.parse(result.stdout);
          assert.equal(report.error, undefined);
          assert.match(report.results[0].error, /ENOENT/);
        }],
        [['input.md', '--format', 'html', '-o', 'exists.html'], 1, /Output already exists/],
        [['input.md', '--format', 'html', '-o', 'exists'], 1, /Output already exists/],
        [['input.md', '--format', 'pdf', '-o', 'input.md', '--force'], 1, /Output must differ from input/],
        [['input.md', '--format', 'pdf', '-o', 'alias.pdf', '--force'], 1, /Output must differ from input/],
        [['input.md', '--format', 'html', '-o', 'css.html', '--css', 'missing.css'], 1, /missing\.css/],
        [['conflict/*', '--format', 'html'], 1, /Output paths must be distinct/],
        [['input.md', 'b.md', '--format', 'html', '-o', 'x.html'], 2, /use --out-dir/],
        [['input.md', 'b.md', '--format', 'html', '--html-linked'], 2, /single input/],
        [['input.md', 'b.md', '--format', 'html', '--title', 'T'], 2, /--title applies to a single input/],
        [['nothing/*.md', '--format', 'html'], 1, /No documents matched/],
        [['-', '--format', 'html', '--html-linked'], 2, /--html-linked cannot be combined with standard output/],
        [['input.md', 'b.md', '--merge', '--format', 'html', '-o', 'x.html'], 2, /Invalid --merge/],
      ];
      await Promise.all(cases.map(async ([args, code, stderr, check]) => {
        const result = await runWithoutBrowser(args, { cwd: directory });
        assert.equal(result.code, code, `${args.join(' ')}\n${result.stderr}`);
        assert.match(result.stderr, stderr, args.join(' '));
        check?.(result);
      }));
      assert.equal(await readFile(path.join(directory, 'exists.html'), 'utf8'), 'sentinel');
      assert.equal(await readFile(path.join(directory, 'input.md'), 'utf8'), '# Source\n');
      const written = (await readdir(directory)).filter((name) => /\.(?:pdf|html)$/.test(name) && !['exists.html', 'alias.pdf'].includes(name));
      assert.deepEqual(written, [], 'no output may be written');
      assert.deepEqual((await readdir(path.join(directory, 'conflict'))).sort(), ['same.md', 'same.textile']);
    });
  });

  /**
   * --format md|textile が描画せずに記法だけを書き換え、改行コード・BOM・入力を保つことと、設定ファイルの自動検出を検証する。
   * ブラウザーを使わない（存在しないブラウザーを指定しても成功する）。
   * 回帰リスク: CRLF が LF になる、BOM が消える・増える、同じ記法への変換で入力を上書きする、同じ意味の記法がない行を
   * 黙って変える、--strict で出力を書かない、自動検出した設定の誤りでどのファイルか分からない、--no-config・--config が効かない、
   * 同名のディレクトリを設定として読む。
   */
  test('syntax conversion and configuration discovery run without a browser', async () => {
    await withDirectory(async (directory) => {
      const bom = '\uFEFF';
      const textileSource = bom + 'h1. Title\r\n\r\n* one *bold*\r\n* two\r\n';
      await writeFiles(directory, {
        'doc.textile': textileSource, 'note.md': '# Note\n\n> quote\n> > nested\n',
        'mve-convert.json': JSON.stringify({ pdf: { format: 'Letter' } }), 'explicit.json': JSON.stringify({ pdf: { format: 'A5' } }),
        'a/b/doc.textile': 'h1. Nested\n',
      });
      await mkdir(path.join(directory, 'a', 'b', 'mve-convert.json'));
      const nested = path.join(directory, 'a', 'b');
      // 自動検出した設定の誤りは、どのファイルかを添えて終了コード2で止める（同名のディレクトリは読み飛ばす）。
      const found = await runWithoutBrowser(['doc.textile', '--format', 'md'], { cwd: nested });
      assert.equal(found.code, 2, found.stderr);
      assert.match(found.stderr, /^Invalid pdf\.format\./m);
      const reported = /\(in (.+); pass --no-config to ignore it\)/.exec(found.stderr)?.[1];
      assert.equal(await realpath(reported), await realpath(path.join(directory, 'mve-convert.json')));
      const ignored = await runWithoutBrowser(['doc.textile', '--format', 'md', '--no-config'], { cwd: nested });
      assert.equal(ignored.stdout.trim(), path.join(nested, 'doc.md'));
      const explicit = await runWithoutBrowser(['doc.textile', '--format', 'md', '--force', '--config', path.join(directory, 'explicit.json')], { cwd: nested });
      assert.equal(explicit.code, 0, explicit.stderr);

      const toMarkdown = await runWithoutBrowser(['doc.textile', '--format', 'md', '--no-config', '--browser', path.join(directory, 'no-browser.exe')], { cwd: directory });
      assert.equal(toMarkdown.stdout.trim(), path.join(directory, 'doc.md'));
      assert.equal(await readFile(path.join(directory, 'doc.md'), 'utf8'), bom + '# Title\r\n\r\n- one **bold**\r\n- two\r\n');
      assert.equal(await readFile(path.join(directory, 'doc.textile'), 'utf8'), textileSource);
      const [toTextile, strict, same, sameExplicit, exists] = await Promise.all([
        runWithoutBrowser(['note.md', '-o', '-', '--format', 'textile', '--no-config'], { cwd: directory }),
        runWithoutBrowser(['note.md', '--format', 'textile', '--strict', '--no-config'], { cwd: directory }),
        runWithoutBrowser(['note.md', '--format', 'md', '--force', '--no-config'], { cwd: directory }),
        runWithoutBrowser(['doc.md', '--format', 'md', '-o', 'x.md', '--no-config'], { cwd: directory }),
        runWithoutBrowser(['doc.textile', '--format', 'md', '--no-config'], { cwd: directory }),
      ]);
      assert.match(toTextile.stdout, /^h1\. Note\n/);
      assert.match(toTextile.stderr, /Line\(s\) \d+(, \d+)* use syntax that has no exact equivalent/);
      assert.equal(strict.code, 1);
      assert.match(strict.stderr, /treated as errors by --strict/);
      assert.ok(await readFile(path.join(directory, 'note.textile'), 'utf8'), '--strict still writes the output');
      assert.equal(same.code, 2);
      assert.match(same.stderr, /is already Markdown; use --format textile/);
      assert.equal(await readFile(path.join(directory, 'note.md'), 'utf8'), '# Note\n\n> quote\n> > nested\n');
      assert.equal(sameExplicit.code, 2);
      assert.match(sameExplicit.stderr, /is already Markdown/);
      assert.equal(exists.code, 1);
      assert.match(exists.stderr, /Output already exists/);
    });
  });

  /**
   * 標準入力・標準出力と同時実行を、4回の変換で確かめる。
   * 標準入力→標準出力（HTML）: 生成物だけが流れ、相対画像の基準は --base-dir、BOM と front matter を扱い、--title が front matter より優先し、
   *   --html-outline と --language でアウトラインを付ける（最小幅80px・項目のフォント・見出しの折り返し防止・字下げ・日本語の見出し）。
   *   front matter の YAML のコメント行（#）はアウトラインの見出しにならない。
   * ファイル→標準出力: 読み手が先に閉じても、未処理例外のスタックトレースではなく終了コード1で終える。
   * 標準入力→同じファイルへの同時の2回: 一方だけが新規作成し（出力パスを表示）、他方は上書きせずに失敗する。
   */
  test('standard input, standard output, and concurrent conversions', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      await writeFiles(directory, { 'real.png': onePixelPng, 'file.md': '# File marker\n' });
      const closedPipe = () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, 'file.md', '--format', 'html', '-o', '-', '--browser', browserPath, '--browser-timeout', '30'], { cwd: directory });
        let stderr = '';
        child.stdout.once('data', () => child.stdout.destroy());
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr }));
      });
      const markers = ['ConcurrentAlphaMarker', 'ConcurrentBetaMarker'];
      const output = path.join(directory, 'result.html');
      const [html, closed, ...writers] = await Promise.all([
        run(['-', '--format', 'html', '--html-embed-images', '--base-dir', directory, '--title', 'From option', '--html-outline', '--language', 'ja'],
          { input: '\uFEFF---\ntitle: Piped\n# CommentMarker\nkey: value\n---\n\n# \u898B\u51FA\u3057\n\n![x](real.png)\n' }),
        closedPipe(),
        ...markers.map((marker) => run(['-', '--format', 'html', '--output', output], { input: `# ${marker}\n` })),
      ]);
      assert.equal(html.code, 0, html.stderr);
      assert.ok(html.stdout.startsWith('<!doctype html>'), html.stdout.slice(0, 40));
      assert.match(html.stdout, /<title>From option<\/title>/);
      assert.match(html.stdout, /\u898B\u51FA\u3057/);
      assert.doesNotMatch(html.stdout, /CommentMarker/);
      assert.ok(html.stdout.includes(onePixelPng.toString('base64')));
      assert.match(html.stdout, /class="mve-html-outline-resizer"[^>]*aria-valuemin="80"/);
      assert.match(html.stdout, /grid-template-columns: minmax\(80px, var\(--mve-html-outline-width, 240px\)\)/);
      assert.match(html.stdout, /const minimumWidth = 80;/);
      assert.match(html.stdout, /\.mve-html-outline nav \{[^}]*font-size: 14px;/);
      assert.match(html.stdout, /\.mve-html-outline-children \{ margin-left: 12px; \}/);
      assert.match(html.stdout, /\.mve-html-outline-header > span \{[^}]*white-space: nowrap;/);
      assert.match(html.stdout, /<span>\u30A2\u30A6\u30C8\u30E9\u30A4\u30F3<\/span>/);
      assert.doesNotMatch(closed.stderr, /Unhandled|node:events/);
      assert.equal(closed.code, 1, closed.stderr);
      const winner = writers.findIndex((result) => result.code === 0);
      assert.equal(writers.filter((result) => result.code === 0).length, 1);
      assert.equal(writers[winner].stdout.trim(), output);
      assert.equal(writers[1 - winner].code, 1);
      assert.match(writers[1 - winner].stderr, /Output already exists|EEXIST/);
      const written = await readFile(output, 'utf8');
      assert.ok(written.includes(markers[winner]) && !written.includes(markers[1 - winner]));
      assert.deepEqual((await readdir(directory)).sort(), ['file.md', 'real.png', 'result.html']);
    });
  });

  /**
   * 複数入力・ワイルドカード・--out-dir を、並列に実行する2回の一括変換で確かめる。
   * 1回目: 出力の相対位置（パターンの前の部分を基準）、除外（隠し・node_modules は ** では入らず、明示すれば入る）、
   *   1件の失敗（front matter の誤記）で残りを止めずに終了コード1。並行して、ワイルドカード文字を含む実在のファイル名
   *   （POSIX だけが作れる）をパターンとして解釈しないことを単独の変換で確かめる。
   * 2回目: 既存の出力がある出力先へ --force で再実行し、出力の一覧の読み手を途中で閉じる（ReFS などでの誤った拒否と、閉じた読み手での
   *   未処理例外がない）。一致が1つの下位ディレクトリに偏っても、出力の階層はパターンの前の部分から決まる。
   */
  test('batches and wildcard patterns convert every document', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      const literal = process.platform !== 'win32';
      await writeFiles(directory, {
        'docs/a.md': '# A marker\n', 'docs/sub/b.markdown': '# B marker\n', 'docs/sub/c.textile': 'h1. C marker\n', 'docs/sub/image.png': onePixelPng,
        'docs/node_modules/skip.md': '# Skip\n', 'docs/.hidden/skip.md': '# Skip\n',
        'docs/bad.md': '---\nmve-convert:\n  pdf:\n    format: Letter\n---\n# Bad\n',
        'stable/sub/b.html': 'sentinel',
        ...(literal ? { 'star*.md': '# Literal star marker\n', 'starother.md': '# Other\n' } : {}),
      });
      const out = path.join(directory, 'out');
      const stable = path.join(directory, 'stable');
      // パターンとして解釈されると2件に一致し、-o と複数入力の組み合わせの誤りになる。
      const literalRun = literal ? run(['star*.md', '--format', 'html', '--output', 'literal.html'], { cwd: directory }) : undefined;
      const [first, rerun, noMatch] = await Promise.all([
        run(['docs/**/*', 'docs/node_modules/*.md', '--format', 'html', '--out-dir', out], { cwd: directory }),
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [cli, 'docs/**/b*.markdown', '--format', 'html', '--out-dir', stable, '--force', '--browser', browserPath,
            '--browser-timeout', '30'], { cwd: directory });
          let stderr = '';
          child.stdout.once('data', () => child.stdout.destroy());
          child.stderr.on('data', (chunk) => { stderr += chunk; });
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, stderr }));
        }),
        runWithoutBrowser(['docs/*/*.md', '--format', 'html', '--out-dir', 'none'], { cwd: directory }),
      ]);
      assert.equal(first.code, 1, first.stderr);
      assert.match(first.stderr, /bad\.md: Invalid front matter mve-convert/);
      const expected = ['a.html', 'sub/b.html', 'sub/c.html', 'node_modules/skip.html'].map((name) => path.join(out, name));
      assert.deepEqual(first.stdout.trim().split(/\r?\n/).sort(), expected.slice().sort());
      assert.match(await readFile(path.join(out, 'sub', 'c.html'), 'utf8'), /C marker/);
      assert.match(await readFile(path.join(out, 'node_modules', 'skip.html'), 'utf8'), /Skip/);
      await assert.rejects(readFile(path.join(out, '.hidden', 'skip.html')), { code: 'ENOENT' });
      if (literalRun) {
        const result = await literalRun;
        assert.equal(result.code, 0, result.stderr);
        assert.match(await readFile(path.join(directory, 'literal.html'), 'utf8'), /Literal star marker/);
      }
      assert.equal(rerun.code, 0, rerun.stderr);
      assert.doesNotMatch(rerun.stderr, /Unhandled|node:events|Output must differ|Output already exists/);
      await assert.rejects(readFile(path.join(stable, 'b.html')), { code: 'ENOENT' });
      assert.match(await readFile(path.join(stable, 'sub', 'b.html'), 'utf8'), /B marker/);
      assert.equal(noMatch.code, 1);
      assert.match(noMatch.stderr, /No documents matched/);
    });
  });

  /**
   * 監視（--watch）を検証する。--watch は変わった入力だけを変換し直し、実行前からあった出力を --force なしでは上書きせず、Ctrl+C（130）で終わる。
   * Windows では子プロセスへ SIGINT を送れないため、停止用ファイルを見て SIGINT を発生させる読み込み前のスクリプトを使う。
   */
  test('--watch converts changed inputs again and keeps existing files safe', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      const stop = path.join(directory, 'stop');
      await writeFiles(directory, {
        'kept.md': '# Kept\n', 'edited.md': '# First\n', 'kept.html': 'sentinel',
        'stop.cjs': ["const fs = require('node:fs');",
          `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) { clearInterval(timer); process.emit('SIGINT'); } }, 50);`,
          'timer.unref();', ''].join('\n'),
      });
      const child = spawn(process.execPath, ['--require', path.join(directory, 'stop.cjs'), cli, 'kept.md', 'edited.md', '--format', 'html', '--watch',
        '--browser', browserPath, '--browser-timeout', '30'], { cwd: directory });
      const state = { stdout: '', stderr: '' };
      child.stdout.on('data', (chunk) => { state.stdout += chunk; });
      child.stderr.on('data', (chunk) => { state.stderr += chunk; });
      const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
      const editedOutput = path.join(directory, 'edited.html');
      const describeState = () => `stdout: ${state.stdout}\nstderr: ${state.stderr}`;
      try {
        await waitFor(() => /Watching 2 file\(s\)/.test(state.stderr), 'the watcher to start', describeState);
        assert.match(state.stderr, /kept\.md: Output already exists/);
        assert.match(await readFile(editedOutput, 'utf8'), /First/);
        await writeFile(path.join(directory, 'edited.md'), '# Second\n');
        await waitFor(() => state.stdout.split(editedOutput).length - 1 >= 2, 'the edited document to be converted again', describeState);
        assert.match(await readFile(editedOutput, 'utf8'), /Second/);
        assert.equal(await readFile(path.join(directory, 'kept.html'), 'utf8'), 'sentinel');
      } finally {
        await writeFile(stop, '');
      }
      assert.equal(await exited, 130, state.stderr);
    });
  });

  /**
   * 中断（Ctrl+C）を検証する。描画中の中断は速やかに130で終わって --json に結果を出し、処理が永久に終わらない状態でも
   * 猶予時間で必ず終わる。Windows ではシグナルを外部から送れないため、読み込み前のスクリプトでプロセス内へ発火させる。
   * 回帰リスク: Playwright の既定の SIGINT 処理が先にプロセスを終えて結果を失う、残ったタイマーで終了が数分遅れる、止まり続ける。
   */
  test('interrupts exit with 130 and report the JSON result', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      await writeFiles(directory, {
        'input.md': '# Interrupted\n\n```mermaid\ngraph TD\n  A --> B\n```\n', 'hang.md': '# Hang\n',
        'interrupt.cjs': ['const original = globalThis.setTimeout;', 'let fired = false;',
          'globalThis.setTimeout = function (callback, delay, ...rest) {', '  if (delay === 180000 && !fired) {', '    fired = true;',
          "    original(() => { if (process.listenerCount('SIGINT') !== 1) process.stderr.write('foreign SIGINT handler\\n'); process.emit('SIGINT'); }, 0);",
          '  }', '  return original(callback, delay, ...rest);', '};', 'original(() => undefined, 170000);', ''].join('\n'),
        'hang.cjs': ["const fs = require('node:fs');", 'const stat = fs.promises.stat;', 'fs.promises.stat = function (file, ...rest) {',
          "  if (String(file).endsWith('hang.md')) { setTimeout(() => process.emit('SIGINT'), 50); return new Promise(() => undefined); }",
          '  return stat.call(this, file, ...rest);', '};', ''].join('\n'),
      });
      const started = performance.now();
      const [rendering, hanging] = await Promise.all([
        run(['input.md', '--format', 'html', '--json'], { cwd: directory, node: ['--require', path.join(directory, 'interrupt.cjs')] }),
        run(['hang.md', '--format', 'html', '--json'], { cwd: directory, node: ['--require', path.join(directory, 'hang.cjs')], browser: false }),
      ]);
      assert.ok(performance.now() - started < 60_000, 'the process must not wait for the diagram timer');
      for (const [result, input] of [[rendering, 'input.md'], [hanging, 'hang.md']]) {
        assert.equal(result.code, 130, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.ok, false);
        assert.equal(report.results[0].input, path.join(directory, input));
        assert.equal(report.results[0].error, 'Conversion was interrupted.');
      }
      assert.doesNotMatch(rendering.stderr, /foreign SIGINT handler/);
      assert.match(rendering.stderr, /^Conversion was interrupted\.\r?\n$/m);
      await assert.rejects(readFile(path.join(directory, 'input.html')), { code: 'ENOENT' });
      // シンボリックリンクを作れる環境では、出力先のリンクの別名でも入力を守ることを確かめる（作れない環境では省く）。
      await symlink(path.join(directory, 'input.md'), path.join(directory, 'link.pdf')).then(async () => {
        const aliased = await runWithoutBrowser(['input.md', '--format', 'pdf', '-o', 'link.pdf', '--force'], { cwd: directory });
        assert.equal(aliased.code, 1);
        assert.match(aliased.stderr, /Output must differ from input/);
      }, (error) => { if (error.code !== 'EPERM') throw error; });
    });
  });
});
