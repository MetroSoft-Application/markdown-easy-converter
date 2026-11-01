/**
 * @fileoverview 公開予定の tarball を npm の通常ライフサイクルで作成し、隔離したプロジェクトで実行する。
 * ソースツリーではなくインストール済みの CLI から HTML / PDF / Marp とファイルへの影響を確認する。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { findTestBrowser } from '../test/browser.mjs';

/** サブプロセスの出力と終了状態を待つ。 */
const execute = promisify(execFile);
/** `npm run test:package` が起動した npm 本体を使い、OS 固有の shim を避ける。 */
const npmCli = process.env.npm_execpath;
/** リポジトリの絶対パス。 */
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/**
 * 現行 0.1.0 の実測約 9.8 MB に余裕を持たせた圧縮サイズ上限。
 * woff / ttf の重複フォント (build.mjs の stripLegacyFontFormats) が再び混入すると約 18 MB になり、ここで検出する。
 */
const maxTarballBytes = 13 * 1024 * 1024;
/** 現行 0.1.0 の実測約 25 MB に余裕を持たせた展開サイズ上限。重複フォントが戻ると約 36 MB になる。 */
const maxUnpackedBytes = 32 * 1024 * 1024;

if (!npmCli) throw new Error('Run this script with npm run test:package.');

/**
 * npm の pack / install を実行する。失敗時は stdout / stderr をそのまま例外へ残す。
 * @param args - npm CLI の引数。
 * @param options - 作業ディレクトリと一時キャッシュの指定。
 * @returns stdout の文字列。
 */
async function runNpm(args, options) {
  const result = await execute(process.execPath, [npmCli, ...args], {
    cwd: options.cwd,
    env: { ...process.env, npm_config_cache: options.cache },
    timeout: 300_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout;
}

/**
 * インストール済み CLI を Node から起動する。引数に任意の入力文字列を連結しない。
 * @param cli - tarball から導入した CLI の実パス。
 * @param args - CLI 引数。
 * @returns stdout の文字列。
 */
async function runCli(cli, args) {
  const result = await execute(process.execPath, [cli, ...args], {
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}

/**
 * npm の --json 応答が単一 tarball のメタデータであることを検証する。
 * @param output - npm pack の JSON 応答。
 * @returns tarball のメタデータ。
 */
function parsePack(output) {
  // prepack が stdout にビルド完了行を出すため、最後の JSON 配列だけを読む。
  const start = output.lastIndexOf('\n[');
  const entries = JSON.parse(start < 0 ? output : output.slice(start + 1));
  assert.ok(Array.isArray(entries) && entries.length === 1, 'npm pack must return one package');
  return entries[0];
}

/**
 * 想定した配布ファイルとサイズを検査し、ソースやテストが漏れないことを確認する。
 * @param pack - npm pack が返すファイル一覧とサイズ。
 * @param metadata - リポジトリの package.json。
 */
function inspectPack(pack, metadata) {
  assert.equal(pack.name, metadata.name);
  assert.equal(pack.version, metadata.version);
  const files = new Set(pack.files.map((file) => file.path));
  for (const required of [
    'package.json', 'README.md', 'LICENSE.md', 'browsers.json',
    'dist/mve-convert.cjs', 'dist/print-assets.css', 'dist/pele-render-worker.js',
    'dist/markdown-fallback.js', 'dist/output-replacements.js',
    'dist/third-party-licenses/README.md',
  ]) assert.ok(files.has(required), `missing package file: ${required}`);
  assert.ok([...files].some((file) => file.includes('/playwright-core@') && /LICENSE/i.test(file)),
    'Playwright license text is missing');
  assert.ok(![...files].some((file) => file.includes('/chromium-bidi@')),
    'the unsupported BiDi backend entered the distributed bundle');
  for (const file of files) {
    assert.ok(!/^(?:test|scripts|src|examples)\//.test(file) && !/\.(?:ts|map)$/.test(file),
      `source or test file leaked into tarball: ${file}`);
  }
  assert.ok(pack.size <= maxTarballBytes,
    `compressed tarball ${pack.size} exceeds ${maxTarballBytes} bytes`);
  assert.ok(pack.unpackedSize <= maxUnpackedBytes,
    `unpacked package ${pack.unpackedSize} exceeds ${maxUnpackedBytes} bytes`);
}

/**
 * 生成した一時領域だけを削除する。計算したパスが OS の temp 直下であることを確認する。
 * @param directory - mkdtemp が返した一時ディレクトリ。
 */
async function removeTemporaryDirectory(directory) {
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(directory));
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative), 'refusing to remove a path outside the temp directory');
  await rm(directory, { recursive: true, force: true });
}

/**
 * 消費者側へインストールされた実ファイルの合計バイト数を測る。
 * @param directory - 配布パッケージのディレクトリ。
 * @returns シンボリックリンクをたどらないファイルサイズ合計。
 */
async function installedFileBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await installedFileBytes(file);
    else if (entry.isFile()) bytes += (await stat(file)).size;
  }
  return bytes;
}

