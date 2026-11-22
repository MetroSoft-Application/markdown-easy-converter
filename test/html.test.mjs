/**
 * @fileoverview HTML 出力の描画を検証する。タイトル、front matter、無害化、Mermaid の失敗、BOM、リンク先の変換、出力の衝突、
 * 画像の埋め込み、ローカルファイルのアクセス制限、利用者の CSS、front matter の互換設定、リモート画像の停止、--strict / --json を対象にする。
 * 実行境界: Node（node:test）。CLI を子プロセスで実行し、描画にはテスト用ブラウザーを使う。
 * 時間を短くするため、変換は「確かめたい設定の組み合わせごとに1回」（全5回）にし、互いに干渉しない設定は同じ変換に重ねる。
 * 同じ設定で済む確認は複数の文書の一括変換（--out-dir）にまとめ、出力を1つずつ確かめる。
 */
import assert from 'node:assert/strict';
import { readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import { concurrency, needsBrowser, onePixelPng, run, withDirectory, writeFiles } from './helpers.mjs';

/** 出力 HTML の`<title>`の中身。 */
const titleOf = (html) => /<title>(.*?)<\/title>/.exec(html)?.[1];

/** シンボリックリンクを作る。作れない環境（Windows で権限がない）では false を返し、その確認を省く。 */
const trySymlink = (target, file) => symlink(target, file).then(() => true, (error) => { if (error.code !== 'EPERM') throw error; return false; });

describe('html', { concurrency }, () => {
  /**
   * 既定の設定で多数の文書を1回で一括変換し（--json --strict）、文書ごとの出力と警告を確かめる。
   * タイトル: front matter（HTML 特殊文字のエスケープ、CRLF、作者などを本文へ出さない）、最初の H1（Setext・C++・数式を保つ）、
   *   空のタイトルではファイル名、Textile。
   * front matter: YAML として読めない・対応付けでない・空・閉じていないブロックは本文に残し、2つ目のブロックは除去しない。
   * 無害化: script・on*・javascript: を残さない。Mermaid: 正常な図・構文エラー・長すぎるソースは、図ごとのエラー表示で続ける。
   * BOM 付きの先頭の見出し、Marp の設定の front matter の除去、警告（読めない画像・Mermaid の画像・画像数の上限）。
   * 既定では画像を埋め込まず、ルート外の相対参照も元のまま残し、存在確認のためにネットワークへ接続しない（Windows のネットワークパス）。
   * --strict は警告があれば終了コード1だが出力は書き、--json は入力ごとの警告を返す。
   */
  test('a batch of documents renders titles, front matter, sanitizing, diagrams, and warnings', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      const manyImages = Array.from({ length: 9 }, (_, index) => `  N${index}@{ img: "i${index}.png", h: 40, w: 40 }`).join('\n');
      const network = process.platform === 'win32' ? '\n\n<img src="file://127.0.0.1/C$/no/such/image.png">\n' : '\n';
      const docs = {
        'front.md': '---\r\ntitle: "A <b> & </title> B"\r\nauthor: AuthorMarker\r\n---\r\n\r\n# Heading\r\n',
        'heading.md': 'Intro\n\n## Second level\n\nC++ $x^2$ Guide\n===\n\n# Later\n',
        'none.md': '---\ntitle: ""\n---\n\nOnly a paragraph\n',
        'textile.textile': 'h1. Textile title\n',
        'plain-text.md': '---\nPlainTextMarker\n---\n\nBody\n',
        'list.md': '---\n- ListMarker\n---\n\nBody\n',
        'broken.md': '---\nkey: [BrokenMarker\n---\n\nBody\n',
        'empty-block.md': '---\n---\n\nEmptyMarker\n',
        'no-close.md': '---\nkey: NoCloseMarker\n',
        'second-block.md': '---\nfirst: 1\n---\n---\nSecondBlockMarker: 2\n---\n',
        'unsafe.md': '# Safe\n\n<script>window.injected = true</script>\n\n<img src="missing.png" onerror="alert(1)">\n\n<a href="javascript:alert(1)">link</a>\n',
        'mermaid.md': ['# Mermaid error marker', '', '```mermaid', 'graph TD', '  A[Start] --> B[Finish]', '```', '',
          '```mermaid', 'flowchart THIS_IS_NOT_VALID', '  broken -->', '```', '', '```mermaid', `graph TD\n  A["${'x'.repeat(50_001)}"]`, '```', '',
          'Text after the broken diagram', ''].join('\n'),
        'bom.md': '\uFEFF# BomHeadingMarker\r\n',
        'marp.md': '---\nmarp: true\ntheme: default\n---\n\n# Wide slide\n',
        'warnings.md': '![missing](missing.png)\n\n```mermaid\nflowchart TD\n  A@{ img: "nope.png", h: 40, w: 40 } --> B\n```\n',
        'limit.md': `\`\`\`mermaid\nflowchart TD\n${manyImages}\n\`\`\`\n`,
        'relative.md': `![out](../outside.png)${network}`,
      };
      await writeFiles(directory, { ...Object.fromEntries(Object.entries(docs).map(([name, content]) => [`docs/${name}`, content])), 'outside.png': onePixelPng });
      const result = await run(['docs/*', '--format', 'html', '--out-dir', 'out', '--json', '--strict'], { cwd: directory });
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /warning\(s\) treated as errors by --strict/);
      const report = JSON.parse(result.stdout);
      assert.equal(report.ok, false);
      const html = async (name) => readFile(path.join(directory, 'out', name.replace(/\.(?:md|textile)$/, '.html')), 'utf8');
      const warnings = (name) => report.results.find((record) => record.input === path.join(directory, 'docs', name)).warnings;
      assert.equal(report.results.length, Object.keys(docs).length);
      assert.ok(report.results.every((record) => record.outputs.length === 1 && record.error === undefined), 'every output is written');
      for (const [name, title] of [['front.md', 'A &lt;b&gt; &amp; &lt;/title&gt; B'], ['heading.md', 'C++ x2 Guide'], ['none.md', 'none'], ['textile.textile', 'Textile title']]) {
        assert.equal(titleOf(await html(name)), title, name);
      }
      assert.doesNotMatch(await html('front.md'), /AuthorMarker/);
      for (const [name, marker] of [['plain-text.md', 'PlainTextMarker'], ['list.md', 'ListMarker'], ['broken.md', 'BrokenMarker'],
        ['empty-block.md', 'EmptyMarker'], ['no-close.md', 'NoCloseMarker'], ['second-block.md', 'SecondBlockMarker']]) {
        assert.ok((await html(name)).includes(marker), marker);
      }
      const unsafe = await html('unsafe.md');
      assert.match(unsafe, /Safe/);
      assert.doesNotMatch(unsafe, /<script\b|\bonerror\s*=|javascript:/i);
      const mermaid = await html('mermaid.md');
      assert.match(mermaid, /<svg\b/);
      assert.match(mermaid, /<pre class="mermaid-error-message" role="alert">Mermaid syntax error\nMermaid diagram could not be rendered\.<\/pre>/);
      assert.match(mermaid, /<pre class="mermaid-error-message" role="alert">Mermaid syntax error\nMermaid source exceeds the 50000 character limit\.<\/pre>/);
      assert.match(mermaid, /Text after the broken diagram/);
      assert.deepEqual(warnings('mermaid.md'), [
        'Mermaid diagram 2 could not be rendered (Mermaid diagram could not be rendered.); an error message was embedded instead.',
        'Mermaid diagram 3 could not be rendered (Mermaid source exceeds the 50000 character limit.); an error message was embedded instead.']);
      assert.match(await html('bom.md'), /<h1\b[^>]*>(?:<a\b[^>]*>)?BomHeadingMarker</);
      const marp = await html('marp.md');
      assert.match(marp, /Wide slide/);
      assert.doesNotMatch(marp, /marp:\s*true/);
      assert.equal(warnings('warnings.md').length, 2);
      assert.ok(warnings('warnings.md').some((warning) => /"missing\.png" could not be read/.test(warning)));
      assert.ok(warnings('warnings.md').some((warning) => /Mermaid image "nope\.png" could not be loaded/.test(warning)));
      assert.ok(warnings('limit.md').some((warning) => /was skipped because a diagram can load at most 8 images/.test(warning)));
      assert.deepEqual(warnings('front.md'), []);
      assert.deepEqual(warnings('relative.md'), [], 'the default output does not read or connect to check references');
      assert.match(await html('relative.md'), /src="\.\.\/outside\.png"/);
    });
  });

  /**
   * 画像の埋め込みを、利用者の CSS・--front-matter render・ルート外のリンク先と重ねて1回で確かめる。
   * 画像: 中身で判定し、画像でないファイル（拡張子の偽装、画像の署名の一部で始まるテキスト、本文に<svgを含むだけの HTML、
   *   画像の名前のリンク）は埋め込まずに警告する。正規の SVG（XML 宣言・コメント・DOCTYPE・名前空間・長い先頭コメント・BOM）と
   *   ラスター画像（BMP・AVIF・ICO、大文字の拡張子・拡張子なし）は埋め込む。--restrict-local-files がなければルート外の画像も埋め込む。
   * CSS: 組み込みの CSS より後ろに指定順で入り、`</style>`で HTML の構造を壊さない。front matter: --front-matter render が設定ファイルより
   *   優先して本文に残す。リンク先: --html-linked はワークスペースの外の文書も変換して _linked/ へ書く。
   */
  test('image embedding, custom CSS, rendered front matter, and linked documents outside the root', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      const secret = 'TOP-SECRET-TEXT';
      const svgs = {
        'real.svg': '<?xml version="1.0"?><!-- c --><svg xmlns="http://www.w3.org/2000/svg"></svg>',
        'doctype.svg': '<!DOCTYPE svg [ <!ENTITY a "b>"> ]><svg xmlns="http://www.w3.org/2000/svg"/>',
        'doctype-space.svg': '<!DOCTYPE svg [ <!ENTITY a "]>"> ] ><svg xmlns="http://www.w3.org/2000/svg"/>',
        'doctype-comment.svg': '<!DOCTYPE svg [ <!-- don\'t --> ]><svg xmlns="http://www.w3.org/2000/svg"/>',
        'prefixed.svg': '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"></svg:svg>',
        'long-comment.svg': `<!-- ${'x'.repeat(70 * 1024)} --><svg xmlns="http://www.w3.org/2000/svg"></svg>`,
        'bom.svg': '\uFEFF<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      };
      const rasters = {
        'dib.bmp': Buffer.concat([Buffer.from('BM'), Buffer.alloc(12), Buffer.from([40, 0, 0, 0]), Buffer.alloc(40)]),
        'os2.bmp': Buffer.concat([Buffer.from('BM'), Buffer.alloc(12), Buffer.from([16, 0, 0, 0]), Buffer.alloc(16)]),
        'mif1.avif': Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmif1'), Buffer.alloc(16)]),
        'cursor.ico': Buffer.concat([Buffer.from([0, 0, 2, 0]), Buffer.alloc(30)]),
      };
      const rejected = {
        'secret.txt': secret, 'noextension': secret, 'fake.png': secret, 'fake.svg': secret, 'bm.txt': `BMW notes: ${secret} and some more text`,
        'gif.txt': `GIF8 ${secret}`, 'ftyp.avif': `abcdftyp ${secret} and some more text`, 'html.svg': `<html>${secret}<svg ></svg></html>`,
        'riff.txt': `RIFFxxxxWEBP ${secret}`,
      };
      await writeFiles(directory, {
        ...Object.fromEntries(Object.entries({ ...svgs, ...rasters, ...rejected }).map(([name, content]) => [`embed/${name}`, content])),
        'embed/real.png': onePixelPng, 'embed/upper.PNG': onePixelPng, 'embed/image-without-extension': onePixelPng,
        'outside.png': onePixelPng, 'outside.md': '# Outside workspace marker\n',
        'auto.json': JSON.stringify({ rendering: { frontMatter: 'auto' } }),
        'one.css': 'body{--one:1}</style><script>alert(1)</script>', 'two.css': 'body{--two:2}',
      });
      const linkable = await trySymlink(path.join(directory, 'embed', 'secret.txt'), path.join(directory, 'embed', 'link.png'));
      const references = ['real.png', 'upper.PNG', 'image-without-extension', '../outside.png', ...Object.keys(svgs), ...Object.keys(rasters), ...Object.keys(rejected),
        path.join(directory, 'embed', 'secret.txt').replace(/\\/g, '/'), ...(linkable ? ['link.png'] : [])];
      await writeFile(path.join(directory, 'embed', 'input.md'), `---\nauthor: CliMarker\n---\n\n${references.map((name, index) => `![i${index}](${name})`).join('\n\n')}`
        + '\n\n<img src="secret.txt">\n\n[Out](../outside.md)\n');
      const result = await run(['embed/input.md', '--format', 'html', '--html-embed-images', '--html-linked', '--config', 'auto.json',
        '--front-matter', 'render', '--css', 'one.css', '--css', 'two.css'], { cwd: directory });
      assert.equal(result.code, 0, result.stderr);
      const html = await readFile(path.join(directory, 'embed', 'input.html'), 'utf8');
      assert.ok(!html.includes(Buffer.from(secret).toString('base64')) && !html.includes(secret), 'a non-image file must not be embedded');
      assert.equal(html.split(onePixelPng.toString('base64')).length - 1, 4, 'real PNG images and the outside image stay embedded');
      for (const [name, content] of Object.entries({ ...svgs, ...rasters })) {
        assert.ok(html.includes(Buffer.from(content).toString('base64')), `${name} must stay embedded`);
        assert.ok(!result.stderr.includes(`"${name}"`), `${name} must not be reported`);
      }
      for (const name of [...Object.keys(rejected), ...(linkable ? ['link.png'] : [])]) assert.ok(result.stderr.includes(`"${name}" was not embedded`), `${name} must be rejected`);
      assert.match(html, /CliMarker/);
      assert.ok(html.indexOf('--one:1') > html.indexOf('.mve-html-outline-tree'), 'custom CSS must follow the built-in CSS');
      assert.ok(html.indexOf('--two:2') > html.indexOf('--one:1'));
      assert.doesNotMatch(html, /<\/style><script>/);
      const extra = await readdir(path.join(directory, 'embed', '_linked'));
      assert.equal(extra.length, 1);
      assert.match(await readFile(path.join(directory, 'embed', '_linked', extra[0]), 'utf8'), /Outside workspace marker/);
    });
  });

  /**
   * --restrict-local-files とリンク先の変換を、出力置換・BOM・大小文字を区別するファイル名と重ねて1回で確かめる。
   * 制限: ルート外の画像（相対・絶対パス・file: URI・ルート外を指すリンク）とリンク先文書を読まず、Windows ではネットワークパスへ接続せずに拒否する。
   * リンク先: front matter のタイトルと出力置換が主文書・リンク先の両方のタイトルに効き、front matter の中のリンクは追わない。
   *   BOM 付きのリンク先の見出し、大小文字だけが違うファイル名（区別する環境だけ）を別の文書として変換する。
   */
  test('--restrict-local-files with linked documents, replacements, and case-sensitive names', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      await writeFiles(directory, {
        'outside.png': onePixelPng, 'outside.md': '# OutsideDocumentMarker\n', 'workspace/inside.png': onePixelPng,
        'workspace/child.md': '---\ntitle: Child SecretWord\nauthor: ChildAuthorMarker\nlink: "[Hidden](hidden.md)"\n---\n\n# Child body\n',
        'workspace/hidden.md': '# Must not be followed\n', 'workspace/bom.md': '\uFEFF# BomLinkedMarker\r\n', 'workspace/A.md': '# UpperCaseMarker\n',
        'export.json': JSON.stringify({ pdf: { textReplacements: [{ pattern: 'SecretWord', replacement: 'XXX' }] } }),
      });
      const caseSensitive = await writeFile(path.join(directory, 'workspace', 'a.md'), '# LowerCaseMarker\n', { flag: 'wx' }).then(() => true,
        (error) => { if (error.code !== 'EEXIST') throw error; return false; });
      const outsidePath = path.join(directory, 'outside.png');
      const outsideRefs = ['../outside.png', outsidePath.replace(/\\/g, '/'), pathToFileURL(outsidePath).href,
        ...(await trySymlink(outsidePath, path.join(directory, 'workspace', 'link.png')) ? ['link.png'] : [])];
      const network = process.platform === 'win32' ? ['file://127.0.0.1/C$/no/such/image.png'] : [];
      await writeFile(path.join(directory, 'workspace', 'index.md'), ['---', 'title: Root SecretWord', '---', '', '![in](inside.png)', '',
        ...[...outsideRefs, ...network].flatMap((reference) => [`<img src="${reference}">`, '']),
        '[Child](child.md)', '', '[Bom](bom.md)', '', '[Upper](A.md)', '', ...(caseSensitive ? ['[Lower](a.md)', ''] : []), '[Out](../outside.md)', ''].join('\n'));
      const result = await run(['workspace/index.md', '--format', 'html', '--html-embed-images', '--restrict-local-files', '--html-linked',
        '--config', 'export.json'], { cwd: directory });
      assert.equal(result.code, 0, result.stderr);
      const read = (name) => readFile(path.join(directory, 'workspace', name), 'utf8');
      const index = await read('index.html');
      assert.equal(index.split(onePixelPng.toString('base64')).length - 1, 1, 'only the inside image is embedded');
      assert.match(result.stderr, /"\.\.\/outside\.png" was not embedded because it is outside the workspace root/);
      for (const reference of [...outsideRefs.slice(1), ...network]) assert.ok(result.stderr.includes(`"${reference}" was not embedded because it is outside the workspace root`), reference);
      assert.match(result.stderr, /was not converted because it is outside the workspace root/);
      await assert.rejects(readdir(path.join(directory, 'workspace', '_linked')), { code: 'ENOENT' });
      assert.equal(titleOf(index), 'Root XXX');
      const child = await read('child.html');
      assert.equal(titleOf(child), 'Child XXX');
      assert.doesNotMatch(child, /ChildAuthorMarker/);
      await assert.rejects(readFile(path.join(directory, 'workspace', 'hidden.html')), { code: 'ENOENT' });
      assert.match(await read('bom.html'), /<h1\b[^>]*>(?:<a\b[^>]*>)?BomLinkedMarker</);
      assert.match(await read('A.html'), /UpperCaseMarker/);
      if (caseSensitive) {
        assert.match(index, /href="a\.html"/);
        assert.match(await read('a.html'), /LowerCaseMarker/);
      }
    });
  });

  /**
   * front matter を本文に残す互換設定（frontMatter: render）・設定ファイルの CSS（設定ファイルからの相対パス）・リモート画像の停止
   * （remoteImagesEnabled: false）を1回の一括変換で確かめ、リンク先との出力の衝突を1回の変換で確かめる。
   * 互換設定でもタイトルは front matter から取り、Marp の設定は本文に出さない。衝突（主文書とリンク先、拡張子だけ異なるリンク先）は、
   * --force でも全書き込み前に拒否する。
   */
  test('compatibility settings and linked output collisions', needsBrowser, async () => {
    await withDirectory(async (directory) => {
      await writeFiles(directory, {
        'compat/kept.md': '---\ntitle: KeptTitle\nauthor: KeptMarker\n---\n\nBody\n\n![remote](http://127.0.0.1:9/remote.png)\n',
        'compat/marp.md': '---\nmarp: true\n---\n\nBody\n',
        'config/render.json': JSON.stringify({ rendering: { frontMatter: 'render', css: 'two.css', remoteImagesEnabled: false } }),
        'config/two.css': 'body{--two:2}',
        'collide/index.md': '[Child](child.md)\n\n[Markdown](page.md)\n\n[Textile](page.textile)\n', 'collide/child.md': '# Child marker\n',
        'collide/page.md': '# Markdown marker\n', 'collide/page.textile': 'h1. Textile marker\n',
      });
      const [compat, collision] = await Promise.all([
        run(['compat/*.md', '--format', 'html', '--out-dir', 'compat-out', '--config', 'config/render.json'], { cwd: directory }),
        run(['collide/index.md', '--format', 'html', '--output', 'collide/child.html', '--html-linked', '--force'], { cwd: directory }),
      ]);
      assert.equal(compat.code, 0, compat.stderr);
      const kept = await readFile(path.join(directory, 'compat-out', 'kept.html'), 'utf8');
      assert.match(kept, /KeptMarker/);
      assert.equal(titleOf(kept), 'KeptTitle');
      assert.match(kept, /--two:2/);
      assert.doesNotMatch(kept, /<img\b[^>]*127\.0\.0\.1:9/, 'remote images are hidden');
      assert.doesNotMatch(await readFile(path.join(directory, 'compat-out', 'marp.html'), 'utf8'), /marp:\s*true/);
      assert.equal(collision.code, 1, collision.stderr);
      assert.match(collision.stderr, /Output paths must be distinct/);
      assert.deepEqual((await readdir(path.join(directory, 'collide'))).filter((name) => name.endsWith('.html')), []);
    });
  });
});
