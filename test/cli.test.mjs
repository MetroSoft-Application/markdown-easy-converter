/**
 * @fileoverview CLI の引数・出力衝突と、ブラウザーを使う HTML / PDF / Marp 描画を検証する。
 * ブラウザー必須の公開ゲートでは描画テストのスキップを許さない。
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/**
 * BOM付きで保存された設定JSONが「Invalid JSON」とならず、設定内容の検証まで進むことを検証する。
 * 意図的に不正なPDF設定を置き、ブラウザーなしで解析成否だけを判定する。
 */
test('a UTF-8 BOM in the configuration file is accepted', async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.pdf');
    const config = path.join(directory, 'export.json');
    await writeFile(input, '# Source\n');
    await writeFile(config, '\uFEFF' + JSON.stringify({ pdf: { format: 'Letter' } }));
    await assert.rejects(execute(process.execPath,
      [cli, input, '--format', 'pdf', '--output', output, '--config', config]),
    (error) => error.code === 2 && /Invalid pdf/.test(error.stderr) && !/Invalid JSON/.test(error.stderr));
    await assert.rejects(readFile(output), { code: 'ENOENT' });
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

/**
 * UTF-8 BOM付きの入力とリンク先文書でも、先頭行の見出しが文字列のまま残らず見出しとして描画されることを検証する。
 * fs.readFileはBOMを残すため、除去漏れがあると先頭の `# ` がMarkdown構文として認識されない。
 */
test('a UTF-8 BOM does not prevent the first heading from rendering', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'bom.md');
    const linked = path.join(directory, 'linked.md');
    const output = path.join(directory, 'bom.html');
    await writeFile(input, '\uFEFF# BomHeadingMarker\r\n\r\n[Linked](linked.md)\r\n');
    await writeFile(linked, '\uFEFF# BomLinkedMarker\r\n');
    await execute(process.execPath, [cli, input, '--format', 'html', '--output', output,
      '--html-linked', '--browser', browserPath]);
    const html = await readFile(output, 'utf8');
    // 見出しは本文を見出しアンカーで包むため、<a>の有無に依存せず<h1>内の本文を確認する。
    assert.match(html, /<h1\b[^>]*>(?:<a\b[^>]*>)?BomHeadingMarker</);
    assert.doesNotMatch(html, /<p>\s*\uFEFF?#\s*BomHeadingMarker/);
    const linkedHtml = await readFile(path.join(directory, 'linked.html'), 'utf8');
    assert.match(linkedHtml, /<h1\b[^>]*>(?:<a\b[^>]*>)?BomLinkedMarker</);
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

/**
 * PDFの文書情報から文書タイトルを読み取る。PDF内のしおりも`/Title`を持つため、全候補を返す。
 * Chromiumは非ASCIIのタイトルをUTF-16BEの16進文字列で書くので、復号して比較できるようにする。
 * @param pdf - 生成されたPDFのバイト列。
 * @returns PDF内のすべての`/Title`の値。
 */
function readPdfTitles(pdf) {
  return [...pdf.toString('latin1').matchAll(/\/Title\s*(?:\(([^)]*)\)|<([0-9A-Fa-f]+)>)/g)].map((match) => {
    if (match[1] !== undefined) return match[1];
    const bytes = Buffer.from(Buffer.from(match[2], 'hex').subarray(2));
    return bytes.swap16().toString('utf16le');
  });
}

/**
 * PDFの圧縮ストリームをすべて展開する。ヘッダーの文字やCSSの効果は圧縮とフォントの字形番号で直接検索できないため、
 * 同じ描画結果になる別の設定のPDFと比較したり、描画命令を調べたりするために使う。
 * @param pdf - 生成されたPDFのバイト列。
 * @returns 展開できたストリームの文字列（latin1）の配列。
 */
function inflatePdfStreams(pdf) {
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
 * 標準入力へ文字列を渡してCLIを実行する。
 * @param args - CLIの引数。
 * @param input - 標準入力へ渡す文字列。
 * @param options - 作業ディレクトリなどの実行オプション。
 * @returns 終了コードとバイナリの標準出力、文字列の標準エラー。
 */
function runWithStdin(args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], options);
    const stdout = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr }));
    child.stdin.end(input);
  });
}

/**
 * タイトルが--title、front matter、最初のH1、ファイル名の順で決まり、記号やHTML特殊文字を損なわないことを検証する。
 * 回帰リスク: `<title>`の欠落、`C++`の記号除去、未エスケープのタイトルによるHTML構造の破壊。
 */
test('HTML titles prefer --title, front matter, the first H1, then the file name', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    for (const [name, markdown, expected, extra = []] of [
      ['option.md', '---\ntitle: Front\n---\n\n# Heading\n', 'From option', ['--title', 'From option']],
      ['front.md', '---\ntitle: "A <b> & </title> B"\n---\n\n# Heading\n', 'A &lt;b&gt; &amp; &lt;/title&gt; B'],
      ['heading.md', 'Intro\n\n## Second level\n\n# C++ Guide\n\n# Later\n', 'C++ Guide'],
      ['setext.md', 'Setext title\n===\n', 'Setext title'],
      ['none.md', 'Only a paragraph\n', 'none'],
      ['empty-title.md', '---\ntitle: ""\n---\n\nOnly a paragraph\n', 'empty-title'],
      ['textile.textile', 'h1. Textile title\n', 'Textile title'],
      // KaTeXのMathMLとHTMLの両方が連結されると `x2x^2x2 math` のようになる。
      ['math.md', '# $x^2$ math\n', 'x2 math'],
    ]) {
      const input = path.join(directory, name);
      const output = path.join(directory, `${name}.html`);
      await writeFile(input, markdown);
      await execute(process.execPath, [cli, input, '--format', 'html', '--output', output, '--browser', browserPath, ...extra]);
      assert.equal(/<title>(.*?)<\/title>/.exec(await readFile(output, 'utf8'))?.[1], expected, name);
    }
  });
});

/**
 * PDFの文書タイトルが`about:blank`にならず、非ASCIIのタイトルも保持されることを検証する。
 * 回帰リスク: PDFビューアーのタイトル欄に`about:blank`が表示されること。
 */