/** tarball 生成、独立インストール、変換、後始末を順に実行する。 */
async function main() {
  const browser = findTestBrowser();
  assert.ok(browser && existsSync(browser), 'A Chromium/Edge/Chrome executable is required for package smoke tests');
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const temporary = await mkdtemp(path.join(tmpdir(), 'mve-package-smoke-'));
  const cache = path.join(temporary, 'npm-cache');
  try {
    const dryRun = parsePack(await runNpm(['pack', '--dry-run', '--json'], { cwd: root, cache }));
    inspectPack(dryRun, metadata);
    const packed = parsePack(await runNpm(['pack', '--json', '--pack-destination', temporary], { cwd: root, cache }));
    inspectPack(packed, metadata);
    assert.deepEqual(packed.files.map((file) => file.path), dryRun.files.map((file) => file.path),
      'dry-run and actual tarball have different file lists');

    const project = path.join(temporary, 'consumer');
    await mkdir(project);
    await writeFile(path.join(project, 'package.json'), '{"name":"mve-package-consumer","private":true}\n');
    const tarball = path.join(temporary, packed.filename);
    await runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: project, cache });
    const installed = path.join(project, 'node_modules', '@metrosoft', 'markdown-easy-converter');
    const installedMetadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
    assert.equal(installedMetadata.version, metadata.version);
    const shim = path.join(project, 'node_modules', '.bin',
      process.platform === 'win32' ? 'mve-convert.cmd' : 'mve-convert');
    assert.ok(existsSync(shim), 'npm did not install the mve-convert bin shim');
    assert.equal((await runNpm(['exec', '--offline', '--', 'mve-convert', '--version'],
      { cwd: project, cache })).trim(), metadata.version,
    'the installed mve-convert command did not start');
    assert.ok(!existsSync(path.join(project, 'node_modules', 'esbuild')),
      'a development dependency was installed in the consumer project');
    assert.ok(!existsSync(path.join(project, 'node_modules', 'playwright-core')),
      'playwright-core should be bundled rather than installed separately');
    // 配布 CSS が woff2 だけを埋め込み、出力 HTML の容量を倍増させる woff / ttf を含まないことを直接確かめる。
    const printAssets = await readFile(path.join(installed, 'dist', 'print-assets.css'), 'utf8');
    assert.ok(printAssets.includes('data:font/woff2;'), 'print-assets.css embeds no woff2 fonts');
    assert.ok(!/data:font\/(?:woff|ttf);/.test(printAssets), 'print-assets.css still embeds legacy woff/ttf fonts');
    const cli = path.join(installed, installedMetadata.bin['mve-convert']);
    assert.equal((await runCli(cli, ['--version'])).trim(), metadata.version);
    assert.match(await runCli(cli, ['--help']), /mve-convert INPUT\.md/);

    const source = path.join(project, 'document.md');
    const child = path.join(project, 'child.md');
    const image = path.join(project, 'image.svg');
    const original = '# Package smoke\n\n![Image](image.svg)\n\n[Child](child.md)\n';
    await writeFile(source, original);
    await writeFile(child, '# Linked page\n');
    await writeFile(image, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
    const output = path.join(project, 'generated', 'document.html');
    await runCli(cli, [source, '--format', 'html', '--output', output, '--browser', browser,
      '--html-linked', '--html-embed-images', '--html-outline']);
    const html = await readFile(output, 'utf8');
    assert.match(html, /Package smoke/);
    assert.match(html, /data:image\/svg\+xml;base64,/);
    assert.match(html, /mve-html-outline/);
    assert.match(html, /child\.html/);
    assert.match(await readFile(path.join(project, 'generated', 'child.html'), 'utf8'), /Linked page/);
    assert.equal(await readFile(source, 'utf8'), original, 'the input Markdown was modified');
    await assert.rejects(runCli(cli, [source, '--format', 'html', '--output', output, '--browser', browser]),
      (error) => /Output already exists/.test(error.stderr));
    await runCli(cli, [source, '--format', 'html', '--output', output, '--browser', browser, '--force']);

    const pdf = path.join(project, 'generated', 'document.pdf');
    await runCli(cli, [source, '--format', 'pdf', '--output', pdf, '--browser', browser]);
    assert.equal((await readFile(pdf)).toString('ascii', 0, 5), '%PDF-');
    // バンドルだけを別の場所へ移し、消費者側の node_modules が実行時に必要か調べる。
    const standalone = path.join(temporary, 'standalone-package');
    await cp(installed, standalone, { recursive: true });
    const standalonePdf = path.join(project, 'generated', 'standalone.pdf');
    await runCli(path.join(standalone, installedMetadata.bin['mve-convert']),
      [source, '--format', 'pdf', '--output', standalonePdf, '--browser', browser]);
    assert.equal((await readFile(standalonePdf)).toString('ascii', 0, 5), '%PDF-');
    const marp = path.join(project, 'slides.md');
    await writeFile(marp, '---\nmarp: true\n---\n\n# Slide\n');
    const marpPdf = path.join(project, 'generated', 'slides.pdf');
    await runCli(cli, [marp, '--format', 'pdf', '--output', marpPdf, '--browser', browser]);
    assert.equal((await readFile(marpPdf)).toString('ascii', 0, 5), '%PDF-');

    console.log(JSON.stringify({
      package: `${metadata.name}@${metadata.version}`,
      node: process.version,
      platform: process.platform,
      browser,
      files: packed.files.length,
      tarballBytes: packed.size,
      unpackedBytes: packed.unpackedSize,
      installedBytes: await installedFileBytes(installed),
      largestFiles: [...packed.files].sort((left, right) => right.size - left.size)
        .slice(0, 3).map((file) => ({ path: file.path, bytes: file.size })),
      runtimeDependencies: Object.keys(installedMetadata.dependencies ?? {}),
      installedCli: 'HTML, linked HTML, local image, PDF, Marp PDF, standalone PDF, version, bin shim',
    }, null, 2));
  } finally {
    await removeTemporaryDirectory(temporary);
  }
}

await main();
