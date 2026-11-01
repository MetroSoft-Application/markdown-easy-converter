/**
 * @fileoverview src/ の変換ソースから、配布する Node.js CLI と描画資産を dist/ へビルドする。
 * CLI 本体、埋め込みフォント付き CSS、Markdown レンダラー、Mermaid ワーカー、置換ワーカーを生成し、
 * 同梱した依存のライセンス原文を dist/third-party-licenses/ へ複製する。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** 作業ディレクトリに左右されないリポジトリのルート。 */
const root = path.dirname(fileURLToPath(import.meta.url));
/** 変換ソースと描画資産の配置。 */
const srcdir = path.join(root, 'src');
/** HTML/PDF変換時に参照する実行ファイルと描画資産の配置。 */
const outdir = path.join(root, 'dist');
/** 依存パッケージをこのリポジトリの node_modules から解決する。 */
const requireFromCli = createRequire(import.meta.url);
/** 配布物へ実際に取り込まれた依存パッケージのメタデータを収集する。 */
const buildResults = [];
/** CLI が使わない Playwright の BiDi 経路。通常の Chromium/CDP 描画だけを配布する。 */
const optionalBidiModules = [
  'chromium-bidi/lib/cjs/bidiMapper/BidiMapper',
  'chromium-bidi/lib/cjs/cdp/CdpConnection',
];
await mkdir(outdir, { recursive: true });
await copyFile(path.join(path.dirname(requireFromCli.resolve('playwright-core')), 'browsers.json'),
  path.join(root, 'browsers.json'));
