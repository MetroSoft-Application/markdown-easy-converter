/**
 * @fileoverview MarkdownからHTML/PDFを出力するCLIのエントリポイント。
 * 引数と設定ファイルを検証し、HTML (src/html.ts) / PDF (src/pdf.ts) の出力処理を呼び出して、ブラウザー資源を解放する。
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { BrowserContext, Page } from 'playwright-core';
import { ensureHtmlExtension, prepareHtmlExport, writePreparedHtml } from './html';
import { acquirePdfBrowser, closePdfBrowser, PdfBrowserUnavailableError, renderPdf } from './pdf';
import { closePeleRenderer, renderPeleMermaid } from './runtime/peleMermaid';
import { MAX_MERMAID_IMAGE_BYTES, resolveMermaidImageSources } from './runtime/mermaidImages';
import { namespaceMermaidSvg } from './shared/mermaidSvg';
import { decodeLocalResourceSource } from './shared/resourceCheck';
import { DEFAULT_HTML_EXPORT_OPTIONS, DEFAULT_PDF_OPTIONS, PDF_PAPER_FORMATS, isTextReplacementPatternValid, normalizeHtmlExportSettings, normalizePdfOptions, type HtmlExportOptions, type PdfOptions } from './shared/protocol';
import { DEFAULT_FONT_FAMILY_STACK } from './shared/fontFamily';
import { hasMarpFrontMatterCandidate, isMarpMarkdown, stripMarpFrontMatter } from './shared/marpFrontMatter';
import { renderMarpMarkdown } from './renderer/marp/marpRenderer';
import { createMarpPdfExportContent } from './renderer/marp/marpPdfExport';
import { prepareExportHtml } from './shared/exportHtml';
import { printContentCss } from './shared/printContentCss';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './shared/messages';

/**
 * バンドルを直接読み込むテストが自動検出の失敗を組み立てられるよう再公開する。
 * package.json に main / exports はなく、公開 API として互換性を保証しない。
 */
export { PdfBrowserUnavailableError };