test('PDF document titles use the resolved title', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    for (const [title, heading] of [['Plain title', 'Heading'], ['日本語タイトル', '見出し']]) {
      const input = path.join(directory, 'input.md');
      const output = path.join(directory, 'output.pdf');
      await writeFile(input, `---\ntitle: ${title}\n---\n\n# ${heading}\n`);
      await execute(process.execPath, [cli, input, '--format', 'pdf', '--output', output, '--force', '--browser', browserPath]);
      const titles = readPdfTitles(await readFile(output));
      assert.ok(titles.includes(title), `missing ${title}: ${titles.join(', ')}`);
      assert.ok(!titles.includes('about:blank'), titles.join(', '));
    }
  });
});

/**
 * YAMLのオブジェクトであるfront matterだけを本文、アウトライン、リンク追跡から除くことを検証する。
 * 回帰リスク: 先頭に水平線を置いた通常の文書の本文が失われること、CRLFの文書で除去に失敗すること。
 * `rendering.frontMatter: "render"`は0.1.2以前の表示へ戻す互換用の設定である。
 */
test('YAML front matter is removed but thematic breaks are preserved', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.html');
    const render = async (markdown, ...options) => {
      await writeFile(input, markdown);
      await execute(process.execPath, [cli, input, '--format', 'html', '--output', output, '--force',
        '--browser', browserPath, ...options]);
      return readFile(output, 'utf8');
    };

    const crlf = await render('---\r\ntitle: CrlfTitle\r\nauthor: AuthorMarker\r\n---\r\n\r\n# Body\r\n');
    assert.doesNotMatch(crlf, /AuthorMarker/);
    assert.match(crlf, /<title>CrlfTitle<\/title>/);

    // YAMLのコメント行は`#`で始まるため、除去しないとアウトラインにH1として現れる。
    const outline = await render('---\n# CommentMarker\nkey: value\n---\n\n# Body\n', '--html-outline');
    assert.doesNotMatch(outline, /CommentMarker/);

    // 水平線に挟まれた文章は、YAMLの文字列・エラー・空のいずれでも本文として残す。
    for (const [markdown, marker] of [
      ['---\nPlainTextMarker\n---\n\nBody\n', 'PlainTextMarker'],
      ['---\n- ListMarker\n---\n\nBody\n', 'ListMarker'],
      ['---\nkey: [BrokenMarker\n---\n\nBody\n', 'BrokenMarker'],
      ['---\n---\n\nEmptyMarker\n', 'EmptyMarker'],
      ['---\nkey: NoCloseMarker\n', 'NoCloseMarker'],
    ]) {
      assert.ok((await render(markdown)).includes(marker), marker);
    }
    // 本文側に続く2つ目のブロックを、二重に除去しない。
    assert.match(await render('---\nfirst: 1\n---\n---\nSecondBlockMarker: 2\n---\n'), /SecondBlockMarker/);

    // 互換設定では従来どおり本文として残し、タイトルだけ利用する。Marp設定は従来も除去していた。
    const config = path.join(directory, 'compat.json');
    await writeFile(config, JSON.stringify({ rendering: { frontMatter: 'render' } }));
    const kept = await render('---\ntitle: KeptTitle\nauthor: KeptMarker\n---\n\nBody\n', '--config', config);
    assert.match(kept, /KeptMarker/);
    assert.match(kept, /<title>KeptTitle<\/title>/);
    assert.doesNotMatch(await render('---\nmarp: true\n---\n\nBody\n', '--config', config), /marp:\s*true/);
    await writeFile(config, JSON.stringify({ rendering: { frontMatter: 'unknown' } }));
    await assert.rejects(render('Body\n', '--config', config), (error) => error.code === 2 && /Invalid frontMatter/.test(error.stderr));
    // コマンドラインでも同じ互換動作を選べ、設定ファイルより優先する。
    await writeFile(config, JSON.stringify({ rendering: { frontMatter: 'auto' } }));
    assert.match(await render('---\nauthor: CliMarker\n---\n\nBody\n', '--config', config, '--front-matter', 'render'), /CliMarker/);
    await assert.rejects(render('Body\n', '--front-matter', 'unknown'), (error) => error.code === 2 && /Invalid front matter mode/.test(error.stderr));
  });
});

/** PDFとリンク先文書でも、front matterを本文へ出さずに各文書のタイトルを使うことを検証する。 */
test('front matter is handled in PDF and linked documents', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'index.md');
    const child = path.join(directory, 'child.md');
    const hidden = path.join(directory, 'hidden.md');
    const output = path.join(directory, 'index.html');
    const pdfOutput = path.join(directory, 'index.pdf');
    await writeFile(input, '---\ntitle: Root title\nauthor: PdfAuthorMarker\n---\n\n[Child](child.md)\n');
    await writeFile(child, '---\ntitle: Child title\nauthor: ChildAuthorMarker\nlink: "[Hidden](hidden.md)"\n---\n\n# Child body\n');
    await writeFile(hidden, '# Must not be followed\n');
    await execute(process.execPath, [cli, input, '--format', 'html', '--output', output, '--html-linked', '--browser', browserPath]);
    assert.match(await readFile(output, 'utf8'), /<title>Root title<\/title>/);
    const childHtml = await readFile(path.join(directory, 'child.html'), 'utf8');
    assert.match(childHtml, /<title>Child title<\/title>/);
    assert.doesNotMatch(childHtml, /ChildAuthorMarker/);
    await assert.rejects(readFile(path.join(directory, 'hidden.html')), { code: 'ENOENT' });

    await execute(process.execPath, [cli, input, '--format', 'pdf', '--output', pdfOutput, '--browser', browserPath]);
    assert.ok(!readPdfTitles(await readFile(pdfOutput)).some((title) => /PdfAuthorMarker/.test(title)));
  });
});

/**
 * 出力置換で隠した文字列が、タイトルやPDFの文書情報から漏れないことを検証する。
 * 回帰リスク: 本文だけ置換され、タブ名やPDFのプロパティに原文が残ること。
 */
