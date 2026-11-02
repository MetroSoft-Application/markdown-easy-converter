/**
 * @fileoverview CLI の引数・出力衝突と、ブラウザーを使う HTML / PDF / Marp 描画を検証する。
 * ブラウザー必須の公開ゲートでは描画テストのスキップを許さない。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import test from 'node:test';
import { findTestBrowser } from './browser.mjs';

/** CLI成果物はテストの配置から解決し、呼び出し側の作業ディレクトリに依存しない。 */
const cli = fileURLToPath(new URL('../dist/mve-convert.cjs', import.meta.url));
/** 子プロセスの終了コードと出力を取得するためのPromise版。 */
const execute = promisify(execFile);
/** CLIの公開APIをパッケージ成果物から読み込む。 */
const require = createRequire(import.meta.url);
/** HTML/PDF/Marp の実描画に使用するブラウザー。 */
const browserPath = findTestBrowser();
if (process.env.MVE_REQUIRE_BROWSER_TESTS === '1' && !browserPath) {
  throw new Error('Browser tests are required, but no Chromium/Edge/Chrome executable was found.');
}

/**
 * 意図した入力だけを用いる一時ディレクトリを作り、テスト終了後に解放する。
 * @param callback - 一時ディレクトリ内で実行する検証。
 */
async function withDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mve-cli-test-'));
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
 * 不正な引数や出力先衝突を、書き込み前に区別する契約を検証する。
 */
test('argument errors and output collisions do not overwrite files', async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.html');
    await writeFile(input, '# Source\n');
    await writeFile(output, 'sentinel');
    for (const requestedOutput of [output, output.slice(0, -5)]) {
      await assert.rejects(execute(process.execPath, [cli, input, '--format', 'html', '--output', requestedOutput]),
        (error) => error.code === 1 && /Output already exists/.test(error.stderr));
      assert.equal(await readFile(output, 'utf8'), 'sentinel');
    }
    await assert.rejects(execute(process.execPath, [cli, input, '--format', 'pdf', '--output', input, '--force']),
      (error) => error.code === 1 && /Output must differ from input/.test(error.stderr));
    assert.equal(await readFile(input, 'utf8'), '# Source\n');
    await assert.rejects(execute(process.execPath, [cli, input, '--format', 'unknown']),
      (error) => error.code === 2 && /Invalid format/.test(error.stderr));
    for (const option of ['--html-embed-images', '--html-no-embed-images', '--html-linked', '--html-outline']) {
      await assert.rejects(execute(process.execPath, [cli, input, '--format', 'pdf', option]),
        (error) => error.code === 2 && /HTML-only options/.test(error.stderr));
    }
  });
});

/** 拡張子補完後の既存HTMLは、明示的な--forceを指定した場合だけ置換できる。 */
test('force overwrites the normalized HTML destination', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'result.html');
    await writeFile(input, '# Replacement marker\n');
    await writeFile(output, 'sentinel');
    const result = await execute(process.execPath, [cli, input, '--format', 'html',
      '--output', output.slice(0, -5), '--browser', browserPath, '--force']);
    assert.equal(result.stdout.trim(), output);
    assert.match(await readFile(output, 'utf8'), /Replacement marker/);
    assert.equal(await readFile(input, 'utf8'), '# Replacement marker\n');
  });
});

/** 主文書とリンク先、または拡張子だけ異なるリンク先の出力衝突は、forceでも全書込前に拒否する。 */
test('linked output collisions fail before writing any document', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'index.md');
    await writeFile(path.join(directory, 'child.md'), '# Child marker\n');
    await writeFile(path.join(directory, 'page.md'), '# Markdown marker\n');
    await writeFile(path.join(directory, 'page.textile'), 'h1. Textile marker\n');
    for (const [markdown, destination] of [
      ['[Child](child.md)\n', 'child.html'],
      ['[Markdown](page.md)\n\n[Textile](page.textile)\n', 'index.html'],
    ]) {
      await writeFile(input, markdown);
      for (const force of [[], ['--force']]) {
        await assert.rejects(execute(process.execPath, [cli, input, '--format', 'html',
          '--output', path.join(directory, destination), '--html-linked', '--browser', browserPath, ...force]),
        (error) => error.code === 1 && /Output paths must be distinct/.test(error.stderr));
        assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.html')), []);
        assert.equal(await readFile(input, 'utf8'), markdown);
      }
    }
  });
});