/** ファイル入力型CLIが受け付ける出力形式。 */
export type OutputFormat = 'html' | 'pdf';
/** HTML/PDF出力で使用できる見出しテーマ。 */
type Theme = 'dark' | 'light';
/** 変換処理が受け取る正規化済みのCLI引数。 */
export interface Arguments {
    input: string;
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
  --format html|pdf       Required output format
  -o, --output PATH       Output file (default: INPUT.html or INPUT.pdf)
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

/**
 * CLI引数を正規化済みの変換要求へ解析する。
 * @param argv - 実行ファイル名より後ろの引数。パスは解析処理内で解決する。
 * @returns 変換要求。ヘルプ表示が指定された場合はundefined。
 * @throws オプション、値、必須入力パスが無効な場合にErrorを送出する。
 */
export function parseArguments(argv: readonly string[]): Arguments | undefined {
    if (argv.includes('-h') || argv.includes('--help')) return undefined;
    let input: string | undefined;
    let output: string | undefined;
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
        if (!arg.startsWith('-')) {
            if (input !== undefined) throw new Error('Only one input file is supported.');
            input = arg;
            continue;
        }
        const value = argv[++index];
        if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
        switch (arg) {
            case '-o':
            case '--output':
                output = value;
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
    if (!input) throw new Error('Input Markdown path is required.');
    if (!format) throw new Error('--format html|pdf is required.');
    if (format === 'pdf' && (linked || outline || argv.includes('--html-embed-images') || argv.includes('--html-no-embed-images'))) {
        throw new Error('--html-embed-images, --html-no-embed-images, --html-linked, and --html-outline are HTML-only options.');
    }
    return { input: path.resolve(input), output: output && path.resolve(output), format,
        language, browserPath, workspaceRoot, theme, mermaidTheme, linked, embedImages, outline, force, configPath };
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
    if (pdf !== undefined) {
        validateFields('pdf', pdf, {
            format: (item) => string(item) && (PDF_PAPER_FORMATS as readonly unknown[]).includes(item),
            orientation: (item) => item === 'portrait' || item === 'landscape',
            margins: (item) => { validateFields('pdf.margins', item,
                { top: numeric, right: numeric, bottom: numeric, left: numeric }); return true; },
            header: string, footer: string,
            textReplacements: (item) => Array.isArray(item) && item.every((rule) => {
                const value = validateFields('pdf.textReplacements[]', rule,
                    { pattern: string, replacement: string });
                return string(value.pattern) && isTextReplacementPatternValid(value.pattern as string)
                    && string(value.replacement);
            }),
            fontFamily: string, bodyFontSize: numeric,
            headingFontSizes: (item) => { validateFields('pdf.headingFontSizes', item,
                { h1: numeric, h2: numeric, h3: numeric, h4: numeric, h5: numeric, h6: numeric }); return true; },
            codeFontSize: numeric, lineHeight: numeric, paragraphSpacing: numeric,
            saveWithoutDialog: boolean
        });
    }
    if (html !== undefined) validateFields('html', html, {
        embedImages: boolean, convertLinkedMarkdown: boolean,
        showOutlineSidebar: boolean, saveWithoutDialog: boolean
    });
}

/** Resolve JSON settings before touching any output file. */
async function loadConfig(args: Arguments, argv: readonly string[]): Promise<Arguments> {
    if (!args.configPath) return args;
    const base = path.dirname(args.configPath);
    let raw: unknown;
    try {
        raw = JSON.parse(await fs.readFile(args.configPath, 'utf8'));
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
        if (!['renderFormat', 'editorTheme', 'previewFontFamily', 'remoteImagesEnabled', 'mermaidTheme', 'mermaidFontSize', 'language'].includes(key)) {
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
    const pdf = config.pdf;
    const html = config.html;
    if (pdf !== undefined && (!pdf || typeof pdf !== 'object' || Array.isArray(pdf))) throw new Error('pdf must be an object.');
    if (html !== undefined && (!html || typeof html !== 'object' || Array.isArray(html))) throw new Error('html must be an object.');
    validateExportConfig(pdf, html);
    if (config.browserPath !== undefined && typeof config.browserPath !== 'string') throw new Error('browserPath must be a string.');
    if (config.workspaceRoot !== undefined && typeof config.workspaceRoot !== 'string') throw new Error('workspaceRoot must be a string.');
    return {
        ...args,
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
        const [root, target] = await Promise.all([fs.realpath(workspaceRoot), fs.realpath(name)]);
        const relative = path.relative(root, target);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return undefined;
        const stat = await fs.stat(target);
        if (!stat.isFile() || stat.size > MAX_MERMAID_IMAGE_BYTES) return undefined;
        return await fs.readFile(target);
    } catch {
        return undefined;
    }
}

/**
 * DOMPurifyを含む既存のブラウザーレンダラーを実行してから、既存のPele図表ワーカーを実行する。
 * HTMLでは有効なMarp設定だけを除いて通常のMarkdown出力を保ち、ブラウザー起動を繰り返さないようPageを再利用する。
 */
async function renderMarkdownFile(
    page: Page, markdown: string, sourceFile: string, args: Arguments
): Promise<string> {
    const renderFormat = args.renderFormat ?? (/\.textile$/i.test(sourceFile) ? 'textile' : 'mixed');
    const source = args.format === 'html' ? stripMarpFrontMatter(markdown, parseMarpFrontMatter) : markdown;
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
    }, { source, format: renderFormat, language: args.language,
        remoteImagesEnabled: args.remoteImagesEnabled ?? true });

    const diagrams = await page.evaluate((markup) => {
        const root = document.createElement('div');
        root.innerHTML = markup;
        return [...root.querySelectorAll<HTMLElement>('[data-mermaid-source]')].map((node) =>
            decodeURIComponent(node.dataset.mermaidSource ?? ''));
    }, html);
    if (!diagrams.length) return prepareExportHtml(html);

    const rendered = await Promise.all(diagrams.map(async (source, index) => {
        const result = await renderPeleMermaid(
            source, args.mermaidTheme === 'auto' ? 'default' : args.mermaidTheme,
            path.join(assetDir, 'pele-render-worker.js'),
            () => acquirePdfBrowser(args.language, args.browserPath), args.signal, {
                fontFamily: args.fontFamily ?? '',
                fontSize: args.mermaidFontSize,
                resourceScope: sourceFile,
                resolveImages: (sources, signal) => resolveMermaidImageSources(
                    sources,
                    (image) => readDiagramLocalImage(image, sourceFile, args.workspaceRoot ?? path.dirname(sourceFile)),
                    signal
                )
            }
        );
        return namespaceMermaidSvg(result.svg, `cli-${index}`);
    }));
    return prepareExportHtml(await page.evaluate(({ markup, svgs }) => {
        const root = document.createElement('div');
        root.innerHTML = markup;
        const nodes = root.querySelectorAll<HTMLElement>('[data-mermaid-source]');
        nodes.forEach((node, index) => {
            node.innerHTML = svgs[index];
            node.setAttribute('data-mermaid-status', 'ready');
        });
        return root.innerHTML;
    }, { markup: html, svgs: rendered }));
}

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
 * Mermaidコードを残したまま成功とみなさず、Peleが失敗した場合は出力を中断する。
 */
async function renderMarpPdf(
    page: Page, markdown: string, sourceFile: string, args: Arguments
): Promise<{ html: string; css: string }> {
    const rendered = renderMarpMarkdown(markdown, '');
    const slides: string[] = [];
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
        const svgs = await Promise.all(blocks.map(async (block) => {
            const result = await renderPeleMermaid(
                block.source, args.mermaidTheme === 'auto' ? 'default' : args.mermaidTheme,
                path.join(assetDir, 'pele-render-worker.js'),
                () => acquirePdfBrowser(args.language, args.browserPath), args.signal, {
                    fontFamily: args.fontFamily ?? '',
                    fontSize: args.mermaidFontSize,
                    resourceScope: sourceFile,
                    resolveImages: (sources, signal) => resolveMermaidImageSources(
                        sources,
                        (image) => readDiagramLocalImage(image, sourceFile, args.workspaceRoot ?? path.dirname(sourceFile)),
                        signal
                    )
                }
            );
            return namespaceMermaidSvg(result.svg, `cli-marp-${index}-${block.position}`);
        }));
        slides.push(await page.evaluate(({ markup, positions, diagrams }) => {
            const root = document.createElement('div');
            root.innerHTML = markup;
            const pre = [...root.querySelectorAll('pre')];
            positions.forEach((position, blockIndex) => {
                const container = document.createElement('div');
                container.className = 'mve-marp-mermaid';
                container.setAttribute('role', 'img');
                container.innerHTML = diagrams[blockIndex];
                pre[position]?.replaceWith(container);
            });
            return root.innerHTML;
        }, { markup: slide, positions: blocks.map((block) => block.position), diagrams: svgs }));
    }
    const content = createMarpPdfExportContent(slides, rendered.css);
    if (!content) throw new Error('Marp document contains no slides.');
    return { html: content.html, css: content.css };
}

/**
 * 出力時だけ置換Workerを読み込み、本文・属性とPDF見出しを同じ順で書き換える。
 * @param page - Markdownの描画にも使用したブラウザーページ。
 * @param html - 描画済み本文。
 * @param options - PDFとHTMLで共有する置換設定。
 * @param format - PDFの場合だけヘッダーとフッターを対象にする。
 */
async function replaceOutput(
    page: Page, html: string, options: PdfOptions, format: OutputFormat
): Promise<{ html: string; options: PdfOptions }> {
    if (!options.textReplacements.some((rule) => rule.pattern.length > 0)) return { html, options };
    await page.addScriptTag({ path: path.join(assetDir, 'output-replacements.js') });
    const result = await page.evaluate(async ({ markup, rules, header, footer }) => {
        const replacement = (globalThis as unknown as {
            mveOutputReplacements?: {
                replaceOutputHtml: (html: string, rules: PdfOptions['textReplacements'],
                    header: string, footer: string) => Promise<{ html: string; header: string; footer: string }>;
            }
        }).mveOutputReplacements;
        if (!replacement) throw new Error('Output replacement renderer was not loaded.');
        return replacement.replaceOutputHtml(markup, rules, header, footer);
    }, { markup: html, rules: options.textReplacements,
        header: format === 'pdf' ? options.header : '', footer: format === 'pdf' ? options.footer : '' });
    return { html: result.html, options: format === 'pdf'
        ? { ...options, header: result.header, footer: result.footer } : options };
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
 * 1件の原文を描画し、HTML/PDFの保存と共有資源の解放を完了する。
 * @param args - 検証済みの変換要求。
 * @returns 書き込み済みの出力パス。
 */
async function convertExclusive(args: Arguments): Promise<readonly string[]> {
    args.signal?.throwIfAborted();
    if (args.markdown === undefined) {
        const inputStat = await fs.stat(args.input);
        if (!inputStat.isFile()) throw new Error('Input must be a file.');
    }
    const requestedOutput = args.output ?? args.input.replace(/\.[^.\\/]+$/, '') + '.' + args.format;
    const output = args.format === 'html' ? ensureHtmlExtension(requestedOutput) : requestedOutput;
    await assertDistinctFiles([args.input], [output]);
    if (!args.force) {
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
    try {
        const browser = await acquirePdfBrowser(args.language, args.browserPath);
        args.signal?.throwIfAborted();
        context = await browser.newContext({ javaScriptEnabled: true });
        args.signal?.addEventListener('abort', abortContext, { once: true });
        args.signal?.throwIfAborted();
        const page = await context.newPage();
        await page.addScriptTag({ path: path.join(assetDir, 'markdown-fallback.js') });
        const markdown = args.markdown ?? await fs.readFile(args.input, 'utf8');
        const marp = args.format === 'pdf' && hasMarpFrontMatterCandidate(markdown)
            && isMarpMarkdown(markdown, parseMarpFrontMatter);
        const marpContent = marp ? await renderMarpPdf(page, markdown, args.input, args) : undefined;
        const renderedHtml = marpContent?.html ?? await renderMarkdownFile(page, markdown, args.input, args);
        const replacementOptions = args.pdfOptions ?? DEFAULT_PDF_OPTIONS;
        const replaced = await replaceOutput(page, renderedHtml, replacementOptions, args.format);
        const html = replaced.html;
        const fontFamily = args.fontFamily ?? DEFAULT_FONT_FAMILY_STACK;
        const css = (marpContent?.css ? marpContent.css + '\n' : '') + printContentCss(fontFamily) + '\n'
            + await fs.readFile(path.join(assetDir, 'print-assets.css'), 'utf8');
        if (args.format === 'pdf') {
            const pdf = await renderPdf({
                html, css,
                documentPath: args.input,
                browserPath: args.browserPath,
                options: replaced.options,
                editorTheme: args.theme,
                language: args.language,
                signal: args.signal,
                preferCssPageSize: marpContent !== undefined
            });
            args.signal?.throwIfAborted();
            await fs.mkdir(path.dirname(output), { recursive: true });
            await fs.writeFile(output, pdf, { flag: args.force ? 'w' : 'wx', signal: args.signal });
            args.signal?.throwIfAborted();
            return [output];
        }
        const request = {
            markdown, html, css,
            options: { ...(args.htmlOptions ?? DEFAULT_HTML_EXPORT_OPTIONS),
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
        await assertDistinctFiles(preparation.documents.map((document) => document.sourcePath),
            preparation.documents.map((document) => document.outputPath));
        if (!args.force) {
            for (const document of preparation.documents) {
                try {
                    await fs.stat(document.outputPath);
                    throw new Error(`Output already exists: ${document.outputPath}`);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
            }
        }
        const linked = await Promise.all(preparation.documents.slice(1).map(async (document) => ({
            id: document.sourcePath,
            html: (await replaceOutput(page,
                await renderMarkdownFile(page, document.markdown, document.sourcePath, args),
                replacementOptions, 'html')).html
        })));
        args.signal?.throwIfAborted();
        const result = await writePreparedHtml(request, preparation, linked, args.signal);
        args.signal?.throwIfAborted();
        return result.paths;
    } finally {
        args.signal?.removeEventListener('abort', abortContext);
        await context?.close().catch(() => undefined);
        await closePeleRenderer();
        await closePdfBrowser();
    }
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

/** CLIを実行し、引数・設定エラーを2、変換エラーを1、中断を130の終了コードへ変換する。 */
async function main(): Promise<void> {
    const controller = new AbortController();
    /** Node の既定の即時終了を抑え、変換の資源解放を待って 130 を返す。 */
    const onInterrupt = () => controller.abort();
    process.on('SIGINT', onInterrupt);
    try {
        const argv = process.argv.slice(2);
        if (argv.includes('--version')) { process.stdout.write((await readPackageVersion()) + '\n'); return; }
        const parsed = parseArguments(argv);
        const args = parsed && await loadConfig(parsed, argv);
        if (!args) {
            process.stdout.write(usage);
            return;
        }
        const written = await convert({ ...args, signal: controller.signal });
        controller.signal.throwIfAborted();
        for (const file of written) process.stdout.write(file + '\n');
    } catch (error) {
        process.stderr.write(formatCliError(error) + '\n');
        process.exitCode = controller.signal.aborted ? 130
            : error instanceof Error && /^(Unknown argument|Missing value|Invalid |Input Markdown path|--format|--html-|Only one input|Configuration |rendering |pdf must|html must|browserPath must|workspaceRoot must|Unknown configuration|Unknown rendering)/.test(error.message)
            ? 2 : 1;
    } finally {
        process.removeListener('SIGINT', onInterrupt);
    }
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