test('text replacements also apply to the document title', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const child = path.join(directory, 'child.md');
    const config = path.join(directory, 'export.json');
    const output = path.join(directory, 'output.html');
    const pdfOutput = path.join(directory, 'output.pdf');
    await writeFile(input, '---\ntitle: Project SecretWord\n---\n\n[Child](child.md)\n');
    await writeFile(child, '# Child SecretWord\n');
    await writeFile(config, JSON.stringify({ pdf: { textReplacements: [{ pattern: 'SecretWord', replacement: 'XXX' }] } }));
    await execute(process.execPath, [cli, input, '--format', 'html', '--output', output, '--config', config,
      '--html-linked', '--browser', browserPath]);
    assert.match(await readFile(output, 'utf8'), /<title>Project XXX<\/title>/);
    assert.match(await readFile(path.join(directory, 'child.html'), 'utf8'), /<title>Child XXX<\/title>/);
    await execute(process.execPath, [cli, input, '--format', 'pdf', '--output', pdfOutput, '--config', config, '--browser', browserPath]);
    const titles = readPdfTitles(await readFile(pdfOutput));
    assert.ok(titles.includes('Project XXX'), titles.join(', '));
    assert.ok(!titles.some((title) => /SecretWord/.test(title)), titles.join(', '));
  });
});

/** 1x1のPNG。画像の埋め込みの検証に使う。 */
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

/**
 * 画像参照を経由して、画像以外のローカルファイルが出力へ混入しないことを検証する。
 * 回帰リスク: `![x](secret.txt)` だけで秘密情報がBase64として配布物へ埋め込まれること、
 * 実際の画像（大文字の拡張子や拡張子なしを含む）の埋め込みまで止めて互換性を壊すこと。
 */
test('only image files are embedded from local references', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const secret = 'TOP-SECRET-TEXT';
    const encodedSecret = Buffer.from(secret).toString('base64');
    await writeFile(path.join(directory, 'secret.txt'), secret);
    await writeFile(path.join(directory, 'noextension'), secret);
    await writeFile(path.join(directory, 'real.png'), onePixelPng);
    await writeFile(path.join(directory, 'upper.PNG'), onePixelPng);
    await writeFile(path.join(directory, 'image-without-extension'), onePixelPng);
    // 拡張子を偽ったテキストも混入させない。本物のSVGとXML宣言付きのSVGは従来どおり埋め込む。
    await writeFile(path.join(directory, 'fake.png'), secret);
    await writeFile(path.join(directory, 'fake.svg'), secret);
    // 画像の署名の一部で始まるテキストや、本文に<svgを含むだけのファイルも画像として扱わない。
    await writeFile(path.join(directory, 'bm.txt'), `BMW notes: ${secret} and some more text`);
    await writeFile(path.join(directory, 'gif.txt'), `GIF8 ${secret}`);
    await writeFile(path.join(directory, 'ftyp.avif'), `abcdftyp ${secret} and some more text`);
    await writeFile(path.join(directory, 'html.svg'), `<html>${secret}<svg ></svg></html>`);
    await writeFile(path.join(directory, 'riff.txt'), `RIFFxxxxWEBP ${secret}`);
    // 正規のSVGは、XML宣言、コメント、DOCTYPE、名前空間プレフィックス、長い先頭コメント、BOMがあっても埋め込む。
    const svgs = {
      'real.svg': '<?xml version="1.0"?><!-- c --><svg xmlns="http://www.w3.org/2000/svg"></svg>',
      'doctype.svg': '<!DOCTYPE svg [ <!ENTITY a "b>"> ]><svg xmlns="http://www.w3.org/2000/svg"/>',
      'doctype-space.svg': '<!DOCTYPE svg [ <!ENTITY a "]>"> ] ><svg xmlns="http://www.w3.org/2000/svg"/>',
      'doctype-comment.svg': '<!DOCTYPE svg [ <!-- don\'t --> ]><svg xmlns="http://www.w3.org/2000/svg"/>',
      'prefixed.svg': '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"></svg:svg>',
      'long-comment.svg': `<!-- ${'x'.repeat(70 * 1024)} --><svg xmlns="http://www.w3.org/2000/svg"></svg>`,
      'bom.svg': '\uFEFF<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    };
    for (const [name, content] of Object.entries(svgs)) await writeFile(path.join(directory, name), content);
    // 正規のラスター画像の署名の代表。内容は最小限で、形式判定だけを検証する。
    const rasters = {
      'dib.bmp': Buffer.concat([Buffer.from('BM'), Buffer.alloc(12), Buffer.from([40, 0, 0, 0]), Buffer.alloc(40)]),
      // OS/2 2.xのBMPは16などの可変長ヘッダーを持ち、Chromiumが表示できる。
      'os2.bmp': Buffer.concat([Buffer.from('BM'), Buffer.alloc(12), Buffer.from([16, 0, 0, 0]), Buffer.alloc(16)]),
      'mif1.avif': Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmif1'), Buffer.alloc(16)]),
      'cursor.ico': Buffer.concat([Buffer.from([0, 0, 2, 0]), Buffer.alloc(30)]),
    };
    for (const [name, content] of Object.entries(rasters)) await writeFile(path.join(directory, name), content);
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.html');
    await writeFile(input, [
      '![a](secret.txt)', '', '<img src="secret.txt">', '', '![b](noextension)', '',
      `![c](${path.join(directory, 'secret.txt').replace(/\\/g, '/')})`, '', '![d](real.png)', '',
      '![e](upper.PNG)', '', '![f](image-without-extension)', '', '![g](fake.png)', '', '![h](fake.svg)', '',
      '![j](bm.txt)', '', '![k](gif.txt)', '', '![m](ftyp.avif)', '', '![n](html.svg)', '', '![o](riff.txt)', '',
      ...[...Object.keys(svgs), ...Object.keys(rasters)].flatMap((name) => [`![ok](${name})`, '']),
    ].join('\n'));

    const { stderr } = await execute(process.execPath, [cli, input, '--format', 'html', '--output', output,
      '--html-embed-images', '--browser', browserPath]);
    const html = await readFile(output, 'utf8');
    assert.ok(!html.includes(encodedSecret), 'a non-image file must not be embedded');
    assert.ok(!html.includes(secret));
    assert.equal(html.split(onePixelPng.toString('base64')).length - 1, 3, 'all real images must stay embedded');
    for (const [name, content] of [...Object.entries(svgs), ...Object.entries(rasters)]) {
      assert.ok(html.includes(Buffer.from(content).toString('base64')), `${name} must stay embedded`);
      assert.ok(!stderr.includes(`"${name}"`), `${name} must not be reported`);
    }
    for (const name of ['secret.txt', 'noextension', 'fake.png', 'fake.svg', 'bm.txt', 'gif.txt', 'ftyp.avif', 'html.svg', 'riff.txt']) {
      assert.ok(stderr.includes(`"${name}" was not embedded`), `${name} must be rejected`);
    }

    // 画像の名前でファイルを指すリンクも、リンク先の内容で判定する。作成権限がない環境では検証を省略する。
    try {
      await symlink(path.join(directory, 'secret.txt'), path.join(directory, 'link.png'));
      await writeFile(input, '![l](link.png)\n');
      const linked = await execute(process.execPath, [cli, input, '--format', 'html', '--output', output, '--force',
        '--html-embed-images', '--browser', browserPath]);
      assert.ok(!(await readFile(output, 'utf8')).includes(encodedSecret));
      assert.match(linked.stderr, /"link\.png" was not embedded/);
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
    }
    await writeFile(input, '![a](secret.txt)\n\n![d](real.png)\n');

    const pdfOutput = path.join(directory, 'output.pdf');
    const pdf = await execute(process.execPath, [cli, input, '--format', 'pdf', '--output', pdfOutput, '--browser', browserPath]);
    assert.match(pdf.stderr, /"secret\.txt" was not embedded/);
    assert.equal((await readFile(pdfOutput)).toString('ascii', 0, 5), '%PDF-');
  });
});