/** 同時実行した別文書は既存確認を両方通過しても、一方だけが出力を新規作成できる。 */
test('concurrent conversions do not overwrite each other without force', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const output = path.join(directory, 'result.html');
    const markers = ['ConcurrentAlphaMarker', 'ConcurrentBetaMarker'];
    const inputs = markers.map((marker) => path.join(directory, `${marker}.md`));
    for (let index = 0; index < inputs.length; index += 1) {
      await writeFile(inputs[index], `# ${markers[index]}\n`);
    }
    const results = await Promise.allSettled(inputs.map((input) => execute(process.execPath,
      [cli, input, '--format', 'html', '--output', output, '--browser', browserPath])));
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const loser = results[1 - winner];
    assert.equal(loser.reason.code, 1);
    assert.match(loser.reason.stderr, /Output already exists|EEXIST/);
    const html = await readFile(output, 'utf8');
    assert.ok(html.includes(markers[winner]));
    assert.ok(!html.includes(markers[1 - winner]));
  });
});

/** 大小文字を区別する実ファイルシステムでは、両文書の本文とリンク先を別々に保持する。 */
test('linked documents preserve case-sensitive filenames', { skip: !browserPath }, async (context) => {
  await withDirectory(async (directory) => {
    const upper = path.join(directory, 'A.md');
    const lower = path.join(directory, 'a.md');
    await writeFile(upper, '# UpperCaseMarker\n', { flag: 'wx' });
    try {
      await writeFile(lower, '# LowerCaseMarker\n', { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      context.skip('The temporary filesystem does not distinguish filename case.');
      return;
    }
    const input = path.join(directory, 'index.md');
    const output = path.join(directory, 'index.html');
    await writeFile(input, '[Upper](A.md)\n\n[Lower](a.md)\n');
    await execute(process.execPath, [cli, input, '--format', 'html', '--output', output,
      '--html-linked', '--browser', browserPath]);
    const html = await readFile(output, 'utf8');
    assert.match(html, /href="A\.html"/);
    assert.match(html, /href="a\.html"/);
    assert.match(await readFile(path.join(directory, 'A.html'), 'utf8'), /UpperCaseMarker/);
    assert.match(await readFile(path.join(directory, 'a.html'), 'utf8'), /LowerCaseMarker/);
  });
});

/**
 * 設定エラーが変換前に報告され、基本のCLI操作が実行可能なことを検証する。
 */
test('help, version and malformed JSON configuration', async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const config = path.join(directory, 'export.json');
    await writeFile(input, '# Source\n');
    await writeFile(config, '{ invalid json');
    const help = await execute(process.execPath, [cli, '--help']);
    assert.match(help.stdout, /mve-convert INPUT\.md/);
    const version = await execute(process.execPath, [cli, '--version']);
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(version.stdout, `${metadata.version}\n`);
    await assert.rejects(execute(process.execPath, [cli, input, '--format', 'html', '--config', config]),
      (error) => error.code === 2 && /JSON/.test(error.stderr));
  });
});

/**
 * PDF設定の誤記と壊れた置換パターンは、正規化で隠さず書き込み前に拒否する。
 */
test('invalid export settings fail before output is written', async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.pdf');
    const config = path.join(directory, 'export.json');
    await writeFile(input, '# Source\n');
    for (const pdf of [
      { format: 'Letter' },
      { textReplacements: [{ pattern: '[', replacement: 'x' }] },
      { margins: { top: 'invalid' } },
    ]) {
      await writeFile(config, JSON.stringify({ pdf }));
      await assert.rejects(execute(process.execPath,
        [cli, input, '--format', 'pdf', '--output', output, '--config', config]),
      (error) => error.code === 2 && /Invalid pdf/.test(error.stderr));
      await assert.rejects(readFile(output), { code: 'ENOENT' });
    }
  });
});

/** `--force` でも原文のハードリンク別名は入力として保護する。 */
test('force refuses an output hard link to the input', async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.pdf');
    await writeFile(input, '# Keep this source\n');
    await link(input, output);
    await assert.rejects(execute(process.execPath,
      [cli, input, '--format', 'pdf', '--output', output, '--force']),
    (error) => error.code === 1 && /Output must differ from input/.test(error.stderr));
    assert.equal(await readFile(input, 'utf8'), '# Keep this source\n');
  });
});

