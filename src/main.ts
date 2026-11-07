/**
 * @fileoverview MarkdownからHTML/PDFを出力するCLIのエントリポイント。
 * 引数と設定ファイルを検証し、HTML (src/html.ts) / PDF (src/pdf.ts) の出力処理を呼び出して、ブラウザー資源を解放する。
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { BrowserContext, Page } from 'playwright-core';
import { ensureHtmlExtension, prepareHtmlExport, stripUtf8Bom, writePreparedHtml } from './html';
import { acquirePdfBrowser, closePdfBrowser, PdfBrowserUnavailableError, renderPdf, template } from './pdf';
import { closePeleRenderer, MermaidDiagramError, renderPeleMermaid } from './runtime/peleMermaid';
import { MAX_IMAGE_COUNT, MAX_MERMAID_IMAGE_BYTES, resolveMermaidImageSources } from './runtime/mermaidImages';
import { namespaceMermaidSvg } from './shared/mermaidSvg';
import { decodeLocalResourceSource } from './shared/resourceCheck';
import { DEFAULT_HTML_EXPORT_OPTIONS, DEFAULT_PDF_OPTIONS, PDF_PAPER_FORMATS, isTextReplacementPatternValid, normalizeHtmlExportSettings, normalizePdfOptions, type HtmlExportOptions, type PdfOptions } from './shared/protocol';
import { DEFAULT_FONT_FAMILY_STACK } from './shared/fontFamily';
import { hasMarpFrontMatterCandidate, isMarpMarkdown } from './shared/marpFrontMatter';
import { chooseDocumentTitle, expandHeaderFooterPlaceholders, extractDocumentMetadata, formatLocalDate, normalizeTitle, resolveRenderFormat, type FrontMatterMode } from './documentMetadata';
import { commonDirectory, expandInputPatterns, outputPathInDirectory } from './inputPatterns';
import { isPathInsideRoot, type LocalImagePolicy } from './localFiles';
import { renderMarpMarkdown } from './renderer/marp/marpRenderer';
import { createMarpPdfExportContent } from './renderer/marp/marpPdfExport';
import { prepareExportHtml } from './shared/exportHtml';
import { printContentCss } from './shared/printContentCss';
import { getMessages, SUPPORTED_LANGUAGES, type SupportedLanguage } from './shared/messages';

/**
 * バンドルを直接読み込むテストが自動検出の失敗を組み立てられるよう再公開する。
 * package.json に main / exports はなく、公開 API として互換性を保証しない。
 */
export { PdfBrowserUnavailableError };
/** PDF本文の圧縮によりヘッダーの文字列を生成物から検証できないため、テスト用にテンプレート生成を再公開する。 */
export { template as headerFooterTemplate };

/** ファイル入力型CLIが受け付ける出力形式。 */
export type OutputFormat = 'html' | 'pdf';
/** HTML/PDF出力で使用できる見出しテーマ。 */
type Theme = 'dark' | 'light';
/** 変換処理が受け取る正規化済みのCLI引数。 */
export interface Arguments {
    /** 変換する文書の絶対パス。標準入力では`--base-dir`内の仮想パスで、実ファイルは存在しない。 */
    input: string;
    /** コマンドラインの入力指定。ワイルドカードは変換前に展開する。未指定時は`input`だけを変換する。 */
    inputPatterns?: readonly string[];
    /** 標準入力から本文を読むときにtrue。 */
    stdin?: boolean;
    /** ファイルへ書かず標準出力へ出力するときにtrue。 */
    stdout?: boolean;
    /** 複数入力の出力先ディレクトリ。入力同士の相対位置を保つ。 */
    outDir?: string;
    /** `--title`で明示された主文書のタイトル。front matterより優先する。 */
    title?: string;
    /** 警告が1件でもあれば、出力後に終了コード1で終える。 */
    strict?: boolean;
    /** 結果を標準出力へJSONで出力する。 */
    json?: boolean;
    /** 設定時は、ワークスペースルートの外のローカルファイルを読み込まない。 */
    restrictLocalFiles?: boolean;
    /** ブラウザー起動の待機時間（ミリ秒）。省略時は5秒。 */
    browserTimeoutMs?: number;
    /** PDF生成全体の待機時間（ミリ秒）。省略時は60秒。 */
    renderTimeoutMs?: number;
    /** 利用者のCSSファイルの絶対パス。指定順に連結する。 */
    cssPaths?: readonly string[];
    /** 読み込み済みの利用者のCSS。 */
    customCss?: string;
    /** YAML front matterの扱い。省略時は`auto`。 */
    frontMatter?: FrontMatterMode;
    /** 警告の通知先。省略時は標準エラーへ出力する。 */
    onWarning?: (message: string) => void;
    /** trueのときは変換後もブラウザーを閉じず、複数入力で再利用する。呼び出し側が閉じる責任を持つ。 */
    keepResources?: boolean;
    output?: string;
    format: OutputFormat;
    /** 生成文言と描画用HTMLの言語。CLI起動時は引数、JSON設定、enの順に決める。 */
    language: SupportedLanguage;
    browserPath?: string;
    workspaceRoot?: string;
    theme: Theme;
    mermaidTheme: 'auto' | 'default' | 'dark' | 'neutral';
    linked: boolean;
    embedImages: boolean;
    outline: boolean;
    force?: boolean;
    markdown?: string;
    pdfOptions?: PdfOptions;
    htmlOptions?: HtmlExportOptions;
    fontFamily?: string;
    mermaidFontSize?: number;
    remoteImagesEnabled?: boolean;
    renderFormat?: 'markdown' | 'mixed' | 'textile';
    configPath?: string;
    signal?: AbortSignal;
}

/** CLIバンドル用に複製したレンダラーと印刷素材を格納するディレクトリ。 */
const assetDir = __dirname;
/** 受け付けるコマンドラインオプションと対応させるヘルプ文。 */
const usage = `Usage: mve-convert INPUT.md --format html|pdf [-o OUTPUT]
       mve-convert INPUT.md "docs/**/*.md" --format html|pdf --out-dir DIR
       mve-convert - --format html|pdf [-o OUTPUT] < INPUT.md
  INPUT                   File, wildcard pattern (*, ?, **), or - for stdin
  --format html|pdf       Output format; optional when -o ends in .html, .htm, or .pdf
  -o, --output PATH       Output file (default: INPUT.html or INPUT.pdf); - for stdout
  --out-dir PATH          Output directory for one or more inputs
  --base-dir PATH         Base directory for relative links when reading stdin
  --title TEXT            Document title (single input)
  --css PATH              Additional CSS file; can be repeated
  --strict                Exit with code 1 when any warning is reported
  --json                  Write the result to stdout as JSON
  --restrict-local-files  Do not read local files outside the workspace root
  --front-matter MODE     auto removes YAML front matter, render keeps it (default: auto)
  --browser-timeout SEC   Browser startup timeout (default: 5)
  --render-timeout SEC    PDF generation timeout (default: 60)
  --config PATH           JSON export settings
  --force                 Overwrite existing output files
  --html-embed-images     Embed local images in HTML
  --workspace-root PATH   Workspace root for root-relative Markdown links
  --browser PATH          Chromium/Edge/Chrome executable for rendering
  --language CODE         Generated labels and HTML lang (default: en)
                          ja, en, zh-cn, ko, fr, de, es; does not translate text
  --theme light|dark      Heading color theme (default: dark)
  --mermaid-theme NAME    auto, default, dark, neutral (default: auto)
  --html-outline          Add the HTML outline sidebar
  --html-linked           Recursively export linked Markdown (HTML)
  --html-no-embed-images  Keep relative image paths (HTML)
  -h, --help              Show usage
  --version               Show package version
`;

/** タイムアウトとして受け付ける最大秒数。誤って桁の大きい値を与えてCIが長時間止まることを防ぐ。 */
const MAX_TIMEOUT_SECONDS = 3600;

/**
 * タイムアウトの秒数を検証してミリ秒へ変換する。
 * @param name - エラーに表示する設定名。
 * @param value - 数値または数値文字列の秒数。
 * @returns ミリ秒。
 * @throws 0以下、上限超過、または数値でない場合。先頭の`Invalid`により終了コード2になる。
 */