/**
 * `--restrict-local-files`がルート外の画像とリンク先文書を読まないこと、既定では従来どおり読めることを検証する。
 * 回帰リスク: 既定の動作を変えて相対パスの画像が読めなくなること、シンボリックを含む判定漏れで外部を読むこと。
 */
test('--restrict-local-files blocks files outside the workspace root only when requested', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    await writeFile(path.join(directory, 'outside.png'), onePixelPng);
    await writeFile(path.join(directory, 'outside.md'), '# OutsideDocumentMarker\n');
    await writeFile(path.join(workspace, 'inside.png'), onePixelPng);
    const input = path.join(workspace, 'index.md');
    const output = path.join(workspace, 'index.html');
    const encoded = onePixelPng.toString('base64');
    await writeFile(input, '![in](inside.png)\n\n![out](../outside.png)\n');

    await execute(process.execPath, [cli, input, '--format', 'html', '--output', output, '--html-embed-images', '--browser', browserPath]);
    assert.equal((await readFile(output, 'utf8')).split(encoded).length - 1, 2, 'the default must not restrict paths');

    const { stderr } = await execute(process.execPath, [cli, input, '--format', 'html', '--output', output, '--force',
      '--html-embed-images', '--restrict-local-files', '--browser', browserPath]);
    assert.equal((await readFile(output, 'utf8')).split(encoded).length - 1, 1, 'only the inside image is embedded');
    assert.match(stderr, /"\.\.\/outside\.png" was not embedded because it is outside the workspace root/);

    // 絶対パス、file: URI、ルート外を指すシンボリックリンクでも抜けられない。
    const outsidePath = path.join(directory, 'outside.png');
    const references = [outsidePath.replace(/\\/g, '/'), pathToFileURL(outsidePath).href];
    try {
      await symlink(outsidePath, path.join(workspace, 'link.png'));
      references.push('link.png');
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
    }
    for (const reference of references) {
      await writeFile(input, `<img src="${reference}">\n`);
      const blocked = await execute(process.execPath, [cli, input, '--format', 'html', '--output', output, '--force',
        '--html-embed-images', '--restrict-local-files', '--browser', browserPath]);
      assert.ok(!(await readFile(output, 'utf8')).includes(encoded), reference);
      assert.match(blocked.stderr, /outside the workspace root/, reference);
    }

    // ネットワークパスは接続せずに拒否する（Windowsのみ）。存在しないパスを指定することで、
    // 接続を試みる実装ではファイルシステムのエラーになり、警告の文言が変わるようにしている。
    if (process.platform === 'win32') {
      await writeFile(input, '<img src="file://127.0.0.1/C$/no/such/image.png">\n');
      const network = await execute(process.execPath, [cli, input, '--format', 'html', '--output', output, '--force',
        '--html-embed-images', '--restrict-local-files', '--browser', browserPath]);
      assert.match(network.stderr, /outside the workspace root/);
      // 既定の相対参照の出力では、存在確認のためにネットワークへ接続しない。
      const quiet = await execute(process.execPath, [cli, input, '--format', 'html', '--output', output, '--force', '--browser', browserPath]);
      assert.doesNotMatch(quiet.stderr, /could not be read/);

      // ネットワークパスを指すローカルのリンクも、接続せずに拒否する。接続すると存在しない先へのエラーで文言が変わる。
      try {
        await symlink('//127.0.0.1/C$/no/such/image.png', path.join(workspace, 'network-link.png'));
        await writeFile(input, '![n](network-link.png)\n');
        const viaLink = await execute(process.execPath, [cli, input, '--format', 'html', '--output', output, '--force',
          '--html-embed-images', '--restrict-local-files', '--browser', browserPath]);
        assert.match(viaLink.stderr, /"network-link\.png" was not embedded because it is outside the workspace root/);
        const quietLink = await execute(process.execPath, [cli, input, '--format', 'html', '--output', output, '--force', '--browser', browserPath]);
        assert.doesNotMatch(quietLink.stderr, /could not be read/);
      } catch (error) {
        if (error.code !== 'EPERM') throw error;
      }
    }

    await writeFile(input, '[Out](../outside.md)\n');
    const linked = await execute(process.execPath, [cli, input, '--format', 'html', '--output', output, '--force',
      '--html-linked', '--restrict-local-files', '--browser', browserPath]);
    assert.match(linked.stderr, /was not converted because it is outside the workspace root/);
    await assert.rejects(readdir(path.join(workspace, '_linked')), { code: 'ENOENT' });
  });
});