/** 中断済みの要求は描画やファイル書き込みへ進めない。 */
test('a cancelled conversion does not write an output', async () => {
  await withDirectory(async (directory) => {
    const controller = new AbortController();
    controller.abort();
    const output = path.join(directory, 'cancelled.html');
    const { convert } = require(cli);
    await assert.rejects(convert({ input: path.join(directory, 'input.md'), output,
      format: 'html', language: 'ja', theme: 'dark', mermaidTheme: 'dark',
      linked: false, embedImages: false, outline: false, signal: controller.signal }),
    (error) => error.name === 'AbortError');
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  });
});

/** インストール済みブラウザーを使い、HTML・PDFとMermaidの成功出力を確認する。 */
test('HTML and PDF exports produce rendered output', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const htmlOutput = path.join(directory, 'output.html');
    const pdfOutput = path.join(directory, 'output.pdf');
    await writeFile(input, '# Published package smoke\n\n```mermaid\ngraph TD\n  A[Start] --> B[Finish]\n```\n');

    await execute(process.execPath,
      [cli, input, '--format', 'html', '--output', htmlOutput, '--browser', browserPath]);
    const html = await readFile(htmlOutput, 'utf8');
    assert.match(html, /Published package smoke/);
    assert.match(html, /<svg\b/);

    await execute(process.execPath,
      [cli, input, '--format', 'pdf', '--output', pdfOutput, '--browser', browserPath]);
    const pdf = await readFile(pdfOutput);
    assert.equal(pdf.toString('ascii', 0, 5), '%PDF-');
  });
});

/**
 * 構文エラーの Mermaid 図が 1 つあっても文書全体の出力を中断せず、その図だけをエラー表示へ置き換えることを確認する。
 * 回帰リスク: 図ごとの失敗が Promise.all で文書全体の失敗へ広がり、HTML / PDF が一切出力されなくなる。
 */
test('a Mermaid syntax error is embedded as an error message without failing the export', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'mermaid-error.md');
    const htmlOutput = path.join(directory, 'mermaid-error.html');
    const pdfOutput = path.join(directory, 'mermaid-error.pdf');
    await writeFile(input, [
      '# Mermaid error marker',
      '',
      '```mermaid',
      'graph TD',
      '  A[Start] --> B[Finish]',
      '```',
      '',
      '```mermaid',
      'flowchart THIS_IS_NOT_VALID',
      '  broken -->',
      '```',
      '',
      'Text after the broken diagram',
      ''
    ].join('\n'));

    const { stderr } = await execute(process.execPath,
      [cli, input, '--format', 'html', '--output', htmlOutput, '--browser', browserPath]);
    const html = await readFile(htmlOutput, 'utf8');
    assert.match(html, /<svg\b/);
    assert.match(html, /data-mermaid-status="error"/);
    assert.match(html, /<pre class="mermaid-error-message" role="alert">Mermaid syntax error\nMermaid diagram could not be rendered\.<\/pre>/);
    assert.match(html, /Text after the broken diagram/);
    assert.match(stderr, /Mermaid diagram 2 could not be rendered \(Mermaid diagram could not be rendered\.\)/);

    await execute(process.execPath,
      [cli, input, '--format', 'pdf', '--output', pdfOutput, '--browser', browserPath]);
    const pdf = await readFile(pdfOutput);
    assert.equal(pdf.toString('ascii', 0, 5), '%PDF-');
  });
});

/**
 * ソース長の上限を超える Mermaid 図も、文書全体を中断せず理由付きのエラー表示へ置き換えることを確認する。
 * 回帰リスク: 上限超過がブラウザー障害と同じ扱いになり、HTML が出力されなくなる。
 */
test('an oversized Mermaid source is embedded as an error message without failing the export', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'mermaid-oversized.md');
    const output = path.join(directory, 'mermaid-oversized.html');
    await writeFile(input, [
      '# Oversized diagram',
      '',
      '```mermaid',
      `graph TD\n  A["${'x'.repeat(50_001)}"]`,
      '```',
      '',
      'Text after the oversized diagram',
      ''
    ].join('\n'));

    const { stderr } = await execute(process.execPath,
      [cli, input, '--format', 'html', '--output', output, '--browser', browserPath]);
    const html = await readFile(output, 'utf8');
    assert.match(html, /data-mermaid-status="error"/);
    assert.match(html, /<pre class="mermaid-error-message" role="alert">Mermaid syntax error\nMermaid source exceeds the 50000 character limit\.<\/pre>/);
    assert.match(html, /Text after the oversized diagram/);
    assert.match(stderr, /Mermaid diagram 1 could not be rendered \(Mermaid source exceeds the 50000 character limit\.\)/);
  });
});