function parseTimeoutSeconds(name: string, value: unknown): number {
    const seconds = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
    // 1ミリ秒未満は丸めると0になり、Playwrightでは「タイムアウトなし」を意味してしまうため拒否する。
    if (!Number.isFinite(seconds) || seconds < 0.001 || seconds > MAX_TIMEOUT_SECONDS) {
        throw new Error(`Invalid ${name}: expected seconds between 0.001 and ${MAX_TIMEOUT_SECONDS}.`);
    }
    return Math.round(seconds * 1000);
}

/**
 * CLI引数を正規化済みの変換要求へ解析する。
 * @param argv - 実行ファイル名より後ろの引数。パスは解析処理内で解決する。
 * @returns 変換要求。ヘルプ表示が指定された場合はundefined。
 * @throws オプション、値、必須入力パスが無効な場合にErrorを送出する。
 */
export function parseArguments(argv: readonly string[]): Arguments | undefined {
    if (argv.includes('-h') || argv.includes('--help')) return undefined;
    const inputs: string[] = [];
    let stdin = false;
    let output: string | undefined;
    let outDir: string | undefined;
    let baseDir: string | undefined;
    let title: string | undefined;
    let strict = false;
    let json = false;
    let restrictLocalFiles = false;
    let browserTimeoutMs: number | undefined;
    let renderTimeoutMs: number | undefined;
    let frontMatter: FrontMatterMode | undefined;
    const cssPaths: string[] = [];
    let format: OutputFormat | undefined;
    let language: SupportedLanguage = 'en';
    let browserPath: string | undefined;
    let workspaceRoot: string | undefined;
    let theme: Theme = 'dark';
    // auto は VS Code 拡張との設定互換のための値で、CLI の描画では default と同じに扱う。
    let mermaidTheme: Arguments['mermaidTheme'] = 'auto';
    let linked = false;
    let embedImages = false;
    let outline = false;
    let force = false;
    let configPath: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--html-linked') { linked = true; continue; }
        if (arg === '--html-embed-images') { embedImages = true; continue; }
        if (arg === '--html-no-embed-images') { embedImages = false; continue; }
        if (arg === '--html-outline') { outline = true; continue; }
        if (arg === '--force') { force = true; continue; }
        if (arg === '--strict') { strict = true; continue; }
        if (arg === '--json') { json = true; continue; }
        if (arg === '--restrict-local-files') { restrictLocalFiles = true; continue; }
        if (arg === '-') { stdin = true; continue; }
        if (!arg.startsWith('-')) {
            inputs.push(arg);
            continue;
        }
        const value = argv[++index];
        if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
        switch (arg) {
            case '-o':
            case '--output':
                output = value;
                break;
            case '--out-dir':
                outDir = path.resolve(value);
                break;
            case '--base-dir':
                baseDir = path.resolve(value);
                break;
            case '--title':
                title = normalizeTitle(value);
                if (title === undefined) throw new Error('Invalid title: the value is empty.');
                break;
            case '--css':
                cssPaths.push(path.resolve(value));
                break;
            case '--front-matter':
                if (value !== 'auto' && value !== 'render') throw new Error('Invalid front matter mode: ' + value);
                frontMatter = value;
                break;
            case '--browser-timeout':
                browserTimeoutMs = parseTimeoutSeconds('browser timeout', value);
                break;
            case '--render-timeout':
                renderTimeoutMs = parseTimeoutSeconds('render timeout', value);
                break;
            case '--format':
                if (value !== 'html' && value !== 'pdf') throw new Error('Invalid format: ' + value);
                format = value;
                break;
            case '--config':
                configPath = path.resolve(value);
                break;
            case '--language':
                if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(value)) throw new Error('Invalid language: ' + value);
                language = value as SupportedLanguage;
                break;
            case '--browser':
                browserPath = value;
                break;
            case '--workspace-root':
                workspaceRoot = value;
                break;
            case '--theme':
                if (value !== 'dark' && value !== 'light') throw new Error('Invalid theme: ' + value);
                theme = value;
                break;
            case '--mermaid-theme':
                if (value !== 'auto' && value !== 'default' && value !== 'dark' && value !== 'neutral') throw new Error('Invalid Mermaid theme: ' + value);
                mermaidTheme = value;
                break;
            default:
                throw new Error('Unknown argument: ' + arg);
        }
    }
    if (!stdin && !inputs.length) throw new Error('Input Markdown path is required.');
    if (stdin && inputs.length) throw new Error('Only one input is supported when reading standard input.');
    if (!format && output) {
        // 拡張子で判定できない出力先は、従来どおり--formatの指定漏れとして扱う。
        const extension = path.extname(output).toLowerCase();
        if (extension === '.html' || extension === '.htm') format = 'html';
        else if (extension === '.pdf') format = 'pdf';
    }
    if (!format) throw new Error('--format html|pdf is required.');
    if (format === 'pdf' && (linked || outline || argv.includes('--html-embed-images') || argv.includes('--html-no-embed-images'))) {
        throw new Error('--html-embed-images, --html-no-embed-images, --html-linked, and --html-outline are HTML-only options.');
    }
    if (output && outDir) throw new Error('Invalid output: --output and --out-dir cannot be combined.');
    if (stdin && outDir) throw new Error('Invalid output: --out-dir cannot be combined with standard input.');
    if (baseDir && !stdin) throw new Error('Invalid --base-dir: it applies only when reading standard input.');
    // 入力がファイルでも`-o -`なら標準出力へ書く。標準入力は既定の出力先がないため標準出力へ書く。
    const stdout = output === '-' || (stdin && !output);
    if (stdout && json) throw new Error('Invalid output: --json cannot be combined with standard output.');
    const virtualInput = path.join(baseDir ?? process.cwd(), 'stdin.md');
    return {
        input: stdin ? virtualInput : path.resolve(inputs[0]),
        inputPatterns: stdin ? undefined : inputs, stdin, stdout, outDir, title, strict, json,
        restrictLocalFiles, browserTimeoutMs, renderTimeoutMs, cssPaths, frontMatter,
        output: output && output !== '-' ? path.resolve(output) : undefined, format,
        language, browserPath, workspaceRoot, theme, mermaidTheme, linked, embedImages, outline, force, configPath
    };
}

/**
 * JSON設定の誤記を出力前に検出する。数値の範囲補正は既存の正規化へ委ねる。
 * @param name - エラーに表示する設定オブジェクト名。
 * @param value - 検証対象のJSON値。
 * @param fields - 許可するキーとその値の検証関数。
 * @returns 型とキーが検証済みの設定オブジェクト。
 */
function validateFields(
    name: string, value: unknown, fields: Record<string, (item: unknown) => boolean>
): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
    const object = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(object)) {
        if (!Object.hasOwn(fields, key)) throw new Error(`Unknown ${name} key: ${key}`);
        if (!fields[key](item)) throw new Error(`Invalid ${name}.${key}.`);
    }
    return object;
}

/**
 * PDFとHTMLのJSON設定を、既存の正規化で値が黙って消える前に検証する。
 * @param pdf - PDF設定候補。
 * @param html - HTML設定候補。
 */
function validateExportConfig(pdf: unknown, html: unknown): void {
    const string = (item: unknown): boolean => typeof item === 'string';
    const boolean = (item: unknown): boolean => typeof item === 'boolean';
    const numeric = (item: unknown): boolean =>
        (typeof item === 'number' || typeof item === 'string') && item !== '' && Number.isFinite(Number(item));
    /** ヘッダー・フッターの文字揃えとして有効な値かを判定する。 */
    const align = (item: unknown): boolean => item === 'left' || item === 'center' || item === 'right';
    if (pdf !== undefined) {
        validateFields('pdf', pdf, {
            format: (item) => string(item) && (PDF_PAPER_FORMATS as readonly unknown[]).includes(item),
            orientation: (item) => item === 'portrait' || item === 'landscape',
            margins: (item) => {
                validateFields('pdf.margins', item,
                    { top: numeric, right: numeric, bottom: numeric, left: numeric }); return true;
            },
            header: string, footer: string,
            textReplacements: (item) => Array.isArray(item) && item.every((rule) => {
                const value = validateFields('pdf.textReplacements[]', rule,
                    { pattern: string, replacement: string });
                return string(value.pattern) && isTextReplacementPatternValid(value.pattern as string)
                    && string(value.replacement);
            }),
            fontFamily: string, bodyFontSize: numeric,
            headingFontSizes: (item) => {
                validateFields('pdf.headingFontSizes', item,
                    { h1: numeric, h2: numeric, h3: numeric, h4: numeric, h5: numeric, h6: numeric }); return true;
            },
            codeFontSize: numeric, lineHeight: numeric, paragraphSpacing: numeric,
            headerAlign: align, footerAlign: align,
            headerFooterFontSize: numeric, headerFooterPadding: numeric,
            saveWithoutDialog: boolean
        });
    }
    if (html !== undefined) validateFields('html', html, {
        embedImages: boolean, convertLinkedMarkdown: boolean,
        showOutlineSidebar: boolean, saveWithoutDialog: boolean
    });
}