buildResults.push(await esbuild.build({
  entryPoints: [path.join(srcdir, 'main.ts')],
  outfile: path.join(outdir, 'mve-convert.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  metafile: true,
  banner: { js: '#!/usr/bin/env node' },
  external: optionalBidiModules,
  logLevel: 'info'
}));
buildResults.push(await esbuild.build({
  entryPoints: [path.join(srcdir, 'styles', 'print-assets.css')],
  outfile: path.join(outdir, 'print-assets.css'),
  bundle: true,
  minify: true,
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  metafile: true,
  logLevel: 'info'
}));
await stripLegacyFontFormats(path.join(outdir, 'print-assets.css'));
buildResults.push(await esbuild.build({
  entryPoints: [path.join(srcdir, 'runtime', 'peleWorker.ts')],
  outfile: path.join(outdir, 'pele-render-worker.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['chrome120'],
  minify: true,
  sourcemap: false,
  metafile: true,
  logLevel: 'info'
}));
buildResults.push(await esbuild.build({
  entryPoints: [path.join(srcdir, 'renderer', 'markdown', 'markdownRenderer.ts')],
  outfile: path.join(outdir, 'markdown-fallback.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['chrome120'],
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  globalName: 'mveMarkdownFallback',
  metafile: true,
  logLevel: 'info'
}));
/** 置換ルールは別のブラウザーWorkerで実行し、病的な正規表現を2秒で中断する。 */
buildResults.push(await esbuild.build({
  entryPoints: [path.join(srcdir, 'outputReplacements.ts')],
  outfile: path.join(outdir, 'output-replacements.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['chrome120'],
  minify: true,
  globalName: 'mveOutputReplacements',
  metafile: true,
  logLevel: 'info'
}));
await chmod(path.join(outdir, 'mve-convert.cjs'), 0o755);
await writeThirdPartyLicenses(buildResults.flatMap((result) => Object.keys(result.metafile.inputs)));
console.log('CLI built: dist/mve-convert.cjs');

/**
 * 埋め込みフォントの src から woff / ttf の代替形式を除き、woff2 だけを残す。
 * @fontsource と KaTeX の CSS は同じフォントを woff2・woff・ttf で重ねて宣言するが、描画に使う Chromium と
 * 現行の主要ブラウザーは先頭の woff2 だけを読み込むため、残りは配布物と出力 HTML の容量を倍増させるだけになる。
 * 依存パッケージの CSS 表記が変わって除去が効かない、または壊れる場合に黙って配布しないよう、結果を検証して失敗させる。
 * @param cssPath - esbuild が出力した、フォントを data URL で埋め込んだ CSS。上書きする。
 * @throws woff / ttf が残る、woff2 を持たない @font-face がある、または @font-face 数が変わった場合。
 */
async function stripLegacyFontFormats(cssPath) {
  /** CSS 内の @font-face 規則を列挙する。data URL は波括弧を含まないため、最初の } で規則が終わる。 */
  const fontFaces = (css) => css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  const source = await readFile(cssPath, 'utf8');
  const stripped = source.replace(
    /,\s*url\(\s*["']?data:font\/(?:woff|ttf);base64,[A-Za-z0-9+/=]+["']?\s*\)\s*format\(\s*["']?(?:woff|truetype)["']?\s*\)/g, '');
  const before = fontFaces(source);
  const after = fontFaces(stripped);
  if (before.length === 0 || after.length !== before.length) {
    throw new Error(`Unexpected @font-face count after stripping legacy formats: ${before.length} -> ${after.length}`);
  }
  // data URL 以外の参照で代替形式が残った場合も、format() 宣言から検出する。
  if (/data:font\/(?:woff|ttf);/.test(stripped) || /format\(\s*["']?(?:woff|truetype)["']?\s*\)/.test(stripped)) {
    throw new Error('Legacy woff/ttf font data remains in print-assets.css; the upstream font CSS format may have changed.');
  }
  const withoutWoff2 = after.filter((face) => !face.includes('data:font/woff2;'));
  if (withoutWoff2.length > 0) {
    throw new Error(`${withoutWoff2.length} @font-face rules have no embedded woff2 source.`);
  }
  await writeFile(cssPath, stripped, 'utf8');
  console.log(`print-assets.css: kept woff2 only (${(source.length / 1048576).toFixed(1)} MB -> ${(stripped.length / 1048576).toFixed(1)} MB)`);
}

/**
 * 各 esbuild 出力に含まれる依存のライセンス原文を、同じ配布物内へ複製する。
 * metafileの相対パスはesbuildの既定absWorkingDirであるprocess.cwd()基準のため、別ディレクトリから
 * importされた場合(VS Code拡張のビルドなど)も同じ基準で解決する。依存を1件も検出できない場合は
 * 一覧が空のまま成功しないよう失敗させる。
 * @param inputPaths - すべてのビルド成果物のmetafileに列挙された入力。
 */
async function writeThirdPartyLicenses(inputPaths) {
  const packages = new Map();
  for (const inputPath of inputPaths) {
    const absolutePath = path.resolve(process.cwd(), inputPath);
    const installedPackage = await findInstalledPackage(absolutePath);
    if (installedPackage) packages.set(`${installedPackage.name}@${installedPackage.version}`, installedPackage);
  }
  if (packages.size === 0) throw new Error('No bundled dependency packages were found for the license notices.');

  const licenseRoot = path.join(outdir, 'third-party-licenses');
  await rm(licenseRoot, { recursive: true, force: true });
  await mkdir(licenseRoot, { recursive: true });
  const notices = ['# Third-party license notices', '',
    'License texts of the dependency packages bundled into this CLI.', ''];
  const missing = [];

  for (const installedPackage of [...packages.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    const licenseFiles = await findPackageLicenseFiles(installedPackage.root);
    if (licenseFiles.length === 0) {
      missing.push(`${installedPackage.name}@${installedPackage.version}`);
      continue;
    }

    const packageDirectory = `${installedPackage.name.replaceAll('/', '__')}@${installedPackage.version}`;
    const destinationRoot = path.join(licenseRoot, packageDirectory);
    await mkdir(destinationRoot, { recursive: true });
    const copiedFiles = [];
    for (const sourcePath of licenseFiles) {
      const relativePath = path.relative(installedPackage.root, sourcePath);
      const destinationPath = path.join(destinationRoot, relativePath);
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
      copiedFiles.push(path.posix.join(packageDirectory, relativePath.split(path.sep).join('/')));
    }
    notices.push(`- **${installedPackage.name}@${installedPackage.version}** — ${installedPackage.license || 'see the included license files'}: ${copiedFiles.map((file) => `\`${file}\``).join(', ')}`);
  }

  if (missing.length > 0) {
    throw new Error(`Bundled dependencies have no license text: ${missing.join(', ')}`);
  }
  await writeFile(path.join(licenseRoot, 'README.md'), `${notices.join('\n')}\n`, 'utf8');
}

/**
 * 入力ファイルを所有するnode_modulesパッケージを、親ディレクトリから特定する。
 * @param inputPath - esbuild metafileの入力を絶対パスへ解決した値。
 * @returns 見つかった依存パッケージ。プロジェクト自身やNode組み込み入力ではundefined。
 */
async function findInstalledPackage(inputPath) {
  const nodeModulesRoot = path.join(root, 'node_modules') + path.sep;
  let directory = path.dirname(inputPath);
  while (directory.startsWith(nodeModulesRoot)) {
    try {
      const packageJson = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (typeof packageJson.name === 'string' && typeof packageJson.version === 'string') {
        return { name: packageJson.name, version: packageJson.version, license: packageJson.license, root: directory };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    directory = path.dirname(directory);
  }
  return undefined;
}

/**
 * 依存パッケージ直下、licenses階層、lib内のバンドルコード表記から法的表示を探す。
 * @param packageRoot - package.jsonがある依存パッケージのルート。
 * @returns 配布物へ複製する法的表示ファイルの絶対パス一覧。
 */
async function findPackageLicenseFiles(packageRoot) {
  const matches = [];
  const pending = [{ directory: packageRoot, tree: 'package', depth: 0 }];
  while (pending.length > 0) {
    const { directory, tree, depth } = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && (
        /^(license|licence|copying|notice|ofl)([._-].*)?$/i.test(entry.name)
        || /^thirdparty(?:notices?|licenses?)([._-].*)?$/i.test(entry.name)
        || /\.licenses?(?:[._-].*)?$/i.test(entry.name)
      )) {
        matches.push(entryPath);
      } else if (entry.isDirectory()) {
        if (tree === 'package' && /^licenses?$/i.test(entry.name)) {
          pending.push({ directory: entryPath, tree: 'licenses', depth: 1 });
        } else if (tree === 'package' && /^lib$/i.test(entry.name)) {
          pending.push({ directory: entryPath, tree: 'bundled-code', depth: 1 });
        } else if (tree === 'licenses' && depth < 5) {
          pending.push({ directory: entryPath, tree, depth: depth + 1 });
        } else if (tree === 'bundled-code' && depth < 3) {
          pending.push({ directory: entryPath, tree, depth: depth + 1 });
        }
      }
    }
  }
  return matches.sort((left, right) => left.localeCompare(right));
}