/** 未信頼 Markdown の raw HTML が、配布 HTML に実行可能な属性や URL を残さない。 */
test('unsafe raw HTML is sanitized before export', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'unsafe.md');
    const output = path.join(directory, 'unsafe.html');
    await writeFile(input,
      '# Safe\n\n<script>window.injected = true</script>\n\n<img src="missing.png" onerror="alert(1)">\n\n<a href="javascript:alert(1)">link</a>\n');
    await execute(process.execPath,
      [cli, input, '--format', 'html', '--output', output, '--browser', browserPath]);
    const html = await readFile(output, 'utf8');
    assert.match(html, /Safe/);
    assert.doesNotMatch(html, /<script\b|\bonerror\s*=|javascript:/i);
  });
});

/** `--workspace-root` はアクセス制限ではなく、明示的な `--html-linked` は外部文書も読むことを記録する。 */
test('linked export can follow a Markdown path outside the workspace root', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    const input = path.join(workspace, 'index.md');
    const outside = path.join(directory, 'outside.md');
    const output = path.join(workspace, 'index.html');
    await writeFile(input, '# Index\n\n[Outside](../outside.md)\n');
    await writeFile(outside, '# Outside workspace marker\n');
    await execute(process.execPath, [cli, input, '--format', 'html', '--output', output,
      '--browser', browserPath, '--workspace-root', workspace, '--html-linked']);
    const extra = await readdir(path.join(workspace, '_linked'));
    assert.equal(extra.length, 1);
    assert.match(await readFile(path.join(workspace, '_linked', extra[0]), 'utf8'),
      /Outside workspace marker/);
  });
});

/** バンドル済みPlaywrightの包括通知を含め、未使用のBiDi実装を配布しない。 */
test('the generated license bundle includes Playwright third-party notices', async () => {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const version = lock.packages['node_modules/playwright-core'].version;
  const licenseRoot = path.join(path.dirname(fileURLToPath(new URL('../package-lock.json', import.meta.url))),
    'dist', 'third-party-licenses', `playwright-core@${version}`);
  for (const licenseFile of [
    'ThirdPartyNotices.txt',
    'lib/webp_codec.LICENSE',
    'lib/serverRegistry.js.LICENSE',
    'lib/utilsBundle.js.LICENSE'
  ]) {
    const contents = await readFile(path.join(licenseRoot, licenseFile), 'utf8');
    assert.ok(contents.trim().length > 0, `${licenseFile} must contain its license text`);
  }
  const notices = await readFile(path.join(licenseRoot, '..', 'README.md'), 'utf8');
  assert.doesNotMatch(notices, /chromium-bidi@/);
});


/** Marp HTMLでは設定front matterを本文へ出さず、PDFではスライドのCSS比率を維持する。 */
test('Marp HTML strips configuration front matter and PDF keeps slide aspect ratio', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'marp.md');
    const htmlOutput = path.join(directory, 'marp.html');
    const pdfOutput = path.join(directory, 'marp.pdf');
    await writeFile(input, '---\nmarp: true\ntheme: default\n---\n\n# Wide slide\n');

    await execute(process.execPath,
      [cli, input, '--format', 'html', '--output', htmlOutput, '--browser', browserPath]);
    const html = await readFile(htmlOutput, 'utf8');
    assert.match(html, /Wide slide/);
    assert.doesNotMatch(html, /marp:\s*true/);

    await execute(process.execPath,
      [cli, input, '--format', 'pdf', '--output', pdfOutput, '--browser', browserPath]);
    const pdf = await readFile(pdfOutput);
    assert.equal(pdf.toString('ascii', 0, 5), '%PDF-');
    const mediaBoxes = [...pdf.toString('latin1').matchAll(
      /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/g)];
    assert.equal(mediaBoxes.length, 1, 'one Marp slide must produce exactly one PDF page');
    const [, left, bottom, right, top] = mediaBoxes[0];
    const aspectRatio = (Number(right) - Number(left)) / (Number(top) - Number(bottom));
    assert.ok(Math.abs(aspectRatio - 16 / 9) < 0.02,
      `expected a 16:9 page, received ratio ${aspectRatio}`);
  });
});