/**
 * `--strict`は出力を残したまま終了コード1で失敗し、`--json`は機械可読の結果を返すことを検証する。
 * 回帰リスク: 既定の終了コード0が変わること、欠落した画像やMermaidの失敗をCIが検出できないこと。
 */
test('--strict and --json report warnings without changing the default exit code', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.html');
    await writeFile(input, '![missing](missing.png)\n\n```mermaid\nflowchart THIS_IS_NOT_VALID\n  broken -->\n```\n');
    const base = [cli, input, '--output', output, '--force', '--browser', browserPath];

    const normal = await execute(process.execPath, base);
    assert.equal(normal.stdout.trim(), output, 'the default stdout stays a list of paths');
    assert.match(normal.stderr, /"missing\.png" could not be read/);

    await rm(output);
    await assert.rejects(execute(process.execPath, [...base, '--strict']),
      (error) => error.code === 1 && /2 warning\(s\) treated as errors by --strict/.test(error.stderr));
    assert.match(await readFile(output, 'utf8'), /<html/);

    await assert.rejects(execute(process.execPath, [...base, '--strict', '--json']), (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(error.code, 1);
      assert.equal(result.ok, false);
      assert.deepEqual(result.results[0].outputs, [output]);
      assert.equal(result.results[0].warnings.length, 2);
      return true;
    });
    const json = JSON.parse((await execute(process.execPath, [...base, '--json'])).stdout);
    assert.equal(json.ok, true);

    await assert.rejects(execute(process.execPath, [cli, input, '--json']), (error) => {
      assert.equal(error.code, 2);
      assert.match(JSON.parse(error.stdout).error, /--format/);
      return true;
    });

    // 入力の処理を始めた後の失敗は、全体ではなく入力ごとのerrorとして報告する。
    await assert.rejects(execute(process.execPath, [cli, path.join(directory, 'missing.md'), '--format', 'html', '--json']), (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(error.code, 1);
      assert.equal(result.error, undefined);
      assert.match(result.results[0].error, /ENOENT/);
      return true;
    });

    // Mermaid内の読めない画像も警告になり、--strictで検出できる。
    await writeFile(input, '```mermaid\nflowchart TD\n  A@{ img: "nope.png", h: 40, w: 40 } --> B\n```\n');
    await assert.rejects(execute(process.execPath, [...base, '--strict']),
      (error) => error.code === 1 && /Mermaid image "nope\.png" could not be loaded/.test(error.stderr));

    // 件数上限を超えた画像は、読めない画像と区別できる文言で報告する。
    const manyImages = Array.from({ length: 9 }, (_, index) => `  N${index}@{ img: "i${index}.png", h: 40, w: 40 }`).join('\n');
    await writeFile(input, `\`\`\`mermaid\nflowchart TD\n${manyImages}\n\`\`\`\n`);
    const limited = await execute(process.execPath, base);
    assert.match(limited.stderr, /was skipped because a diagram can load at most 8 images/);
  });
});

/**
 * 中断時も資源を解放して終了コード130を返し、--jsonの結果を出力することを検証する。
 * Windowsではシグナルを外部から送れないため、読み込み前のスクリプトからプロセス内へ発火させる。
 * 描画の速さに依存しないよう、問題の状況を次のとおり直接作る。
 * - 図の描画タイマー（180秒）が作られた時点はブラウザーの起動後なので、そこで中断する。合図が来なくなれば変換が完了し、
 *   終了コードの検証で失敗する。
 * - 実際の図の描画タイマーと同じく残り続けるタイマーを用意し、明示的に終了しない実装では終了が遅れるようにする。
 * - 中断の時点で他のSIGINT処理（Playwrightの既定の処理）が登録されていれば、結果を失う競合があるものとして報告する。
 * 回帰リスク: Playwrightの既定のSIGINT処理が先にプロセスを終了して結果が失われること、
 * 残ったタイマーのためにプロセスの終了が数分遅れること。
 */
test('an interrupt during rendering exits quickly with 130 and reports the JSON result', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const preload = path.join(directory, 'interrupt.cjs');
    await writeFile(input, '# Interrupted\n\n```mermaid\ngraph TD\n  A --> B\n```\n');
    await writeFile(preload, [
      'const original = globalThis.setTimeout;',
      'let fired = false;',
      'globalThis.setTimeout = function (callback, delay, ...rest) {',
      '  if (delay === 180000 && !fired) {',
      '    fired = true;',
      '    original(() => {',
      "      if (process.listenerCount('SIGINT') !== 1) process.stderr.write('foreign SIGINT handler\\n');",
      "      process.emit('SIGINT');",
      '    }, 0);',
      '  }',
      '  return original(callback, delay, ...rest);',
      '};',
      '// 中断後もイベントループに残るタイマー。',
      'original(() => undefined, 170000);',
      ''
    ].join('\n'));
    const started = performance.now();
    await assert.rejects(execute(process.execPath, ['--require', preload, cli, input, '--format', 'html', '--json', '--browser', browserPath], { timeout: 120_000 }),
      (error) => {
        assert.equal(error.code, 130, error.stderr);
        assert.doesNotMatch(error.stderr, /foreign SIGINT handler/);
        const result = JSON.parse(error.stdout);
        assert.equal(result.ok, false);
        assert.equal(result.results[0].input, input);
        assert.equal(result.results[0].error, 'Conversion was interrupted.');
        assert.match(error.stderr, /^Conversion was interrupted\.\r?\n$/m);
        return true;
      });
    assert.ok(performance.now() - started < 60_000, 'the process must not wait for the diagram timer');
    await assert.rejects(readFile(path.join(directory, 'input.html')), { code: 'ENOENT' });
  });
});

/**
 * 変換が応答しなくなっても、中断から猶予時間で必ず終了し、結果を出力することを検証する。
 * 実機ではブラウザーの起動中にCtrl+Cが届くとPlaywrightの処理が完了しないことがあった。
 * 再現性を持たせるため、入力の確認が永久に完了しない状態を読み込み前のスクリプトで作る。
 * 回帰リスク: 中断したのにプロセスが止まり続けること。
 */