/**
 * Resolve JSON settings before touching any output file.
 * JSON.parseはBOMを構文エラーとして扱うため、メモ帳などがBOM付きで保存した設定も読めるよう先に除去する。
 */
async function loadConfig(args: Arguments, argv: readonly string[]): Promise<Arguments> {
    if (!args.configPath) return args;
    const base = path.dirname(args.configPath);
    let raw: unknown;
    try {
        raw = JSON.parse(stripUtf8Bom(await fs.readFile(args.configPath, 'utf8')));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code) throw error;
        throw new Error(`Invalid JSON configuration: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Configuration must be a JSON object.');
    const config = raw as Record<string, unknown>;
    for (const key of Object.keys(config)) {
        if (!['rendering', 'pdf', 'html', 'browserPath', 'workspaceRoot'].includes(key)) throw new Error(`Unknown configuration key: ${key}`);
    }
    const rendering = (config.rendering ?? {}) as Record<string, unknown>;
    if (!rendering || typeof rendering !== 'object' || Array.isArray(rendering)) throw new Error('rendering must be an object.');
    for (const key of Object.keys(rendering)) {
        if (!['renderFormat', 'editorTheme', 'previewFontFamily', 'remoteImagesEnabled', 'mermaidTheme', 'mermaidFontSize', 'language',
            'frontMatter', 'restrictLocalFiles', 'css', 'browserTimeout', 'renderTimeout'].includes(key)) {
            throw new Error(`Unknown rendering key: ${key}`);
        }
    }
    const format = rendering.renderFormat;
    if (format !== undefined && !['auto', 'markdown', 'mixed', 'textile'].includes(String(format))) throw new Error('Invalid renderFormat.');
    const theme = rendering.editorTheme;
    if (theme !== undefined && theme !== 'dark' && theme !== 'light') throw new Error('Invalid editorTheme.');
    const mermaid = rendering.mermaidTheme;
    if (mermaid !== undefined && !['auto', 'default', 'dark', 'neutral'].includes(String(mermaid))) throw new Error('Invalid mermaidTheme.');
    const fontSize = rendering.mermaidFontSize;
    if (fontSize !== undefined && (typeof fontSize !== 'number' || fontSize < 8 || fontSize > 48)) throw new Error('Invalid mermaidFontSize.');
    if (rendering.previewFontFamily !== undefined && typeof rendering.previewFontFamily !== 'string') throw new Error('Invalid previewFontFamily.');
    const remote = rendering.remoteImagesEnabled;
    if (remote !== undefined && typeof remote !== 'boolean') throw new Error('Invalid remoteImagesEnabled.');
    const language = rendering.language;
    if (language !== undefined && !(SUPPORTED_LANGUAGES as readonly unknown[]).includes(language)) throw new Error('Invalid language.');
    const frontMatter = rendering.frontMatter;
    if (frontMatter !== undefined && frontMatter !== 'auto' && frontMatter !== 'render') throw new Error('Invalid frontMatter.');
    const restrict = rendering.restrictLocalFiles;
    if (restrict !== undefined && typeof restrict !== 'boolean') throw new Error('Invalid restrictLocalFiles.');
    const css = rendering.css;
    if (css !== undefined && typeof css !== 'string' && !(Array.isArray(css) && css.every((item) => typeof item === 'string'))) {
        throw new Error('Invalid css.');
    }
    const browserTimeout = rendering.browserTimeout === undefined ? undefined : parseTimeoutSeconds('browserTimeout', rendering.browserTimeout);
    const renderTimeout = rendering.renderTimeout === undefined ? undefined : parseTimeoutSeconds('renderTimeout', rendering.renderTimeout);
    const pdf = config.pdf;
    const html = config.html;
    if (pdf !== undefined && (!pdf || typeof pdf !== 'object' || Array.isArray(pdf))) throw new Error('pdf must be an object.');
    if (html !== undefined && (!html || typeof html !== 'object' || Array.isArray(html))) throw new Error('html must be an object.');
    validateExportConfig(pdf, html);
    if (config.browserPath !== undefined && typeof config.browserPath !== 'string') throw new Error('browserPath must be a string.');
    if (config.workspaceRoot !== undefined && typeof config.workspaceRoot !== 'string') throw new Error('workspaceRoot must be a string.');
    return {
        ...args,
        frontMatter: args.frontMatter ?? frontMatter as FrontMatterMode | undefined,
        restrictLocalFiles: args.restrictLocalFiles || restrict === true,
        browserTimeoutMs: args.browserTimeoutMs ?? browserTimeout,
        renderTimeoutMs: args.renderTimeoutMs ?? renderTimeout,
        // --cssは設定ファイルのcssを追加ではなく置換する。他のオプションと同じ優先順位にするため。
        cssPaths: args.cssPaths?.length ? args.cssPaths
            : css === undefined ? args.cssPaths : [css].flat().map((item) => path.resolve(base, item as string)),
        language: argv.includes('--language') ? args.language : (language as SupportedLanguage | undefined) ?? args.language,
        theme: argv.includes('--theme') ? args.theme : (theme as Theme | undefined) ?? args.theme,
        mermaidTheme: argv.includes('--mermaid-theme') ? args.mermaidTheme :
            (mermaid as Arguments['mermaidTheme'] | undefined) ?? args.mermaidTheme,
        mermaidFontSize: fontSize as number | undefined,
        remoteImagesEnabled: remote as boolean | undefined,
        renderFormat: format === 'auto' ? undefined : format as Arguments['renderFormat'],
        fontFamily: rendering.previewFontFamily as string | undefined,
        browserPath: argv.includes('--browser') ? args.browserPath : config.browserPath ? path.resolve(base, config.browserPath) : args.browserPath,
        workspaceRoot: argv.includes('--workspace-root') ? args.workspaceRoot : config.workspaceRoot ? path.resolve(base, config.workspaceRoot) : args.workspaceRoot,
        pdfOptions: pdf ? normalizePdfOptions(pdf) : undefined,
        htmlOptions: html ? normalizeHtmlExportSettings(html) : undefined,
        linked: argv.includes('--html-linked') ? true : html ? Boolean((html as Record<string, unknown>).convertLinkedMarkdown) : args.linked,
        // 画像フラグはJSONより優先し、両方指定された場合は引数解析で最後に読んだ値を使う。
        embedImages: argv.includes('--html-no-embed-images') || argv.includes('--html-embed-images')
            ? args.embedImages : html ? Boolean((html as Record<string, unknown>).embedImages) : args.embedImages,
        outline: argv.includes('--html-outline') ? true : html ? Boolean((html as Record<string, unknown>).showOutlineSidebar) : args.outline
    };
}

/** Mermaid図の画像参照では、ワークスペース内に存在する実ファイルだけを読み込む。 */
async function readDiagramLocalImage(
    source: string, sourceFile: string, workspaceRoot: string
): Promise<Uint8Array | undefined> {
    const clean = decodeLocalResourceSource(source);
    if (!clean || (/^[a-z][a-z0-9+.-]*:/i.test(clean) && !/^file:/i.test(clean))) return undefined;
    try {
        const name = /^file:/i.test(clean)
            ? fileURLToPath(clean)
            : path.resolve(path.dirname(sourceFile), clean);
        if (!await isPathInsideRoot(workspaceRoot, name)) return undefined;
        const target = await fs.realpath(name);
        const stat = await fs.stat(target);
        if (!stat.isFile() || stat.size > MAX_MERMAID_IMAGE_BYTES) return undefined;
        return await fs.readFile(target);
    } catch {
        return undefined;
    }
}

/**
 * Mermaid図の画像を解決し、読み込めなかった画像を警告する。図自体は画像なしで描画を続ける。
 * 欠落、形式不正、サイズ超過、リモートの取得失敗をまとめて検出できるよう、解決結果と突き合わせて判定する。
 * @param sources - 図が参照する画像。
 * @param signal - 中断の通知。
 * @param sourceFile - 相対参照の基準となる文書。
 * @param args - ワークスペースルートと警告の通知先を持つ変換要求。
 * @returns 参照からdata URIへの対応表。
 */
async function resolveDiagramImages(
    sources: string[], signal: AbortSignal | undefined, sourceFile: string, args: Arguments
): Promise<Record<string, string>> {
    const resolved = await resolveMermaidImageSources(
        sources,
        (image) => readDiagramLocalImage(image, sourceFile, args.workspaceRoot ?? path.dirname(sourceFile)),
        signal
    );
    [...new Set(sources)].forEach((source, index) => {
        // 埋め込み済みのdata URIは解決の対象外であり、長い文字列を警告へ出さない。
        if (resolved[source] || /^data:/i.test(source)) return;
        const reason = index >= MAX_IMAGE_COUNT
            ? `was skipped because a diagram can load at most ${MAX_IMAGE_COUNT} images.`
            : 'could not be loaded.';
        (args.onWarning ?? console.warn)(`Mermaid image ${JSON.stringify(source)} ${reason}`);
    });
    return resolved;
}

/**
 * DOMPurifyを含む既存のブラウザーレンダラーを実行してから、既存のPele図表ワーカーを実行する。
 * ブラウザー起動を繰り返さないようPageを再利用する。`markdown`はfront matterを除去済みの本文を渡す。
 * 構文エラーなど`MermaidDiagramError`で失敗した図は、`data-mermaid-status="error"`と`pre.mermaid-error-message`の
 * エラー表示（ローカライズ済みの見出しと失敗理由）へ置き換えて出力を続け、stderrへ警告する。
 * キャンセルや描画ページを用意できないブラウザー・Workerの障害は例外として呼び出し側へ伝播する。
 */
async function renderMarkdownFile(
    page: Page, markdown: string, sourceFile: string, args: Arguments
): Promise<string> {
    const renderFormat = resolveRenderFormat(sourceFile, args.renderFormat);
    const html = await page.evaluate(({ source, format, language, remoteImagesEnabled }) => {
        const renderer = (globalThis as unknown as {
            mveMarkdownFallback?: {
                renderMarkdown: (input: string, options: {
                    remoteImagesEnabled: boolean; renderFormat: string; language: string
                }) => string;
            }
        }).mveMarkdownFallback;
        if (!renderer) throw new Error('Markdown fallback renderer was not loaded.');
        return renderer.renderMarkdown(source, {
            remoteImagesEnabled, renderFormat: format, language
        });
    }, {
        source: markdown, format: renderFormat, language: args.language,
        remoteImagesEnabled: args.remoteImagesEnabled ?? true
    });

    const diagrams = await page.evaluate((markup) => {
        const root = document.createElement('div');
        root.innerHTML = markup;
        return [...root.querySelectorAll<HTMLElement>('[data-mermaid-source]')].map((node) =>
            decodeURIComponent(node.dataset.mermaidSource ?? ''));
    }, html);
    if (!diagrams.length) return prepareExportHtml(html);

    // 構文エラーなど図そのものの失敗は、プレビューと同じく図単位のエラー表示へ置き換えて文書の出力を続ける。
    // キャンセル、ブラウザーやWorkerの障害は文書全体を出力できないため、従来どおり例外を伝播して中断する。
    const rendered = await Promise.all(diagrams.map(async (source, index): Promise<string | MermaidDiagramFailure> => {
        let result: Awaited<ReturnType<typeof renderPeleMermaid>>;
        try {
            result = await renderPeleMermaid(
                source, args.mermaidTheme === 'auto' ? 'default' : args.mermaidTheme,
                path.join(assetDir, 'pele-render-worker.js'),
                () => acquirePdfBrowser(args.language, args.browserPath, args.browserTimeoutMs), args.signal, {
                fontFamily: args.fontFamily ?? '',
                fontSize: args.mermaidFontSize,
                resourceScope: sourceFile,
                resolveImages: (sources, signal) => resolveDiagramImages(sources, signal, sourceFile, args)
            }
            );
        } catch (error) {
            if (!(error instanceof MermaidDiagramError)) throw error;
            (args.onWarning ?? console.warn)(`Mermaid diagram ${index + 1} could not be rendered (${error.message}); an error message was embedded instead.`);
            return { reason: error.message };
        }
        return namespaceMermaidSvg(result.svg, `cli-${index}`);
    }));
    return prepareExportHtml(await page.evaluate(({ markup, svgs, errorMessage }) => {
        const root = document.createElement('div');
        root.innerHTML = markup;
        const nodes = root.querySelectorAll<HTMLElement>('[data-mermaid-source]');
        nodes.forEach((node, index) => {
            const svg = svgs[index];
            if (typeof svg !== 'string') {
                // プレビューのエラー表示とclass・roleを揃え、文言はHTMLとして解釈させずtextContentで入れる。
                const message = document.createElement('pre');
                message.className = 'mermaid-error-message';
                message.setAttribute('role', 'alert');
                message.textContent = `${errorMessage}\n${svg.reason}`;
                node.replaceChildren(message);
                node.setAttribute('data-mermaid-status', 'error');
                return;
            }
            node.innerHTML = svg;
            node.setAttribute('data-mermaid-status', 'ready');
        });
        return root.innerHTML;
    }, { markup: html, svgs: rendered, errorMessage: getMessages(args.language).renderer.mermaidError }));
}

/**
 * 描画できなかったMermaid図の代わりに出力へ埋め込む情報。
 * reasonは`MermaidDiagramError`のmessageで、ソース本文や依存関係の詳細を含まない安全な文言に限る。
 */
interface MermaidDiagramFailure {
    reason: string;
}

/**
 * Marpスライド内でMermaid図を描画できなかったときのエラー表示用CSS。
 * エディターのMarpプレビュー（MarpPreview.tsx）が使う配色・余白と一致させ、プレビューとPDFの見た目を揃える。
 */
const MARP_MERMAID_ERROR_CSS = '.mve-marp-slide .mve-marp-mermaid-error{display:block;color:#b42318}'
    + '.mve-marp-slide .mve-marp-mermaid-error-message{margin:.4em 0;white-space:pre-wrap}';

/**
 * Marp YAMLのルート設定だけを有効として認識する。
 * @param yaml - 文書先頭のYAML front matter本文。
 * @returns 有効なYAMLオブジェクトでmarpが真偽値trueの場合にtrue。
 */
function parseMarpFrontMatter(yaml: string): boolean {
    const parsed = parseYaml(yaml);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        && parsed.marp === true;
}

/**
 * MarpのスライドをMarp Coreで描き、PDFのページ単位へ包む。
 * 構文エラーなど`MermaidDiagramError`で失敗した図は、エディターのMarpプレビューと同じく元のコードブロックと
 * エラー文言（ローカライズ済みの見出しと失敗理由）を並べた表示へ置き換えて出力を続け、stderrへ警告する。
 * キャンセルや描画ページを用意できないブラウザー・Workerの障害は例外として伝播する。
 */
async function renderMarpPdf(
    page: Page, markdown: string, sourceFile: string, args: Arguments
): Promise<{ html: string; css: string }> {
    const rendered = renderMarpMarkdown(markdown, '');
    const slides: string[] = [];
    let hasDiagramError = false;
    for (let index = 0; index < rendered.slides.length; index += 1) {
        const slide = rendered.slides[index];
        const blocks = await page.evaluate((markup) => {
            const root = document.createElement('div');
            root.innerHTML = markup;
            return [...root.querySelectorAll('pre')].flatMap((pre, position) => {
                const code = pre.querySelector('code');
                return code && [...code.classList].some((name) => /^(?:language|lang)-mermaid$/i.test(name))
                    ? [{ position, source: code.textContent ?? '' }] : [];
            });
        }, slide);
        // 通常文書と同じく、図そのものの失敗だけを図単位のエラー表示へ置き換え、基盤の障害は伝播して中断する。
        const svgs = await Promise.all(blocks.map(async (block, blockIndex): Promise<string | MermaidDiagramFailure> => {
            let result: Awaited<ReturnType<typeof renderPeleMermaid>>;
            try {
                result = await renderPeleMermaid(
                    block.source, args.mermaidTheme === 'auto' ? 'default' : args.mermaidTheme,
                    path.join(assetDir, 'pele-render-worker.js'),
                    () => acquirePdfBrowser(args.language, args.browserPath, args.browserTimeoutMs), args.signal, {
                    fontFamily: args.fontFamily ?? '',
                    fontSize: args.mermaidFontSize,
                    resourceScope: sourceFile,
                    resolveImages: (sources, signal) => resolveDiagramImages(sources, signal, sourceFile, args)
                }
                );
            } catch (error) {
                if (!(error instanceof MermaidDiagramError)) throw error;
                (args.onWarning ?? console.warn)(`Mermaid diagram ${blockIndex + 1} on slide ${index + 1} could not be rendered (${error.message}); an error message was embedded instead.`);
                return { reason: error.message };
            }
            return namespaceMermaidSvg(result.svg, `cli-marp-${index}-${block.position}`);
        }));
        if (svgs.some((svg) => typeof svg !== 'string')) hasDiagramError = true;
        slides.push(await page.evaluate(({ markup, positions, diagrams, errorMessage }) => {
            const root = document.createElement('div');
            root.innerHTML = markup;
            const pre = [...root.querySelectorAll('pre')];
            positions.forEach((position, blockIndex) => {
                const source = pre[position];
                const diagram = diagrams[blockIndex];
                const container = document.createElement('div');
                if (typeof diagram !== 'string') {
                    // エディターのMarpプレビューとclass・role・要素構成を揃え、文言はHTMLとして解釈させずtextContentで入れる。
                    container.className = 'mve-marp-mermaid mve-marp-mermaid-error';
                    container.setAttribute('role', 'group');
                    if (source) container.append(source.cloneNode(true));
                    const message = document.createElement('p');
                    message.className = 'mve-marp-mermaid-error-message';
                    message.setAttribute('role', 'alert');
                    message.textContent = `${errorMessage}\n${diagram.reason}`;
                    container.append(message);
                } else {
                    container.className = 'mve-marp-mermaid';
                    container.setAttribute('role', 'img');
                    container.innerHTML = diagram;
                }
                source?.replaceWith(container);
            });
            return root.innerHTML;
        }, {
            markup: slide,
            positions: blocks.map((block) => block.position),
            diagrams: svgs,
            errorMessage: getMessages(args.language).renderer.mermaidError
        }));
    }
    const content = createMarpPdfExportContent(slides, rendered.css);
    if (!content) throw new Error('Marp document contains no slides.');
    // エラー表示はエディターのMarpプレビューと同じ配色・余白にする。正常な図の既存出力を変えないよう、失敗時だけ追加する。
    const css = hasDiagramError ? `${content.css}\n${MARP_MERMAID_ERROR_CSS}` : content.css;
    return { html: content.html, css };
}

/**
 * 描画済み本文の最初のH1から、出力タイトルの候補を読み取る。
 * `getOutline`は記号を除去するため（`C++`が`C`になる）、原文ではなく描画結果の文字列を使う。
 * DOMParserの文書は画像の読み込みを始めないため、リモート画像への要求を増やさない。
 * KaTeXは同じ数式をMathMLとHTMLの両方で出力するため、MathML側を除いて文字の重複を防ぐ。
 * 巨大な文書で本文全体をブラウザーへ渡して再解析すると変換が目に見えて遅くなるため、H1の部分だけを切り出して渡す。
 * 本文はサニタイズ済みでコード内の`<`はエスケープされているため、切り出しで誤認する余地は小さい。
 * @param page - Markdownの描画に使用したブラウザーページ。
 * @param html - 描画済み本文。
 * @returns 最初のH1の文字列。H1がない場合はundefined。
 */
async function readFirstHeading(page: Page, html: string): Promise<string | undefined> {
    const fragment = /<h1\b[\s\S]*?<\/h1\s*>/i.exec(html)?.[0];
    if (!fragment) return undefined;
    return page.evaluate((markup) => {
        const heading = new DOMParser().parseFromString(markup, 'text/html').querySelector('h1');
        heading?.querySelectorAll('.katex-mathml').forEach((node) => node.remove());
        return heading?.textContent ?? undefined;
    }, fragment);
}

/**
 * 出力時だけ置換Workerを読み込み、本文・属性、PDF見出し、文書タイトルを同じ順で書き換える。
 * @param page - Markdownの描画にも使用したブラウザーページ。
 * @param html - 描画済み本文。
 * @param options - PDFとHTMLで共有する置換設定。
 * @param format - PDFの場合だけヘッダーとフッターを対象にする。
 * @param title - 置換前の文書タイトル。
 * @returns 置換済みの本文、設定、タイトル。置換ルールがなければ入力をそのまま返す。
 */
async function replaceOutput(
    page: Page, html: string, options: PdfOptions, format: OutputFormat, title: string
): Promise<{ html: string; options: PdfOptions; title: string }> {
    if (!options.textReplacements.some((rule) => rule.pattern.length > 0)) return { html, options, title };
    await page.addScriptTag({ path: path.join(assetDir, 'output-replacements.js') });
    const result = await page.evaluate(async ({ markup, rules, header, footer, title }) => {
        const replacement = (globalThis as unknown as {
            mveOutputReplacements?: {
                replaceOutputHtml: (html: string, rules: PdfOptions['textReplacements'],
                    header: string, footer: string, title: string
                ) => Promise<{ html: string; header: string; footer: string; title: string }>;
            }
        }).mveOutputReplacements;
        if (!replacement) throw new Error('Output replacement renderer was not loaded.');
        return replacement.replaceOutputHtml(markup, rules, header, footer, title);
    }, {
        markup: html, rules: options.textReplacements, title,
        header: format === 'pdf' ? options.header : '', footer: format === 'pdf' ? options.footer : ''
    });
    return {
        html: result.html, title: result.title, options: format === 'pdf'
            ? { ...options, header: result.header, footer: result.footer } : options
    };
}

/** エンジン内で共有するPeleページとブラウザーの終了を、次の要求開始より前に確定する。 */
let conversionTail: Promise<void> = Promise.resolve();

/**
 * 未作成の出力でも、既存の親ディレクトリやリンク先の実パスから保存予定先を求める。
 * @param output - 検査する出力先。ファイルや末尾のディレクトリは未作成でもよい。
 * @returns シンボリックリンク・ジャンクションを解決した絶対パス。
 * @throws ENOENT以外のファイルシステムエラーは伝播し、リンク循環は書き込み前に拒否する。
 */
async function resolveOutputPath(output: string): Promise<string> {
    const absolute = path.resolve(output);
    try {
        return await fs.realpath(absolute);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(absolute);
        if (parent === absolute) throw error;
        return path.join(await resolveOutputPath(parent), path.basename(absolute));
    }
}

/**
 * 出力先の別名から原文を守り、複数文書が同じ出力ファイルへ書き込まれるのを防ぐ。
 * @param sources - 主文書とリンク先文書の実ファイルパス。
 * @param outputs - 書き込み予定の全出力パス。
 * @throws 出力先が原文と同じ実体である場合、または出力先同士が重複する場合。
 */
async function assertDistinctFiles(sources: readonly string[], outputs: readonly string[]): Promise<void> {
    /** Windowsの既存のパス比較規則を保ち、POSIXの大小文字を区別する。 */
    const normalized = (value: string): string => {
        const resolved = path.resolve(value);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const sourcePaths = new Set(sources.map(normalized));
    const sourceFiles = await Promise.all(sources.map(async (source) => ({
        stat: await fs.stat(source).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
        }),
        realPath: await fs.realpath(source).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
        })
    })));
    const outputPaths = new Set<string>();
    const outputFiles = new Set<string>();
    for (const output of outputs) {
        const outputPath = normalized(await resolveOutputPath(output));
        if (outputPaths.has(outputPath)) throw new Error(`Output paths must be distinct: ${output}`);
        outputPaths.add(outputPath);
        if (sourcePaths.has(normalized(output))) throw new Error(`Output must differ from input: ${output}`);
        const target = await fs.stat(output).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
        });
        if (!target) continue;
        // --forceでも、既存のハードリンク・シンボリックリンク別名への二重書き込みは許可しない。
        const identity = `${target.dev}:${target.ino}`;
        if (outputFiles.has(identity)) throw new Error(`Output paths must be distinct: ${output}`);
        outputFiles.add(identity);
        const targetRealPath = outputPath;
        if (sourceFiles.some((source) => source.stat &&
            ((source.stat.dev === target.dev && source.stat.ino === target.ino)
                || (source.realPath && normalized(source.realPath) === targetRealPath)))) {
            throw new Error(`Output must differ from input: ${output}`);
        }
    }
}

/**
 * 複数パネルの出力要求を直列化し、先行要求の資源解放で後続要求を中断させない。
 * @param args - 検証済みの入力・出力・ブラウザー・描画オプション。
 * @returns この変換で書き込んだ絶対パス。
 * @throws 入力または出力パスが無効な場合、または描画に失敗した場合にErrorを送出する。
 */
export async function convert(args: Arguments): Promise<readonly string[]> {
    const result = conversionTail.then(() => convertExclusive(args));
    conversionTail = result.then(() => undefined, () => undefined);
    return result;
}

/**
 * 変換要求の出力先を、拡張子の補完を含めて確定する。
 * @param args - 入力、明示された出力先、形式を持つ変換要求。
 * @returns 出力パス。未指定なら入力の拡張子を出力形式へ置き換えたパス。
 */
function plannedOutput(args: Pick<Arguments, 'input' | 'output' | 'format'>): string {
    const requestedOutput = args.output ?? args.input.replace(/\.[^.\\/]+$/, '') + '.' + args.format;
    return args.format === 'html' ? ensureHtmlExtension(requestedOutput) : requestedOutput;
}

/**
 * 標準出力へ書き込み、バッファへの受け渡しの完了を待つ。
 * 読み手が先に閉じた場合（`| head`のEPIPE）の失敗は書き込みのコールバックで受け取り、終了コード1として報告する。
 * @param data - 出力するHTML文字列またはPDFのバイト列。
 * @throws 書き込みに失敗した場合。
 */
async function writeStdout(data: string | Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        process.stdout.write(data, (error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

/**
 * 1件の原文を描画し、HTML/PDFの保存と共有資源の解放を完了する。
 * @param args - 検証済みの変換要求。
 * @returns 書き込み済みの出力パス。標準出力へ書いた場合は空。
 */
async function convertExclusive(args: Arguments): Promise<readonly string[]> {
    args.signal?.throwIfAborted();
    if (args.markdown === undefined) {
        const inputStat = await fs.stat(args.input);
        if (!inputStat.isFile()) throw new Error('Input must be a file.');
    }
    const output = plannedOutput(args);
    // 標準出力では出力パスは相対リンクの基準に使うだけで、実ファイルへの衝突は起きない。
    if (!args.stdout) await assertDistinctFiles([args.input], [output]);
    if (!args.force && !args.stdout) {
        try {
            await fs.stat(output);
            throw new Error(`Output already exists: ${output}`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
    let context: BrowserContext | undefined;
    /** 中断中のブラウザー評価を止め、finally で残りの資源を解放する。 */
    const abortContext = () => { void context?.close().catch(() => undefined); };
    const imagePolicy: LocalImagePolicy = {
        onWarning: args.onWarning,
        restrictRoot: args.restrictLocalFiles ? args.workspaceRoot ?? path.dirname(args.input) : undefined,
        networkDirectoryCache: new Map(),
        directoryListingCache: new Map()
    };
    try {
        const browser = await acquirePdfBrowser(args.language, args.browserPath, args.browserTimeoutMs);
        args.signal?.throwIfAborted();
        context = await browser.newContext({ javaScriptEnabled: true });
        args.signal?.addEventListener('abort', abortContext, { once: true });
        args.signal?.throwIfAborted();
        const page = await context.newPage();
        await page.addScriptTag({ path: path.join(assetDir, 'markdown-fallback.js') });
        const markdown = stripUtf8Bom(args.markdown ?? await fs.readFile(args.input, 'utf8'));
        const metadata = extractDocumentMetadata(markdown, resolveRenderFormat(args.input, args.renderFormat), args.frontMatter);
        const marp = args.format === 'pdf' && hasMarpFrontMatterCandidate(markdown)
            && isMarpMarkdown(markdown, parseMarpFrontMatter);
        // Marp CoreはスライドのディレクティブとしてFront matterを解釈するため、除去前の原文を渡す。
        const marpContent = marp ? await renderMarpPdf(page, markdown, args.input, args) : undefined;
        const renderedHtml = marpContent?.html ?? await renderMarkdownFile(page, metadata.body, args.input, args);
        const replacementOptions = args.pdfOptions ?? DEFAULT_PDF_OPTIONS;
        const explicitTitle = args.title ?? metadata.frontMatterTitle;
        const title = chooseDocumentTitle(explicitTitle,
            explicitTitle === undefined ? await readFirstHeading(page, renderedHtml) : undefined, args.input);
        // 展開した値にも出力置換が適用されるよう、置換より前にプレースホルダーを埋める。
        const placeholders = { title, file: path.basename(args.input), date: formatLocalDate(new Date()) };
        const replaced = await replaceOutput(page, renderedHtml, {
            ...replacementOptions,
            header: expandHeaderFooterPlaceholders(replacementOptions.header, placeholders),
            footer: expandHeaderFooterPlaceholders(replacementOptions.footer, placeholders)
        }, args.format, title);
        const html = replaced.html;
        const fontFamily = args.fontFamily ?? DEFAULT_FONT_FAMILY_STACK;
        const css = (marpContent?.css ? marpContent.css + '\n' : '') + printContentCss(fontFamily) + '\n'
            + await fs.readFile(path.join(assetDir, 'print-assets.css'), 'utf8');
        if (args.format === 'pdf') {
            const pdf = await renderPdf({
                html, css,
                title: replaced.title,
                documentPath: args.input,
                browserPath: args.browserPath,
                options: replaced.options,
                editorTheme: args.theme,
                language: args.language,
                signal: args.signal,
                preferCssPageSize: marpContent !== undefined,
                customCss: args.customCss,
                imagePolicy,
                browserTimeoutMs: args.browserTimeoutMs,
                renderTimeoutMs: args.renderTimeoutMs
            });
            args.signal?.throwIfAborted();
            if (args.stdout) {
                await writeStdout(pdf);
                return [];
            }
            await fs.mkdir(path.dirname(output), { recursive: true });
            await fs.writeFile(output, pdf, { flag: args.force ? 'w' : 'wx', signal: args.signal });
            args.signal?.throwIfAborted();
            return [output];
        }
        const request = {
            markdown: metadata.body, html, css,
            renderFormat: args.renderFormat,
            frontMatter: args.frontMatter,
            customCss: args.customCss,
            imagePolicy,
            emit: args.stdout ? writeStdout : undefined,
            options: {
                ...(args.htmlOptions ?? DEFAULT_HTML_EXPORT_OPTIONS),
                embedImages: args.embedImages,
                convertLinkedMarkdown: args.linked,
                showOutlineSidebar: args.outline,
                saveWithoutDialog: false
            },
            documentPath: args.input,
            outputPath: output,
            overwrite: args.force === true,
            workspaceRoot: args.workspaceRoot ?? path.dirname(args.input),
            language: args.language,
            fontFamily,
            editorTheme: args.theme
        };
        // 文書収集、リンク書き換え、画像埋め込み、HTML書き出しは src/html.ts の出力処理へ任せる。
        const preparation = await prepareHtmlExport(request);
        if (!preparation) throw new Error('Output path was not selected.');
        if (!args.stdout) {
            await assertDistinctFiles(preparation.documents.map((document) => document.sourcePath),
                preparation.documents.map((document) => document.outputPath));
        }
        if (!args.force && !args.stdout) {
            for (const document of preparation.documents) {
                try {
                    await fs.stat(document.outputPath);
                    throw new Error(`Output already exists: ${document.outputPath}`);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
            }
        }
        const linked = await Promise.all(preparation.documents.slice(1).map(async (document) => {
            const rendered = await renderMarkdownFile(page, document.markdown, document.sourcePath, args);
            const output = await replaceOutput(page, rendered, replacementOptions, 'html', chooseDocumentTitle(
                document.frontMatterTitle,
                document.frontMatterTitle === undefined ? await readFirstHeading(page, rendered) : undefined,
                document.sourcePath));
            return { id: document.sourcePath, html: output.html, title: output.title };
        }));
        args.signal?.throwIfAborted();
        const result = await writePreparedHtml(request, preparation,
            [{ id: args.input, html, title: replaced.title }, ...linked], args.signal);
        args.signal?.throwIfAborted();
        return args.stdout ? [] : result.paths;
    } finally {
        args.signal?.removeEventListener('abort', abortContext);
        await context?.close().catch(() => undefined);
        if (!args.keepResources) await closeConversionResources();
    }
}

/** 変換で共有するMermaid描画ページとブラウザーを閉じる。未起動の場合は何もしない。 */
async function closeConversionResources(): Promise<void> {
    await closePeleRenderer();
    await closePdfBrowser();
}

/**
 * Edge と Chrome を自動検出できなかったときの CLI 向け案内。
 * 共通の汎用文言は VS Code の設定画面を前提にしているため、CLI では指定方法を示す文言へ置き換える。
 */
const CLI_BROWSER_UNAVAILABLE_MESSAGE = 'Could not start Microsoft Edge or Google Chrome. '
    + 'Install one of them, or pass a Chromium-based browser executable with --browser '
    + '(or browserPath in the configuration file). Causes:';

/**
 * 起動失敗の原因を 1 行に縮める。Playwright の例外は 2 行目以降に長い起動ログを含むため先頭行だけを使う。
 * 依存ライブラリ不足では先頭行が `Browser closed.` などの一般的な文言になり、ライブラリ名は起動ログ側に出るため、
 * 共有ライブラリの読み込み失敗を示す行があれば先頭行に添える。
 * @param error - 各ブラウザーチャンネルの起動で発生した例外。
 * @returns 先頭行 (必要なら共有ライブラリの失敗行を ` — ` で連結した文言)。空の場合は `unknown error`。
 */
function firstErrorLine(error: unknown): string {
    const lines = (error instanceof Error ? error.message : String(error)).split(/\r?\n/).map((line) => line.trim());
    const first = lines[0] || 'unknown error';
    const library = lines.find((line) => /error while loading shared libraries|cannot open shared object/i.test(line));
    return library && library !== first ? `${first} — ${library}` : first;
}

/**
 * 変換で発生した例外を、CLI の標準エラーへ書く文言にする。
 * ブラウザー自動検出の失敗では、インストール済みでも起動できない場合 (Linux の依存ライブラリ不足など) を
 * 利用者が判別できるよう、案内に続けて Edge / Chrome それぞれの失敗理由を 1 行ずつ添える。
 * @param error - convert などから伝わった例外。
 * @returns ブラウザー自動検出の失敗は CLI 向けの案内と原因、それ以外は例外の message (Error 以外は文字列化した値)。
 */
export function formatCliError(error: unknown): string {
    if (error instanceof PdfBrowserUnavailableError) {
        return `${CLI_BROWSER_UNAVAILABLE_MESSAGE}\n  Edge: ${firstErrorLine(error.edgeError)}`
            + `\n  Chrome: ${firstErrorLine(error.chromeError)}`;
    }
    return error instanceof Error ? error.message : String(error);
}

/** 中断時に表示する文言。ブラウザーを閉じたことによる内部の例外の文言を利用者へ見せないために統一する。 */
const INTERRUPTED_MESSAGE = 'Conversion was interrupted.';

/**
 * 中断後に資源の解放を待つ時間の上限（ミリ秒）。
 * Ctrl+Cはブラウザーにも届くため、起動中や終了処理の途中で強制終了されると、Playwrightの処理が完了しないことがある。
 * その場合でもCLIが止まり続けないよう、この時間を過ぎたら解放を待たずに終了する。
 */
const INTERRUPT_GRACE_MS = 5_000;

/**
 * 標準出力と標準エラーへ書いた内容が受け渡されるまで待つ。読み手が閉じていても待ち続けない。
 * パイプへの書き込みは非同期のため、`process.exit`の前に呼ばないと結果が失われる。
 */
async function flushStandardStreams(): Promise<void> {
    await Promise.all([process.stdout, process.stderr].map((stream) =>
        new Promise<void>((resolve) => { stream.write('', () => resolve()); })));
}

/** 1件の入力の変換結果。`--json`の出力形式であり、キーの削除や改名は互換性を壊す。 */
interface ConversionRecord {
    /** 入力ファイルの絶対パス。 */
    input: string;
    /** 書き込んだ出力ファイルの絶対パス。 */
    outputs: readonly string[];
    /** この入力で報告された警告。 */
    warnings: string[];
    /** 変換に失敗した場合のエラー文言。 */
    error?: string;
}

/**
 * 例外を終了コードへ変換する。
 * @param error - 発生した例外。
 * @param aborted - 中断の通知を受けている場合にtrue。
 * @returns 中断は130、引数・設定エラーは2、変換エラーは1。
 */
function exitCodeFor(error: unknown, aborted: boolean): number {
    if (aborted) return 130;
    return error instanceof Error && /^(Unknown argument|Missing value|Invalid |Input Markdown path|--format|--html-|Only one input|Configuration |rendering |pdf must|html must|browserPath must|workspaceRoot must|Unknown configuration|Unknown rendering)/.test(error.message)
        ? 2 : 1;
}

/**
 * 標準入力をすべてUTF-8文字列として読み込む。
 * @param signal - 読み込みを中断する通知。
 * @returns 読み込んだ本文。
 * @throws 標準入力が端末の場合（入力待ちで止まって見えることを防ぐ）、または中断された場合。
 */
async function readStdin(signal: AbortSignal): Promise<string> {
    if (process.stdin.isTTY) throw new Error('Invalid input: standard input is a terminal; pipe a document or pass a file.');
    /** 中断時は入力待ちを解除する。 */
    const onAbort = (): void => { process.stdin.destroy(); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        signal.throwIfAborted();
        return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
        // ストリームを閉じたことによる内部の例外（Premature close）ではなく、中断として報告する。
        signal.throwIfAborted();
        throw error;
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

/**
 * 利用者のCSSファイルを指定順に連結する。
 * 変換の開始前に読むことで、ファイルの誤指定を出力の書き込み前に報告する。
 * @param cssPaths - CSSファイルの絶対パス。
 * @returns 連結したCSS。指定がなければundefined。
 * @throws ファイルを読めない場合はファイルシステムのエラーを伝播する。
 */
async function readCustomCss(cssPaths: readonly string[] | undefined): Promise<string | undefined> {
    if (!cssPaths?.length) return undefined;
    const sheets = await Promise.all(cssPaths.map(async (file) => stripUtf8Bom(await fs.readFile(file, 'utf8'))));
    return sheets.join('\n');
}

/**
 * 変換対象の入力一覧と出力指定の組み合わせを検証する。
 * @param args - 設定を反映した変換要求。リンク先変換は設定ファイルでも有効になるため、設定の読み込み後に呼ぶ。
 * @param inputs - 展開済みの入力一覧。
 * @throws 複数入力と組み合わせられない指定の場合。先頭の`Invalid`により終了コード2になる。
 */
function assertInputCombination(args: Arguments, inputs: readonly string[]): void {
    if (args.stdout && args.linked) throw new Error('Invalid output: --html-linked cannot be combined with standard output.');
    if (inputs.length <= 1) return;
    if (args.stdout) throw new Error('Invalid output: multiple inputs cannot be written to standard output.');
    if (args.output) throw new Error('Invalid output: use --out-dir with multiple inputs.');
    if (args.title) throw new Error('Invalid title: --title applies to a single input.');
    // リンク先が別の入力と重なると、同じ出力を2回書くか既存ファイルのエラーになるため受け付けない。
    if (args.linked) throw new Error('Invalid input: --html-linked supports a single input.');
}

/**
 * 全入力を順に変換する。1件が失敗しても残りを続け、結果を入力ごとに記録する。
 * ブラウザーの起動は変換より桁違いに遅いため、全件で再利用する。
 * 失敗後は、壊れた状態のブラウザーを次の入力へ持ち越さないよう作り直す。
 * @param args - 設定を反映した変換要求。
 * @param inputs - 展開済みの入力一覧。
 * @param bases - `--out-dir`内の相対位置の基準にする、入力指定ごとのディレクトリ。
 * @param signal - 中断の通知。中断後は残りの入力を処理しない。
 * @param records - 処理した入力の結果を追加する配列。例外時も途中までの結果を残すため呼び出し側が所有する。
 * @throws 単一入力の失敗と中断は例外を伝播し、従来の文言と終了コードを保つ。
 */
async function convertAll(
    args: Arguments, inputs: readonly string[], bases: readonly string[], signal: AbortSignal, records: ConversionRecord[]
): Promise<void> {
    const batch = inputs.length > 1;
    const extension = '.' + args.format;
    const base = args.outDir ? commonDirectory(bases) : undefined;
    /** 入力ごとの明示的な出力先を返す。未指定なら入力の隣へ出力する既定の動作に任せる。 */
    const outputFor = (input: string): string | undefined =>
        args.outDir && base ? outputPathInDirectory(base, input, args.outDir, extension) : args.output;
    // 出力の重複（a.mdとa.textileなど）は1件も書き込む前に拒否する。
    if (batch) await assertDistinctFiles(inputs, inputs.map((input) => plannedOutput({ ...args, input, output: outputFor(input) })));
    try {
        for (const input of inputs) {
            const record: ConversionRecord = { input, outputs: [], warnings: [] };
            records.push(record);
            const label = batch ? `${input}: ` : '';
            try {
                record.outputs = await convert({
                    ...args, input, output: outputFor(input), signal, keepResources: true,
                    /** 警告を入力ごとに記録し、複数入力ではどの文書の警告かを付けて表示する。 */
                    onWarning: (message) => {
                        record.warnings.push(message);
                        console.warn(label + message);
                    }
                });
                signal.throwIfAborted();
                if (!args.json) for (const file of record.outputs) process.stdout.write(file + '\n');
            } catch (error) {
                record.error = signal.aborted ? INTERRUPTED_MESSAGE : formatCliError(error);
                if (!batch || signal.aborted) throw error;
                process.stderr.write(label + record.error + '\n');
                await closeConversionResources();
            }
        }
    } finally {
        await closeConversionResources();
    }
}

/** CLIを実行し、引数・設定エラーを2、変換エラーと--strictの警告を1、中断を130の終了コードへ変換する。 */
async function main(): Promise<void> {
    const controller = new AbortController();
    const argv = process.argv.slice(2);
    const records: ConversionRecord[] = [];
    let jsonReported = false;
    /** `--json`の結果を1度だけ出力する。通常の終了経路と猶予切れの経路が重なっても二重に書かない。 */
    const reportJson = (ok: boolean, error?: string): void => {
        if (jsonReported || !argv.includes('--json')) return;
        jsonReported = true;
        writeJsonResult(records, ok, error);
    };
    /**
     * 猶予時間内に資源を解放できなかった場合に、解放を待たず結果だけを出力して終了する。
     * 処理中だった入力は完了していないので中断として記録する。ブラウザーはPlaywrightの終了処理とCtrl+C自体で終了する。
     */
    const forceExit = async (): Promise<void> => {
        process.stderr.write(INTERRUPTED_MESSAGE + '\n');
        for (const record of records) {
            if (!record.outputs.length && !record.error) record.error = INTERRUPTED_MESSAGE;
        }
        reportJson(false, records.length ? undefined : INTERRUPTED_MESSAGE);
        await flushStandardStreams();
        process.exit(130);
    };
    /**
     * Node の既定の即時終了を抑え、変換の資源解放と結果の出力を待ってから 130 で終える。
     * 中断後も図の描画タイマーなどがイベントループに残るため、最後に明示的に終了する。
     * 解放が止まっても終了できるよう猶予時間を設け、2回目の中断では待たずに終了する。
     */
    const onInterrupt = () => {
        if (controller.signal.aborted) process.exit(130);
        controller.abort();
        setTimeout(() => { void forceExit(); }, INTERRUPT_GRACE_MS);
    };
    process.on('SIGINT', onInterrupt);
    // 読み手が先に閉じた場合（`| head`のEPIPE）の'error'イベントは、書き込みのコールバックより後にも発火する。
    // 未処理例外で一括変換が止まらないよう、すべての書き込みの間、監視を外さず残す。
    // EPIPEは無視する（変換結果のファイルには影響しないため）。`-o -`の失敗はwriteStdoutが報告する。
    // 容量不足など他の失敗では結果が欠けているため、成功として終わらせない。
    for (const stream of [process.stdout, process.stderr]) {
        stream.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code !== 'EPIPE') process.exitCode = 1;
        });
    }
    try {
        if (argv.includes('--version')) { process.stdout.write((await readPackageVersion()) + '\n'); return; }
        const parsed = parseArguments(argv);
        const args = parsed && await loadConfig(parsed, argv);
        if (!args) {
            process.stdout.write(usage);
            return;
        }
        const { files: inputs, bases } = args.inputPatterns
            ? await expandInputPatterns(args.inputPatterns, process.cwd())
            : { files: [args.input], bases: [path.dirname(args.input)] };
        assertInputCombination(args, inputs);
        const customCss = await readCustomCss(args.cssPaths);
        const markdown = args.stdin ? await readStdin(controller.signal) : undefined;
        await convertAll({ ...args, customCss, markdown }, inputs, bases, controller.signal, records);
        const warnings = records.reduce((count, record) => count + record.warnings.length, 0);
        if (records.some((record) => record.error)) process.exitCode = 1;
        if (args.strict && warnings > 0) {
            process.stderr.write(`${warnings} warning(s) treated as errors by --strict.\n`);
            process.exitCode = 1;
        }
        if (args.json) reportJson(process.exitCode !== 1 && !controller.signal.aborted);
    } catch (error) {
        const message = controller.signal.aborted ? INTERRUPTED_MESSAGE : formatCliError(error);
        process.stderr.write(message + '\n');
        process.exitCode = exitCodeFor(error, controller.signal.aborted);
        // 入力の処理を始めていれば各入力のerrorに記録済み。全体のerrorは変換が始まらなかった場合だけ使う。
        reportJson(false, records.length ? undefined : message);
    } finally {
        process.removeListener('SIGINT', onInterrupt);
    }
    if (controller.signal.aborted) {
        await flushStandardStreams();
        process.exit(130);
    }
}

/**
 * `--json`の結果を標準出力へ1行で書く。警告とエラーの文言は標準エラーにも出力済み。
 * @param results - 入力ごとの結果。
 * @param ok - 終了コードが0になる場合にtrue。
 * @param error - 入力に結び付かない全体のエラー（引数の誤りなど）。
 */
function writeJsonResult(results: readonly ConversionRecord[], ok: boolean, error?: string): void {
    process.stdout.write(JSON.stringify({ ok, results, ...(error === undefined ? {} : { error }) }) + '\n');
}

/**
 * 配布物に必ず含まれるpackage.jsonから、CLIが表示するバージョンを取得する。
 * @returns 公開パッケージのversion文字列。
 * @throws package.jsonを読めない場合、JSONが壊れている場合、versionが文字列でない場合に失敗する。
 */
async function readPackageVersion(): Promise<string> {
    const packagePath = path.resolve(assetDir, '..', 'package.json');
    const metadata = JSON.parse(await fs.readFile(packagePath, 'utf8')) as { version?: unknown };
    if (typeof metadata.version !== 'string' || metadata.version.length === 0) {
        throw new Error('Package version is missing.');
    }
    return metadata.version;
}

if (require.main === module) void main();