/**
 * Marp スライドでも、構文エラーの Mermaid 図が 1 つあるだけで PDF 出力全体を中断しないことを確認する。
 * 回帰リスク: スライド内の図ごとの失敗が Promise.all で文書全体の失敗へ広がり、PDF が出力されなくなる。
 */
test('a Marp Mermaid syntax error is embedded as an error message without failing the PDF export', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'marp-mermaid-error.md');
    const pdfOutput = path.join(directory, 'marp-mermaid-error.pdf');
    await writeFile(input, [
      '---',
      'marp: true',
      '---',
      '',
      '# Valid diagram slide',
      '',
      '```mermaid',
      'graph TD',
      '  A[Start] --> B[Finish]',
      '```',
      '',
      '---',
      '',
      '# Broken diagram slide',
      '',
      '```mermaid',
      'flowchart THIS_IS_NOT_VALID',
      '  broken -->',
      '```',
      ''
    ].join('\n'));

    const { stderr } = await execute(process.execPath,
      [cli, input, '--format', 'pdf', '--output', pdfOutput, '--browser', browserPath]);
    const pdf = await readFile(pdfOutput);
    assert.equal(pdf.toString('ascii', 0, 5), '%PDF-');
    const mediaBoxes = [...pdf.toString('latin1').matchAll(/[/]MediaBox/g)];
    assert.equal(mediaBoxes.length, 2, 'both Marp slides must still be exported');
    assert.match(stderr, /Mermaid diagram 1 on slide 2 could not be rendered \(Mermaid diagram could not be rendered\.\)/);
  });
});

/**
 * Edge / Chrome の自動検出に失敗したとき、CLI が VS Code の設定画面ではなく --browser を案内することを検証する。
 * 回帰リスク: 共通の汎用文言 (「設定で Edge か Chrome を指定」) が CLI の利用者へそのまま表示されること。
 * 実ブラウザーの有無に依存しないよう、バンドルが公開するエラー型と整形関数を直接使う。
 */
test('browser auto-detection failure tells CLI users how to pass a browser', () => {
  const { PdfBrowserUnavailableError, formatCliError } = require(cli);
  const edgeError = new Error('edge missing');
  const chromeError = new Error('chrome missing');
  const error = new PdfBrowserUnavailableError('Could not start a PDF browser. Specify Edge or Chrome in the settings.',
    edgeError, chromeError);
  assert.deepEqual(error.cause, { edgeError, chromeError });
  const message = formatCliError(error);
  assert.match(message, /--browser/);
  assert.match(message, /browserPath/);
  assert.doesNotMatch(message, /in the settings/);
  // インストール済みでも起動できない場合を判別できるよう、各チャンネルの原因を先頭行だけ添える。
  assert.ok(message.endsWith('\n  Edge: edge missing\n  Chrome: chrome missing'), message);
  const multiline = formatCliError(new PdfBrowserUnavailableError('x',
    new Error("browserType.launch: Executable doesn't exist\n=== logs ===\nlong log"), ''));
  assert.ok(multiline.endsWith("\n  Edge: browserType.launch: Executable doesn't exist\n  Chrome: unknown error"), multiline);
  // 依存ライブラリ不足は先頭行が一般的な文言になるため、起動ログ内の共有ライブラリの失敗行を添える。
  const missingLibrary = formatCliError(new PdfBrowserUnavailableError('x', new Error('a'), new Error(
    'browserType.launch: Browser closed.\n<launching> /opt/chrome\n[pid=1][err] chrome: error while loading shared libraries: libnss3.so: cannot open shared object file')));
  assert.ok(missingLibrary.endsWith('Chrome: browserType.launch: Browser closed. — [pid=1][err] chrome: '
    + 'error while loading shared libraries: libnss3.so: cannot open shared object file'), missingLibrary);
  assert.equal(formatCliError(new Error('Output already exists: x')), 'Output already exists: x');
  assert.equal(formatCliError('plain failure'), 'plain failure');
});