test('an interrupt exits even when the conversion never completes', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const preload = path.join(directory, 'hang.cjs');
    await writeFile(input, '# Hang\n');
    await writeFile(preload, [
      "const fs = require('node:fs');",
      'const stat = fs.promises.stat;',
      'fs.promises.stat = function (file, ...rest) {',
      "  if (String(file).endsWith('input.md')) {",
      "    setTimeout(() => process.emit('SIGINT'), 50);",
      '    return new Promise(() => undefined);',
      '  }',
      '  return stat.call(this, file, ...rest);',
      '};',
      ''
    ].join('\n'));
    const started = performance.now();
    await assert.rejects(execute(process.execPath, ['--require', preload, cli, input, '--format', 'html', '--json'], { timeout: 60_000 }),
      (error) => {
        assert.equal(error.code, 130, error.stderr);
        const result = JSON.parse(error.stdout);
        assert.equal(result.ok, false);
        assert.equal(result.results[0].error, 'Conversion was interrupted.');
        return true;
      });
    assert.ok(performance.now() - started < 30_000, 'the process must exit after the grace period');
  });
});

/**
 * タイムアウトの指定を検証し、無効な値は変換前に拒否すること、指定した値が実際に効くことを確認する。
 * 回帰リスク: 値を受け付けるだけで使われないこと、0に丸められて「タイムアウトなし」になること。
 */
test('timeout options are validated and take effect', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.pdf');
    const config = path.join(directory, 'export.json');
    await writeFile(input, '# Timeout\n');
    for (const option of ['--browser-timeout', '--render-timeout']) {
      for (const value of ['0', '0.0001', 'abc', '3601']) {
        await assert.rejects(execute(process.execPath, [cli, input, '--format', 'pdf', option, value]),
          (error) => error.code === 2 && /Invalid .* timeout/.test(error.stderr), `${option} ${value}`);
      }
    }
    await writeFile(config, JSON.stringify({ rendering: { renderTimeout: 'abc' } }));
    await assert.rejects(execute(process.execPath, [cli, input, '--format', 'pdf', '--config', config]),
      (error) => error.code === 2 && /Invalid renderTimeout/.test(error.stderr));

    await assert.rejects(execute(process.execPath, [cli, input, '--output', output, '--browser', browserPath, '--render-timeout', '0.001']),
      (error) => error.code === 1 && /PDF .*timed out/.test(error.stderr));
    await assert.rejects(execute(process.execPath, [cli, input, '--output', output, '--browser', browserPath, '--browser-timeout', '0.001']),
      (error) => error.code === 1 && /[Tt]imeout/.test(error.stderr));
    await assert.rejects(readFile(output), { code: 'ENOENT' });

    await execute(process.execPath, [cli, input, '--output', output, '--browser', browserPath,
      '--browser-timeout', '30', '--render-timeout', '120']);
    assert.equal((await readFile(output)).toString('ascii', 0, 5), '%PDF-');
  });
});

/**
 * `-o`の拡張子から形式を判定し、判定できないときは従来のエラーを保つことを検証する。
 * 回帰リスク: `--format`の指定漏れを誤った形式で黙って処理すること。
 */
test('--format can be inferred from the output extension only', async () => {
  const { parseArguments } = require(cli);
  assert.equal(parseArguments(['a.md', '-o', 'a.PDF']).format, 'pdf');
  assert.equal(parseArguments(['a.md', '-o', 'a.htm']).format, 'html');
  assert.equal(parseArguments(['a.md', '-o', 'a.pdf', '--format', 'html']).format, 'html');
  assert.throws(() => parseArguments(['a.md']), /--format html\|pdf is required/);
  assert.throws(() => parseArguments(['a.md', '-o', 'a.txt']), /--format html\|pdf is required/);
});

/**
 * 複数入力、ワイルドカード、--out-dirが相対位置を保って変換し、1件の失敗で残りを止めないことを検証する。
 * 回帰リスク: ワイルドカード文字を含む実在ファイルや隠しディレクトリの扱いが変わること、出力の衝突で上書きが起きること。
 */
test('multiple inputs and wildcard patterns convert every document', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const docs = path.join(directory, 'docs');
    await mkdir(path.join(docs, 'sub'), { recursive: true });
    await mkdir(path.join(docs, 'node_modules'), { recursive: true });
    await mkdir(path.join(docs, '.hidden'), { recursive: true });
    await writeFile(path.join(docs, 'a.md'), '# A marker\n');
    await writeFile(path.join(docs, 'sub', 'b.markdown'), '# B marker\n');
    await writeFile(path.join(docs, 'sub', 'c.textile'), 'h1. C marker\n');
    await writeFile(path.join(docs, 'sub', 'image.png'), onePixelPng);
    await writeFile(path.join(docs, 'node_modules', 'skip.md'), '# Skip\n');
    await writeFile(path.join(docs, '.hidden', 'skip.md'), '# Skip\n');
    const out = path.join(directory, 'out');
    const pattern = `${docs.replace(/\\/g, '/')}/**/*`;
    const options = { cwd: directory };

    const result = await execute(process.execPath, [cli, pattern, '--format', 'html', '--out-dir', out, '--browser', browserPath], options);
    const expected = [path.join(out, 'a.html'), path.join(out, 'sub', 'b.html'), path.join(out, 'sub', 'c.html')];
    assert.deepEqual(result.stdout.trim().split(/\r?\n/).sort(), expected.sort());
    assert.match(await readFile(path.join(out, 'sub', 'c.html'), 'utf8'), /C marker/);
    await assert.rejects(readFile(path.join(out, 'node_modules', 'skip.html')), { code: 'ENOENT' });

    // `*`でも依存パッケージへ入らず、明示すれば入る。
    const star = path.join(directory, 'star-out');
    const starResult = await execute(process.execPath, [cli, `${docs.replace(/\\/g, '/')}/*/*.md`, '--format', 'html', '--out-dir', star, '--browser', browserPath], options)
      .catch((error) => error);
    assert.equal(starResult.code, 1, 'no ordinary directory contains a .md file here');
    assert.match(starResult.stderr, /No documents matched/);
    await execute(process.execPath, [cli, `${docs.replace(/\\/g, '/')}/node_modules/*.md`, '--format', 'html', '--out-dir', star, '--browser', browserPath], options);
    assert.match(await readFile(path.join(star, 'skip.html'), 'utf8'), /Skip/);

    // 一致したファイルが1つの下位ディレクトリに偏っても、出力の階層は指定から決まる。
    const stable = path.join(directory, 'stable');
    await execute(process.execPath, [cli, `${docs.replace(/\\/g, '/')}/**/b*`, '--format', 'html', '--out-dir', stable, '--browser', browserPath], options);
    assert.match(await readFile(path.join(stable, 'sub', 'b.html'), 'utf8'), /B marker/);

    // パス一覧の読み手が先に閉じても、未処理例外で一括変換を止めず全件を出力する。
    const closedOut = path.join(directory, 'closed-out');
    const closedRun = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, pattern, '--format', 'html', '--out-dir', closedOut, '--browser', browserPath], options);
      let stderr = '';
      child.stdout.once('data', () => child.stdout.destroy());
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr }));
    });
    assert.doesNotMatch(closedRun.stderr, /Unhandled|node:events/);
    assert.equal(closedRun.code, 0, closedRun.stderr);
    assert.match(await readFile(path.join(closedOut, 'sub', 'c.html'), 'utf8'), /C marker/);

    // 既存の出力で1件失敗しても残りを変換し、終了コード1で失敗を報告する。
    const failing = path.join(directory, 'failing');
    await mkdir(failing);
    await writeFile(path.join(failing, 'a.html'), 'sentinel');
    await assert.rejects(execute(process.execPath, [cli, path.join(docs, 'a.md'), path.join(docs, 'sub', 'b.markdown'),
      '--format', 'html', '--out-dir', failing, '--browser', browserPath], options), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Output already exists/);
      return true;
    });
    assert.equal(await readFile(path.join(failing, 'a.html'), 'utf8'), 'sentinel');
    assert.match(await readFile(path.join(failing, 'sub', 'b.html'), 'utf8'), /B marker/);

    // 別の入力が同じ出力になる場合は、1件も書かずに拒否する。
    const conflict = path.join(directory, 'conflict');
    await mkdir(conflict);
    await writeFile(path.join(conflict, 'same.md'), '# One\n');
    await writeFile(path.join(conflict, 'same.textile'), 'h1. Two\n');
    await assert.rejects(execute(process.execPath, [cli, `${conflict.replace(/\\/g, '/')}/*`, '--format', 'html', '--browser', browserPath], options),
      (error) => error.code === 1 && /Output paths must be distinct/.test(error.stderr));
    assert.deepEqual((await readdir(conflict)).sort(), ['same.md', 'same.textile']);

    // ワイルドカード文字を含む実在ファイル名は、パターンとして解釈しない（POSIXのみ作成可能）。
    if (process.platform !== 'win32') {
      await writeFile(path.join(directory, 'star*.md'), '# Literal star marker\n');
      await writeFile(path.join(directory, 'starother.md'), '# Other\n');
      await execute(process.execPath, [cli, 'star*.md', '--format', 'html', '--output', 'literal.html', '--browser', browserPath], options);
      assert.match(await readFile(path.join(directory, 'literal.html'), 'utf8'), /Literal star marker/);
    }

    // 組み合わせられない指定は変換前に終了コード2で拒否する。
    await assert.rejects(execute(process.execPath, [cli, `${docs.replace(/\\/g, '/')}/**/*`, '--format', 'html', '--output', 'x.html'], options),
      (error) => error.code === 2 && /use --out-dir/.test(error.stderr));
    await assert.rejects(execute(process.execPath, [cli, `${docs.replace(/\\/g, '/')}/**/*`, '--format', 'html', '--html-linked'], options),
      (error) => error.code === 2 && /single input/.test(error.stderr));
    await assert.rejects(execute(process.execPath, [cli, 'nothing/*.md', '--format', 'html'], options),
      (error) => error.code === 1 && /No documents matched/.test(error.stderr));
  });
});

/**
 * 標準入力と標準出力で本文を変換でき、stdoutには生成物だけが流れることを検証する。
 * 回帰リスク: 出力パスの一覧が生成物へ混ざること、相対画像の基準が--base-dirにならないこと。
 */
test('standard input and output carry only the document', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    await writeFile(path.join(directory, 'real.png'), onePixelPng);
    const html = await runWithStdin(['-', '--format', 'html', '--html-embed-images', '--base-dir', directory, '--browser', browserPath],
      '\uFEFF---\ntitle: Piped\n---\n\n# Stdin marker\n\n![x](real.png)\n');
    assert.equal(html.code, 0, html.stderr);
    const text = html.stdout.toString('utf8');
    assert.ok(text.startsWith('<!doctype html>'), text.slice(0, 40));
    assert.match(text, /<title>Piped<\/title>/);
    assert.match(text, /Stdin marker/);
    assert.ok(text.includes(onePixelPng.toString('base64')));

    const pdf = await runWithStdin(['-', '--format', 'pdf', '--browser', browserPath], '# Pdf marker\n', { cwd: directory });
    assert.equal(pdf.code, 0, pdf.stderr);
    assert.equal(pdf.stdout.toString('ascii', 0, 5), '%PDF-');

    const input = path.join(directory, 'file.md');
    await writeFile(input, '# File marker\n');
    // HTMLは埋め込みフォントを含むため、execFileの既定のmaxBufferでは足りない。
    const fromFile = await execute(process.execPath, [cli, input, '--format', 'html', '-o', '-', '--browser', browserPath],
      { maxBuffer: 256 * 1024 * 1024 });
    assert.ok(fromFile.stdout.startsWith('<!doctype html>'));
    assert.deepEqual((await readdir(directory)).sort(), ['file.md', 'real.png']);

    // 読み手が先に閉じても、未処理例外のスタックトレースではなく終了コード1で終える。
    const closed = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, input, '--format', 'html', '-o', '-', '--browser', browserPath]);
      let stderr = '';
      child.stdout.once('data', () => child.stdout.destroy());
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr }));
    });
    assert.doesNotMatch(closed.stderr, /Unhandled|node:events/);
    assert.equal(closed.code, 1, closed.stderr);

    const written = await runWithStdin(['-', '--output', path.join(directory, 'piped.html'), '--browser', browserPath], '# To file\n');
    assert.equal(written.stdout.toString('utf8').trim(), path.join(directory, 'piped.html'));

    for (const invalid of [['-', 'file.md', '--format', 'html'], [input, '--format', 'html', '--base-dir', directory],
      ['-', '--format', 'html', '--json'], ['-', '--format', 'html', '--html-linked']]) {
      const rejected = await runWithStdin(invalid, '');
      assert.equal(rejected.code, 2, invalid.join(' '));
    }
  });
});

/**
 * 利用者のCSSが組み込みのCSSより後ろに入り、上書きできることを検証する。
 * 回帰リスク: `</style>`によるHTML構造の破壊、設定ファイルの相対パスの解決、CSSなしの既定出力の変更。
 */
test('--css is appended after the built-in styles', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.html');
    const pdfOutput = path.join(directory, 'output.pdf');
    await writeFile(input, '# Body\n');
    await writeFile(path.join(directory, 'one.css'), 'body{--one:1}</style><script>alert(1)</script>');
    await writeFile(path.join(directory, 'two.css'), 'body{--two:2}');
    await execute(process.execPath, [cli, input, '--output', output, '--css', path.join(directory, 'one.css'),
      '--css', path.join(directory, 'two.css'), '--browser', browserPath]);
    const html = await readFile(output, 'utf8');
    assert.ok(html.indexOf('--one:1') > html.indexOf('.mve-html-outline-tree'), 'custom CSS must follow the built-in CSS');
    assert.ok(html.indexOf('--two:2') > html.indexOf('--one:1'));
    assert.doesNotMatch(html, /<\/style><script>/);

    const config = path.join(directory, 'export.json');
    await writeFile(config, JSON.stringify({ rendering: { css: 'two.css' } }));
    await execute(process.execPath, [cli, input, '--output', output, '--force', '--config', config, '--browser', browserPath]);
    assert.match(await readFile(output, 'utf8'), /--two:2/);
    // PDFでも組み込みの見出し色を上書きできる。純粋な赤の描画命令で確認する。
    await writeFile(path.join(directory, 'red.css'), '.mve-print h1 { color: #ff0000; }');
    await execute(process.execPath, [cli, input, '--output', pdfOutput, '--browser', browserPath]);
    const redFill = /(?:^|\s)1 0 0 rg\b/;
    assert.ok(!inflatePdfStreams(await readFile(pdfOutput)).some((stream) => redFill.test(stream)));
    await execute(process.execPath, [cli, input, '--output', pdfOutput, '--force', '--css', path.join(directory, 'red.css'), '--browser', browserPath]);
    assert.ok(inflatePdfStreams(await readFile(pdfOutput)).some((stream) => redFill.test(stream)), 'custom CSS must change the PDF');

    await assert.rejects(execute(process.execPath, [cli, input, '--output', path.join(directory, 'none.html'),
      '--css', path.join(directory, 'missing.css')]), (error) => error.code === 1 && /missing\.css/.test(error.stderr));
    await assert.rejects(readFile(path.join(directory, 'none.html')), { code: 'ENOENT' });
  });
});

/**
 * ヘッダー・フッターの新しい設定が既定では従来の表示を変えず、値を指定した場合だけ反映されることを検証する。
 * PDFの文字列は圧縮されて検証できないため、テンプレートの生成結果を比較する。
 */
test('header and footer options keep the previous layout by default', async () => {
  const { headerFooterTemplate } = require(cli);
  const defaults = { headerFooterFontSize: 6, headerFooterPadding: 15 };
  assert.equal(headerFooterTemplate('', 'left', defaults), '<span></span>');
  assert.equal(headerFooterTemplate('<b> {page}/{pages}', 'center', defaults),
    '<div style="font-size:6pt;width:100%;padding:0 15mm;text-align:center;color:#666">&lt;b&gt; <span class="pageNumber"></span>/<span class="totalPages"></span></div>');
  assert.match(headerFooterTemplate('x', 'right', { headerFooterFontSize: 10, headerFooterPadding: 0 }),
    /font-size:10pt;width:100%;padding:0 0mm;text-align:right/);
  // 展開した値（タイトルなど）の`{page}`は、ページ番号にせず文字のまま出力する。
  const literal = headerFooterTemplate('\uE000page} {page}', 'left', defaults);
  assert.ok(literal.includes('{page} <span class="pageNumber"></span>'), literal);
});

/**
 * ヘッダー・フッターの置換用文字列と新しい設定値が、PDF出力まで通ることを検証する。
 * 回帰リスク: 新しい設定キーを未知のキーとして拒否すること、無効な値を黙って受け付けること。
 */
test('header and footer settings are accepted and validated', { skip: !browserPath }, async () => {
  await withDirectory(async (directory) => {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.pdf');
    const config = path.join(directory, 'export.json');
    await writeFile(input, '# Body\n');
    await writeFile(config, JSON.stringify({ pdf: { header: '{title} {file} {date}', headerAlign: 'right', footerAlign: 'left',
      headerFooterFontSize: 9, headerFooterPadding: 5 } }));
    await execute(process.execPath, [cli, input, '--output', output, '--config', config, '--browser', browserPath]);
    const expanded = inflatePdfStreams(await readFile(output));
    // 文字は字形番号で出力され検索できないため、展開後と同じ文字列を直接書いたPDFと描画命令を比較する。
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const literalStreams = async (header) => {
      await writeFile(config, JSON.stringify({ pdf: { header, headerAlign: 'right', footerAlign: 'left',
        headerFooterFontSize: 9, headerFooterPadding: 5 } }));
      await execute(process.execPath, [cli, input, '--output', output, '--force', '--config', config, '--browser', browserPath]);
      return inflatePdfStreams(await readFile(output));
    };
    assert.deepEqual(expanded, await literalStreams(`Body input.md ${date}`), 'placeholders must expand to the title, file, and date');
    assert.notDeepEqual(expanded, await literalStreams(`Other input.md ${date}`), 'the comparison must detect a different header');
    await writeFile(config, JSON.stringify({ pdf: { headerAlign: 'middle' } }));
    await assert.rejects(execute(process.execPath, [cli, input, '--output', output, '--force', '--config', config]),
      (error) => error.code === 2 && /Invalid pdf\.headerAlign/.test(error.stderr));
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
