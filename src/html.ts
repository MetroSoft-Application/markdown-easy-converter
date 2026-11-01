/**
 * @fileoverview 独立CLIが所有するHTML出力処理。設定・リンク・画像を反映してHTMLを書き出す。
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeHTMLAttribute } from 'entities';
import { Marked, Renderer } from 'marked';
import { getMessages } from './shared/messages';
import { DEFAULT_PDF_OPTIONS, type EditorTheme, type HtmlExportOptions } from './shared/protocol';
import { fontFamilyForCss } from './shared/fontFamily';
import { escapeHtml } from './shared/escapeHtml';
import { footnoteDefinitionSyntax, mathBlockSyntax, tableOfContentsSyntax } from './shared/markdownBlockSyntax';
import {
    collectLocalResourceReferences,
    getOutlineForFormatSource,
    nextHeadingAnchorId,
    WORKSPACE_SECTION_LINK_TITLE,
    type OutlineItem
} from './shared/markdown';
import { renderTextile } from './shared/textileAdapter';
import { isDocumentRelativeResourcePath, workspaceRootPathSegments } from './shared/resourceLink';
import { decodeLocalResourceSource } from './shared/resourceCheck';

/**
 * HTMLで送受信するメッセージまたは要求のデータ形状。
 */
export interface HtmlExportRequest {

    /**
     * 解析・編集・変換の対象となるMarkdown本文。
     */
    markdown: string;

    /**
     * 表示または出力するHTML本文。
     */
    html: string;

    /**
     * HTMLで解析・表示・保存する本文。
     */
    css: string;

    /**
     * HTML出力の見出し色を選ぶ編集テーマ。省略時はダークテーマとして扱う。
     */
    editorTheme?: EditorTheme;

    /**
     * 呼び出し側が指定する処理設定。
     */
    options: HtmlExportOptions;

    /**
     * HTMLで読み書きするリソースの場所。
     */
    documentPath: string;
    /** Destination selected by the caller, independently of any editor dialog. */
    outputPath: string;
    /** trueの場合だけ既存HTMLを上書きする。省略時は排他的な新規作成で既存内容を保護する。 */
    overwrite?: boolean;
    /** Root used for slash-prefixed workspace links. */
    workspaceRoot: string;

    /**
     * HTMLで扱うlanguageの文字列。
     */
    language: string;

    /**
     * HTMLで共有するフォント設定または移行状態。
     */
    fontFamily?: string;
}

/**
 * HTMLの処理結果と失敗時情報のデータ形状。
 */
export interface HtmlExportResult {

    /**
     * 出力HTMLファイルを保存する最終パス。
     */
    target: string;

    /**
     * HTMLで扱うpathsの一覧。
     */
    paths: string[];
}

/**
 * 元文書のURI、ファイルパス、HTML化するMarkdown本文を保持します。
 */
export interface HtmlDocument {

    /**
     * ブラウザーが扱うリソースURI。
     */
    uri: string;

    /**
     * HTMLで読み書きするリソースの場所。
     */
    sourcePath: string;

    /**
     * 解析・編集・変換の対象となるMarkdown本文。
     */
    markdown: string;

    /**
     * 表示または出力するHTML本文。
     */
    html: string;

    /**
     * HTMLで読み書きするリソースの場所。
     */
    outputPath: string;
}

/**
 * 保存先URIと、HTML化する文書一覧をまとめた準備情報です。
 */
export interface HtmlExportPreparation {

    /**
     * export処理が保存先として選んだHTMLファイルのURI。
     */
    target: string;

    /**
     * 文書URIと開いている文書オブジェクトの対応表。
     */
    documents: HtmlDocument[];
}

/**
 * HTML文書の識別子と、レンダリング済みHTML本文です。
 */
export interface HtmlRenderedDocument {

    /**
     * HTMLで扱うidの文字列。
     */
    id: string;

    /**
     * 表示または出力するHTML本文。
     */
    html: string;
}

/**
 * HTMLの保存先を決定し、出力対象のローカル文書を収集する。
 * @param request - HTML本文・CSS・元文書URI・言語・フォント・出力設定をまとめた要求。
 * @returns 書き出し用HTMLと関連文書を準備した結果。保存をキャンセルした場合はundefined。
 */
export async function prepareHtmlExport(request: HtmlExportRequest): Promise<HtmlExportPreparation | undefined> {
    const targetPath = ensureHtmlExtension(request.outputPath);
    return {
        target: targetPath,
        documents: await collectDocuments(request, targetPath)
    };
}

/**
 * 検査済みの出力計画を保存し、overwriteがtrueでない限り既存ファイルを保護する。
 * @param request - HTML本文・CSS・元文書URI・言語・フォント・出力設定をまとめた要求。
 * @param preparation - HTML保存先URIと、出力対象文書のレコード一覧。
 * @param renderedDocuments - リンク先文書をCLIで描画した識別子付きHTMLの一覧。
 * @param signal - 中断時に残りのファイル書き込みを止める通知。
 * @returns 保存したHTMLファイルのURIと、出力で参照するファイルURI一覧。
 */
export async function writePreparedHtml(
    request: HtmlExportRequest,
    preparation: HtmlExportPreparation,
    renderedDocuments: readonly HtmlRenderedDocument[] = [],
    signal?: AbortSignal
): Promise<HtmlExportResult> {
    const renderedById = new Map(renderedDocuments.map(
        /**
         * 各documentから識別子を取り出して一覧化する。
         * @param document - CLIで描画された識別子とHTML本文を持つ結果レコード。
         * @returns 識別子を取り出した変換結果の一覧。
         */
        (document) => [normalizePath(document.id), document.html]));
    const documents = preparation.documents.map(
        (document) => ({
            ...document,
            html: renderedById.get(normalizePath(document.sourcePath)) ?? document.html
        }));
    const output = await Promise.all(documents.map(
        /**
         * 各documentからhtmlを取り出して一覧化する。
         * @param document - HTMLファイルとして書き出す文書レコード。
         * @returns htmlを取り出した変換結果の一覧。
         */
        async (document) => {
            signal?.throwIfAborted();
            const body = await rewriteBody(
                document.html,
                document.sourcePath,
                document.outputPath,
                documents,
                request.options,
                request.language,
                request.workspaceRoot
            );
            const standalone = buildStandaloneHtml(
                body,
                request.css,
                request.language,
                document.markdown,
                request.options,
                request.fontFamily,
                getHtmlRenderFormat(document.sourcePath),
                request.editorTheme
            );
            signal?.throwIfAborted();
            await fs.mkdir(path.dirname(document.outputPath), { recursive: true });
            signal?.throwIfAborted();
            await fs.writeFile(document.outputPath, standalone, {
                encoding: 'utf8', flag: request.overwrite ? 'w' : 'wx', signal
            });
            signal?.throwIfAborted();
            return document.outputPath;
        }));

    signal?.throwIfAborted();

    return {
        target: preparation.target,
        paths: output
    };
}

/**
 * ルート文書とリンク先文書を収集し、各文書のHTML出力先と本文を決定する。
 * @param request - HTML本文・CSS・元文書URI・言語・フォント・出力設定をまとめた要求。
 * @param targetPath - ルートHTMLの保存先ファイルパス。
 * ソースURIと出力パスを持つ、重複を除いたHTML出力対象文書一覧。
 */
async function collectDocuments(request: HtmlExportRequest, targetPath: string): Promise<HtmlDocument[]> {
    const documents: HtmlDocument[] = [];
    const byPath = new Map<string, HtmlDocument>();
    const rootPath = path.resolve(request.documentPath);
    const root = {
        uri: rootPath,
        sourcePath: rootPath,
        markdown: request.markdown,
        html: request.html,
        outputPath: targetPath
    } satisfies HtmlDocument;
    documents.push(root);
    if (!request.options.convertLinkedMarkdown || !rootPath) return documents;
    byPath.set(normalizePath(rootPath), root);

    for (let index = 0; index < documents.length; index += 1) {
        const document = documents[index];
        const references = collectLocalResourceReferences(document.markdown)
            .filter(
                /**
                 * 種別「link」のreferenceだけを残す。
                * @param reference - Markdown本文から見つけたリンクまたはリソース参照。

                 */
                (reference) => reference.kind === 'link');
        for (const reference of references) {
            const linkedUri = resolveLocalFileUri(
                document.uri,
                reference.source,
                reference.workspaceRooted === true,
                request.workspaceRoot
            );
            if (!linkedUri || !isMarkdownPath(linkedUri)) continue;
            const linkedPath = normalizePath(linkedUri);
            if (byPath.has(linkedPath)) continue;
            let markdown: string;
            try {
                markdown = await fs.readFile(linkedUri, 'utf8');
            } catch {
                // 存在しないリンクは元のリンクを残し、他のページの変換を継続する。
                continue;
            }
            const linkedDocument: HtmlDocument = {
                uri: linkedUri,
                sourcePath: linkedUri,
                markdown,
                html: renderLinkedMarkdown(markdown, getHtmlRenderFormat(linkedUri)),
                outputPath: outputPathFor(linkedUri, rootPath, targetPath)
            };
            byPath.set(linkedPath, linkedDocument);
            documents.push(linkedDocument);
        }
    }
    return documents;
}

/**
 * Markdownを見出しアンカーとローカル参照情報を含むHTMLへ描画する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @param format - MarkdownまたはTextile文書の描画形式。
 * @returns リンク先文書のHTML本文。CLIで再描画した結果があれば出力前に置換する。
 */
function renderLinkedMarkdown(markdown: string, format: 'markdown' | 'mixed' | 'textile'): string {
    if (format === 'textile') return renderTextile(markdown);
    const parser = new Marked({ gfm: true });
    const renderer = new Renderer();
    const headingIds = new Map<string, number>();
    const usedHeadingIds = new Set<string>();
    renderer.heading =
        /**
         * Markdown見出しを同じリンクID付きHTMLへ変換する。
         * @param heading - Markedから受け取った見出しtoken。
         * @returns HTMLの見出し要素。
         */
        function (heading) {
            const { depth, tokens } = heading;
            const id = nextHeadingAnchorId(tokens.map((token) => token.raw).join(''), headingIds, usedHeadingIds);
            const content = this.parser.parseInline(tokens)
                .replace(/\s+\{#[^}]+\}(?=(?:<\/span>)*\s*$)/, '');
            return `<h${depth} id="${escapeAttribute(id)}">${content}</h${depth}>`;
        };
    renderer.image =
        /**
         * HTMLの入力を検証し、表示または保存に使う形式へ変換する。
         * @param image - Markedから受け取った画像トークン。href、title、textをimg要素へ反映する。
         * @returns HTMLで利用するimg要素。
         */
        (image) => {
            const { href, title, text } = image;
            const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : '';
            return `<img src="${escapeAttribute(href)}" data-original-src="${escapeAttribute(href)}" alt="${escapeAttribute(text)}"${titleAttribute}>`;
        };
    renderer.link =
        /**
         * MarkdownリンクをHTMLへ変換し、ワークスペース基準リンクの識別情報を保持する。
         * @param link - Markedから受け取ったリンクトークン。
         * @returns HTMLのa要素。
         */
        function (link) {
            const { href, title, tokens } = link;
            const workspaceRooted = title === WORKSPACE_SECTION_LINK_TITLE;
            const titleAttribute = title && !workspaceRooted ? ` title="${escapeAttribute(title)}"` : '';
            const workspaceAttribute = workspaceRooted ? ' data-mve-workspace-rooted="true"' : '';
            const content = this.parser.parseInline(tokens);
            return `<a href="${escapeAttribute(href)}"${workspaceAttribute}${titleAttribute}>${content}</a>`;
        };
    parser.setOptions({ renderer });
    parser.use({
        extensions: [
            {
                ...mathBlockSyntax(),
                renderer(token) {
                    const text = typeof token === 'object' && token !== null
                        && 'text' in token && typeof token.text === 'string'
                        ? token.text
                        : '';
                    return `<pre class="math-block">${escapeAttribute(text)}</pre>`;
                }
            },
            {
                ...tableOfContentsSyntax(),
                renderer() {
                    return '<p>[toc]</p>';
                }
            },
            {
                ...footnoteDefinitionSyntax(),
                renderer() {
                    return '';
                }
            }
        ]
    });
    return String(parser.parse(markdown));
}

/**
 * HTML本文、スタイル、言語、フォントを使って単体表示用HTMLを組み立てる。
 * @param body - main要素内へ挿入する変換済みHTML本文。
 * @param css - head内のstyle要素へ挿入するスタイルシート。
 * @param language - html要素のlang属性に設定する言語コード。
 * @param markdown - HTML本文の元になったMarkdown。アウトライン生成に使う。
 * @param options - HTML出力時の画像・リンク・アウトライン表示設定。
 * @param fontFamily - 生成HTMLの本文へ適用するフォントファミリー。
 * @param renderFormat - アウトラインを作るMarkdownまたはTextileの描画形式。
 * @param editorTheme - 白いHTML背景で見出しを判読できる色を選ぶテーマ。未指定時はダークテーマ。
 * @returns 単体で表示・保存できるHTML文書。
 */
function buildStandaloneHtml(
    body: string,
    css: string,
    language: string,
    markdown: string,
    options: HtmlExportOptions,
    fontFamily?: string,
    renderFormat: 'markdown' | 'mixed' | 'textile' = 'markdown',
    editorTheme: EditorTheme = 'dark'
): string {
    const safeCss = css.replace(/<\/style/gi, '<\\/style');
    const safeFontFamily = fontFamilyForCss(fontFamily, DEFAULT_PDF_OPTIONS.fontFamily);
    const main = `<main class="mve-html">${body}</main>`;
    const content = options.showOutlineSidebar
        ? `<div class="mve-html-layout mve-html-layout-with-outline">${buildHtmlOutlineSidebar(markdown, language, renderFormat)}${buildHtmlOutlineResizer(language)}${buildHtmlOutlineShowButton(language)}${main}</div>`
        : main;
    const outlineResizeScript = options.showOutlineSidebar ? `<script>${HTML_OUTLINE_RESIZER_SCRIPT}</script>` : '';
    return `<!doctype html><html lang="${escapeAttribute(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${safeCss}\n${HTML_CSS(safeFontFamily, editorTheme)}</style></head><body>${content}${outlineResizeScript}</body></html>`;
}

/** HTML出力用アウトラインの階層を保持する。 */
interface HtmlOutlineNode {
    /** getOutline が返すMarkdown見出し情報。 */
    item: OutlineItem;
    /** 現在の見出し配下に属する子見出し。 */
    children: HtmlOutlineNode[];
}

/**
 * getOutline が返す平坦なアウトラインを、見出しレベルに従ってツリー化する。
 * @param outline getOutlineで抽出した文書順の見出し一覧。
 * @returns HTMLサイドバー描画用の階層化された見出し。
 */
function buildHtmlOutlineTree(outline: readonly OutlineItem[]): HtmlOutlineNode[] {
    const roots: HtmlOutlineNode[] = [];
    const ancestors: HtmlOutlineNode[] = [];
    for (const item of outline) {
        while (ancestors.length && ancestors[ancestors.length - 1].item.level >= item.level) {
            ancestors.pop();
        }
        const node: HtmlOutlineNode = { item, children: [] };
        const parent = ancestors[ancestors.length - 1];
        if (parent) parent.children.push(node);
        else roots.push(node);
        ancestors.push(node);
    }
    return roots;
}

/**
 * アウトラインツリーを見出しアンカーへのリンク一覧へ変換する。
 * @param nodes 描画するアウトライン階層。
 * @param root 最上位リストならtrue。
 * @returns ネストしたul/li/aからなる安全なHTML。
 */
function renderHtmlOutlineNodes(nodes: readonly HtmlOutlineNode[], root = true): string {
    if (!nodes.length) return '';
    const className = root ? 'mve-html-outline-tree' : 'mve-html-outline-children';
    return `<ul class="${className}">${nodes.map((node) => {
        const href = `#${encodeURIComponent(node.item.id)}`;
        return `<li data-outline-level="${node.item.level}"><a href="${escapeAttribute(href)}">${escapeHtml(node.item.text)}</a>${renderHtmlOutlineNodes(node.children, false)}</li>`;
    }).join('')}</ul>`;
}

/**
 * getOutline の結果からHTML出力用サイドバーを作る。
 * @param markdown 出力文書の元Markdown。
 * @param language アウトライン見出し文言に使う表示言語。
 * @param renderFormat MarkdownまたはTextileの見出し認識形式。
 * @returns HTML本文の左側へ配置するアウトラインaside。
 */
function buildHtmlOutlineSidebar(markdown: string, language: string, renderFormat: 'markdown' | 'mixed' | 'textile'): string {
    const messages = getMessages(language).app;
    const outline = getOutlineForFormatSource(markdown, renderFormat);
    const content = outline.length
        ? `<nav aria-label="${escapeAttribute(messages.outline)}">${renderHtmlOutlineNodes(buildHtmlOutlineTree(outline))}</nav>`
        : `<p class="mve-html-outline-empty">${escapeHtml(messages.noHeadings)}</p>`;
    const hideLabel = escapeAttribute(messages.hideOutline);
    return `<aside class="mve-html-outline" aria-label="${escapeAttribute(messages.outline)}"><div class="mve-html-outline-header"><span>${escapeHtml(messages.outline)}</span><button class="mve-html-outline-toggle mve-html-outline-hide" type="button" aria-label="${hideLabel}" title="${hideLabel}" aria-expanded="true">×</button></div>${content}</aside>`;
}

/** HTMLアウトラインのサイズを操作するセパレーターを作る。 */
function buildHtmlOutlineResizer(language: string): string {
    const label = escapeAttribute(getMessages(language).app.outlineWidth);
    return `<div class="mve-html-outline-resizer" role="separator" aria-label="${label}" aria-orientation="vertical" aria-valuemin="160" aria-valuemax="480" aria-valuenow="240" tabindex="0"></div>`;
}

/** アウトライン非表示中に、再表示できる操作ボタンを作る。 */
function buildHtmlOutlineShowButton(language: string): string {
    const label = getMessages(language).app.showOutline;
    const safeLabel = escapeAttribute(label);
    return `<button class="mve-html-outline-toggle mve-html-outline-show" type="button" aria-label="${safeLabel}" title="${safeLabel}" aria-expanded="true" hidden><span class="mve-html-outline-show-icon" aria-hidden="true"></span></button>`;
}

/**
 * body内の画像・文書リンクを出力先相対参照や埋め込みデータへ書き換える。
 * @param html - 表示または出力するHTML本文。
 * @param sourcePath - 変換するHTML内の相対参照を解決するリンク元ファイルパス。
 * @param outputPath - 書き換え後の相対リンクの基準となる生成HTMLの保存先パス。
 * @param documents - 現在のHTML出力に含まれるHtmlDocument一覧。リンク先Markdownの出力先解決に使う。
 * @param options - 画像を埋め込むか、リンク先MarkdownをHTML化するかを指定するHTML出力設定。

 */
async function rewriteBody(
    html: string,
    sourcePath: string,
    outputPath: string,
    documents: HtmlDocument[],
    options: HtmlExportOptions,
    language: string,
    workspaceRoot: string
): Promise<string> {
    let result = stripUnsafeMarkup(html);
    const imageTags = [...result.matchAll(/<img\b[^>]*>/gi)].map(
        /**
         * 各matchを変換して一覧化する。
         * @param match - img開始タグに一致した正規表現のMatch。match[0]にタグ全体を含む。

         */
        (match) => match[0]);
    for (const tag of imageTags) {
        const replacement = await rewriteImageTag(tag, sourcePath, outputPath, options);
        result = result.replace(tag, replacement);
    }
    result = result.replace(/<a\b[^>]*>/gi,
        /**
         * @param tag - 書き換えるa要素のHTMLタグ全体。

         */
        (tag) => rewriteLinkTag(tag, sourcePath, outputPath, documents, options, workspaceRoot));
    result = result.replace(
        /\sdata-(?:original-src|mve-[\w-]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi,
        /** 出力で折り返し方を決める2属性だけを残し、他の描画用内部属性を除く。 */
        (attribute) => /^\s+data-mve-short-value-(?:candidate|label)\s*=\s*(?:"true"|'true'|true)$/i.test(attribute)
            ? attribute
            : ''
    );
    return addSectionLinks(result, language);
}

/**
 * 出力HTMLの各見出しに一意なIDと、見出しへ移動するリンクを追加する。
 * @param html - 画像・文書リンクを書き換えた本文HTML。
 * @param language - HTML文書に設定する言語コード。
 * @returns セクションリンクを追加した本文HTML。
 */
function addSectionLinks(html: string, language: string): string {
    const label = getMessages(language).app.sectionAnchorLink;
    const usedIds = new Set<string>();
    const firstIdOffsets = new Map<string, number>();
    const htmlForStructureScan = maskMarkupInsideAttributes(maskNonElementHtml(html));
    for (const match of htmlForStructureScan.matchAll(/<[a-z][\w:-]*\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
        const id = decodeHtmlEntities(readExactAttribute(match[1], 'id'));
        if (id) {
            usedIds.add(id);
            if (!firstIdOffsets.has(id)) firstIdOffsets.set(id, match.index ?? 0);
        }
    }
    const headingIdCounts = new Map<string, number>();
    const output: string[] = [];
    const headingPattern = /<h([1-6])\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/h\1\s*>/gi;
    let cursor = 0;
    for (const match of htmlForStructureScan.matchAll(headingPattern)) {
        const offset = match.index ?? cursor;
        const headingEnd = offset + match[0].length;
        const originalHeading = html.slice(offset, headingEnd);
        const originalMatch = /^<h([1-6])\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*)<\/h\1\s*>$/i.exec(originalHeading);
        output.push(html.slice(cursor, offset));
        if (!originalMatch) {
            output.push(originalHeading);
            cursor = headingEnd;
            continue;
        }
        const level = originalMatch[1];
        const attributes = originalMatch[2];
        const content = originalMatch[3];
        let headingAttributes = attributes;
        let id = decodeHtmlEntities(readExactAttribute(headingAttributes, 'id'));
        if (!id || (firstIdOffsets.get(id) ?? offset) < offset) {
            id = nextHeadingAnchorId(headingTextFromHtml(content), headingIdCounts, usedIds);
            headingAttributes = setExactAttribute(headingAttributes, 'id', id);
        }
        const href = `#${encodeURIComponent(id)}`;
        const headingContent = removeLegacySectionMarker(content, href);
        const linkedContent = linkHeadingContent(headingContent, href, label);
        output.push(`<h${level}${headingAttributes}>${linkedContent}</h${level}>`);
        cursor = headingEnd;
    }
    output.push(html.slice(cursor));
    return output.join('');
}

/**
 * コメントとraw-text要素の中身を、元の文字位置を保ったまま空白に置き換える。
 * @param html - IDを収集するHTML断片。
 * @returns 実際の開始タグだけを残したHTML断片。
 */
function maskNonElementHtml(html: string): string {
    let masked = html.replace(
        /<!--[\s\S]*?-->|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|template)\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/\1\s*>/gi,
        (content) => {
            if (content.startsWith('<!--')) return content.replace(/[^\r\n]/g, ' ');
            const openingEnd = findHtmlTagEnd(content, 0);
            if (openingEnd < 0) return content;
            return `${content.slice(0, openingEnd)}${content.slice(openingEnd).replace(/[^\r\n]/g, ' ')}`;
        }
    );
    const plaintextStart = /<plaintext\b(?:"[^"]*"|'[^']*'|[^'">])*>/i.exec(masked);
    if (plaintextStart) {
        const offset = plaintextStart.index + plaintextStart[0].length;
        masked = `${masked.slice(0, offset)}${masked.slice(offset).replace(/[^\r\n]/g, ' ')}`;
    }
    return masked;
}

/**
 * タグ属性値の中にあるタグ風文字列を、元の文字位置を保ったまま無効化する。
 * @param html - コメントとraw-text要素を除外したHTML断片。
 * @returns 属性値中の不等号を空白に置き換えたHTML断片。
 */
function maskMarkupInsideAttributes(html: string): string {
    const characters = html.split('');
    let cursor = 0;
    while (cursor < html.length) {
        const start = html.indexOf('<', cursor);
        if (start < 0) break;
        const end = findHtmlTagEnd(html, start);
        if (end < 0) {
            cursor = start + 1;
            continue;
        }
        let quote: string | undefined;
        for (let index = start + 1; index < end - 1; index += 1) {
            const character = html[index];
            if (quote) {
                if (character === quote) quote = undefined;
                else if (character === '<' || character === '>') characters[index] = ' ';
            } else if (character === '"' || character === "'") {
                quote = character;
            }
        }
        cursor = end;
    }
    return characters.join('');
}

/**
 * 以前の出力形式で追加した「#」だけのセクションリンクを取り除く。
 * @param content - 見出し内のHTML。
 * @param href - 見出し自身を指すフラグメント。
 * @returns 旧形式のマーカーを除いた見出し本文。
 */
function removeLegacySectionMarker(content: string, href: string): string {
    return content.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (anchor, attributes: string, inner: string) => {
        const classes = decodeHtmlEntities(readExactAttribute(attributes, 'class')) ?? '';
        const linkHref = decodeHtmlEntities(readExactAttribute(attributes, 'href'));
        if (
            classes.split(/\s+/).includes('mve-heading-anchor') &&
            linkHref === href &&
            headingTextFromHtml(inner).trim() === '#'
        ) {
            return inner;
        }
        return anchor;
    });
}

/**
 * 見出し本文をセクションリンクにし、本文内にある別リンクの遷移先を保つ。
 * @param content - 見出し内のHTML。
 * @param href - 見出し自身を指すフラグメント。
 * @param title - リンクの説明として使うローカライズ済み文言。
 * @returns セクションリンクを設定した見出し本文。
 */
function linkHeadingContent(content: string, href: string, title: string): string {
    const linkText = (text: string) => text.trim()
        ? `<a class="mve-heading-anchor" href="${escapeAttribute(href)}" title="${escapeAttribute(title)}">${text}</a>`
        : text;
    let result = '';
    let cursor = 0;
    let insideLink = false;
    while (cursor < content.length) {
        if (content.startsWith('<!--', cursor)) {
            const commentEnd = content.indexOf('-->', cursor + 4);
            const end = commentEnd < 0 ? content.length : commentEnd + 3;
            result += content.slice(cursor, end);
            cursor = end;
            continue;
        }

        if (content[cursor] === '<') {
            const end = findHtmlTagEnd(content, cursor);
            if (end > cursor) {
                const tag = content.slice(cursor, end);
                if (/^<a(?:\s|>)/i.test(tag)) insideLink = true;
                else if (/^<\/a\s*>$/i.test(tag)) insideLink = false;
                result += tag;
                cursor = end;
                continue;
            }
        }

        let end = content.indexOf('<', cursor);
        if (end < 0) end = content.length;
        if (end === cursor) end += 1;
        const text = content.slice(cursor, end);
        result += insideLink ? text : linkText(text);
        cursor = end;
    }
    return result;
}

/**
 * 引用符内の不等号を無視して、HTMLタグの終端位置を取得する。
 * @param html - HTML断片。
 * @param start - タグの開始位置。
 * @returns タグ終端の次の位置。タグとして閉じていない場合は-1。
 */
function findHtmlTagEnd(html: string, start: number): number {
    let quote: string | undefined;
    for (let index = start + 1; index < html.length; index += 1) {
        const character = html[index];
        if (quote) {
            if (character === quote) quote = undefined;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '>') {
            return index + 1;
        }
    }
    return -1;
}

/**
 * HTML開始タグの属性から、指定した属性名に完全一致する値を取得する。
 * @param attributes - 開始タグの属性部分。
 * @param name - 取得する属性名。
 * @returns 属性値。見つからない場合はundefined。
 */
function readExactAttribute(attributes: string, name: string): string | undefined {
    return findExactAttribute(attributes, name)?.value;
}

/**
 * 属性を保持したまま、指定した属性を新しい値で設定する。
 * @param attributes - 見出し開始タグの属性部分。
 * @param name - 設定する属性名。
 * @param value - 属性に設定する値。
 * @returns 更新した属性部分。
 */
function setExactAttribute(attributes: string, name: string, value: string): string {
    const serialized = `${name}="${escapeAttribute(value)}"`;
    const existing = findExactAttribute(attributes, name);
    if (existing) {
        return `${attributes.slice(0, existing.start)}${serialized}${attributes.slice(existing.end)}`;
    }
    const slash = /\/\s*$/.exec(attributes);
    if (slash) return `${attributes.slice(0, slash.index)} ${serialized}${attributes.slice(slash.index)}`;
    return `${attributes} ${serialized}`;
}

/**
 * 引用符内の文字列を属性名として誤認せず、属性を順に走査する。
 * @param attributes - HTML開始タグの属性部分。
 * @param name - 検索する属性名。
 * @returns 属性の位置と生の値。属性がない場合はundefined。
 */
function findExactAttribute(
    attributes: string,
    name: string
): { start: number; end: number; value: string } | undefined {
    const expectedName = name.toLowerCase();
    let cursor = 0;
    while (cursor < attributes.length) {
        while (cursor < attributes.length && /\s/.test(attributes[cursor])) cursor += 1;
        if (cursor >= attributes.length || attributes[cursor] === '/') {
            cursor += 1;
            continue;
        }
        const start = cursor;
        while (cursor < attributes.length && !/[\s=/>]/.test(attributes[cursor])) cursor += 1;
        if (cursor === start) {
            cursor += 1;
            continue;
        }
        const attributeName = attributes.slice(start, cursor).toLowerCase();
        const nameEnd = cursor;
        while (cursor < attributes.length && /\s/.test(attributes[cursor])) cursor += 1;
        if (attributes[cursor] !== '=') {
            if (attributeName === expectedName) return { start, end: nameEnd, value: '' };
            cursor = nameEnd;
            continue;
        }
        cursor += 1;
        while (cursor < attributes.length && /\s/.test(attributes[cursor])) cursor += 1;
        const quote = attributes[cursor] === '"' || attributes[cursor] === "'" ? attributes[cursor] : undefined;
        if (quote) cursor += 1;
        const valueStart = cursor;
        if (quote) {
            while (cursor < attributes.length && attributes[cursor] !== quote) cursor += 1;
        } else {
            while (cursor < attributes.length && !/[\s>]/.test(attributes[cursor])) cursor += 1;
        }
        const valueEnd = cursor;
        if (quote && cursor < attributes.length) cursor += 1;
        if (attributeName === expectedName) {
            return { start, end: cursor, value: attributes.slice(valueStart, valueEnd) };
        }
    }
    return undefined;
}

/**
 * 見出しHTMLからタグを取り除き、アンカーID生成用の本文を取得する。
 * @param html - 見出し内のHTML。
 * @returns タグを除いた見出し本文。
 */
function headingTextFromHtml(html: string): string {
    return decodeHtmlEntities(html.replace(/<!--([\s\S]*?)-->/g, '').replace(/<[^>]*>/g, ' ')) ?? '';
}

/**
 * 画像srcを埋め込みData URLまたは生成HTMLからの相対パスへ書き換える。
 * @param tag - 画像のsrc属性を読み書きするimg要素のHTMLタグ全体。
 * @param sourcePath - 相対画像参照を解決するリンク元HTMLファイルのパス。
 * @param outputPath - 画像リンクの基準となる生成HTMLの保存先パス。
 * @param options - 画像を埋め込むか相対参照にするかを指定するHTML出力設定。

 */
async function rewriteImageTag(
    tag: string,
    sourcePath: string,
    outputPath: string,
    options: HtmlExportOptions
): Promise<string> {
    const original = decodeHtmlEntities(readAttribute(tag, 'data-original-src') ?? readAttribute(tag, 'src'));
    if (!original || isRemoteResource(original) || !sourcePath) return cleanDataAttributes(tag);
    const imagePath = resolveLocalPath(sourcePath, original);
    if (!imagePath) return cleanDataAttributes(tag);
    let nextSource: string;
    if (options.embedImages) {
        try {
            const bytes = await fs.readFile(imagePath);
            nextSource = `data:${mimeFromPath(imagePath)};base64,${bytes.toString('base64')}`;
        } catch {
            return cleanDataAttributes(tag);
        }
    } else {
        nextSource = relativeHref(outputPath, imagePath);
    }
    return replaceAttribute(cleanDataAttributes(tag), 'src', nextSource);
}

/**
 * 文書リンクを関連文書のHTML出力先または元の相対参照へ書き換える。
 * @param tag - href属性を書き換えるa要素のHTMLタグ全体。
 * @param sourcePath - 相対リンクを解決するリンク元HTMLファイルのパス。
 * @param outputPath - 相対リンクの基準となる生成HTMLの保存先パス。
 * @param documents - 現在のHTML出力に含まれるHtmlDocument一覧。リンク先Markdownの出力先解決に使う。
 * @param options - リンク先MarkdownをHTML化するかを指定するHTML出力設定。

 */
function rewriteLinkTag(
    tag: string,
    sourcePath: string,
    outputPath: string,
    documents: HtmlDocument[],
    options: HtmlExportOptions,
    workspaceRoot: string
): string {
    const original = decodeHtmlEntities(readAttribute(tag, 'data-mve-link') ?? readAttribute(tag, 'href'));
    if (!original || !sourcePath) {
        return cleanDataAttributes(tag);
    }
    if (original.startsWith('#')) {
        return replaceAttribute(cleanDataAttributes(tag), 'href', readFragment(original));
    }
    if (isRemoteResource(original)) return cleanDataAttributes(tag);
    const workspaceRooted = readAttribute(tag, 'data-mve-workspace-rooted') === 'true';
    const linkedPath = workspaceRooted
        ? resolveLocalFileUri(sourcePath, original, true, workspaceRoot)
        : resolveLocalPath(sourcePath, original);
    if (!linkedPath) return cleanDataAttributes(tag);
    const linkedDocument = documents.find(
        (document) => normalizePath(document.sourcePath) === normalizePath(linkedPath));
    const isMarkdown = isMarkdownPath(linkedPath);
    const isSameDocument = normalizePath(linkedPath) === normalizePath(sourcePath);
    const destinationPath = linkedDocument && (isSameDocument || (options.convertLinkedMarkdown && isMarkdown))
        ? linkedDocument.outputPath
        : linkedPath;
    const fragment = readFragment(original);
    const destination = `${relativeHref(outputPath, destinationPath)}${fragment}`;
    return replaceAttribute(cleanDataAttributes(tag), 'href', destination);
}

/**
 * HTML文書を基準にローカルリソース参照をファイルURIへ解決する。
 * @param baseUri - 相対参照の基準となるHTMLまたはMarkdown文書のURI。
 * @param source - MarkdownまたはHTMLから取得したローカルURI、パス、参照文字列。
 * @returns 条件に一致する値。未検出時はundefinedまたはnull。
 */
function resolveLocalFileUri(basePath: string, source: string, workspaceRooted = false, workspaceRoot = path.dirname(basePath)): string | undefined {
    const clean = decodeLocalResourceSource(source);
    if (!clean || isRemoteResource(clean)) return undefined;
    if (workspaceRooted && clean.startsWith('/')) {
        const segments = workspaceRootPathSegments(clean);
        if (!segments) return undefined;
        const relative = path.relative(workspaceRoot, basePath);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
        return path.join(workspaceRoot, ...segments);
    }
    if (workspaceRooted && !isDocumentRelativeResourcePath(clean)) return undefined;
    if (/^file:/i.test(clean)) {
        try {
            return fileURLToPath(clean);
        } catch {
            return undefined;
        }
    }
    return resolveLocalPath(basePath, clean);
}

/**
 * ファイルを基準にローカルリソース参照を絶対パスへ解決する。
 * @param baseFilePath - 相対参照の基準となるHTMLまたはMarkdownファイルのパス。
 * @param source - ローカルURI、絶対パス、または基準ファイルからの相対パス。

 */
function resolveLocalPath(baseFilePath: string, source: string): string {
    const clean = decodeLocalResourceSource(source);
    if (/^file:/i.test(clean)) {
        try {
            return path.normalize(fileURLToPath(clean));
        } catch {
            return clean;
        }
    }
    const normalized = clean.replace(/\\/g, path.sep);
    if (/^[A-Za-z]:[\\/]/.test(normalized) || path.isAbsolute(normalized)) return path.normalize(normalized);
    return path.resolve(path.dirname(baseFilePath), normalized);
}

/**
 * リンク先Markdownがルート文書と同じ相対位置になるよう出力先HTMLパスを求める。
 * @param sourcePath - 出力対象Markdown文書のソースパス。
 * @param rootSourcePath - ルートMarkdown文書のソースパス。
 * @param rootOutputPath - ルートHTMLの保存先パス。
 * @returns ソースツリー内の相対位置を保った生成HTMLパス。
 */
function outputPathFor(sourcePath: string, rootSourcePath: string, rootOutputPath: string): string {
    const sourceRoot = path.dirname(rootSourcePath);
    const relative = path.relative(sourceRoot, sourcePath);
    const safeRelative = relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
        ? relative
        : path.join('_linked', `${createHash('sha1').update(sourcePath).digest('hex').slice(0, 10)}-${path.basename(sourcePath)}`);
    return path.join(path.dirname(rootOutputPath), replaceExtension(safeRelative, '.html'));
}

/**
 * 2つのファイルパスからHTML hrefを作り、各URL区間を安全にエンコードする。
 * @param fromFilePath - 生成hrefを使用するHTMLファイルのパス。
 * @param toFilePath - hrefの参照先ファイルパス。
 * @returns 区切りを`/`へ揃えてエンコードした相対href。
 */
function relativeHref(fromFilePath: string, toFilePath: string): string {
    const relative = path.relative(path.dirname(fromFilePath), toFilePath).replace(/\\/g, '/');
    const normalized = relative || path.basename(toFilePath);
    return normalized.split('/').map(
        (segment) => segment === '.' || segment === '..' ? segment : encodeURIComponent(segment)).join('/');
}

/**
 * HTML開始タグから指定属性の値を引用符を除いて読み取る。
 * @param tag - 属性を読み取るHTML要素タグ全体。
 * @param name - 読み取るHTML属性名。
 * @returns 指定属性の引用符を除いた値。属性がなければundefined。
 */
function readAttribute(tag: string, name: string): string | undefined {
    const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    return match?.[1] ?? match?.[2] ?? match?.[3];
}

/**
 * HTMLの状態または本文へ変更を適用し、必要なら以前の状態へ戻す。
 * @param tag - 属性を置換するHTML要素タグ全体。
 * @param name - 置換するHTML属性名。
 * @param value - 指定HTML属性へ設定する新しい未エスケープ値。

 */
function replaceAttribute(tag: string, name: string, value: string): string {
    const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
    const attribute = `${name}="${escapeAttribute(value)}"`;
    if (pattern.test(tag)) return tag.replace(pattern, attribute);
    if (/\/\s*>$/.test(tag)) return tag.replace(/\/\s*>$/, ` ${attribute}/>`);
    return tag.replace(/>$/, ` ${attribute}>`);
}

/**
 * HTMLから不要または危険な情報を除去する。
 * @param tag - 不要なdata属性を除去するHTML要素タグ全体。

 */
function cleanDataAttributes(tag: string): string {
    return tag.replace(/\sdata-(?:original-src|mve-[\w-]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
}

/**
 * HTML属性値の文字参照だけをデコードし、URIのパーセント表記を保つ。
 * @param value - HTMLエンティティを含む属性値。未指定ならundefined。
 * @returns HTMLエンティティを戻した値。入力が未指定ならundefined。
 */
function decodeHtmlEntities(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return decodeHTMLAttribute(value);
}

/**
 * リンク参照のフラグメント部分をURIエンコードして返す。
 * @param value - リンク参照文字列。#以降を抽出してURIエンコードする。

 */
function readFragment(value: string): string {
    const index = value.indexOf('#');
    if (index < 0) return '';
    const rawFragment = value.slice(index + 1);
    let decodedFragment = rawFragment;
    try {
        decodedFragment = decodeURIComponent(rawFragment);
    } catch {
        // 不正な%エスケープは文字列のまま再エンコードする。
    }
    return `#${encodeURIComponent(decodedFragment)}`;
}

/**
 * 参照先がHTTPなどのリモートまたは非ファイルURIかを判定する。
 * @param value - ローカル解決を行うか判定するsrcまたはhref参照文字列。
 * @returns 条件が成立したかを示す真偽値。
 */
function isRemoteResource(value: string): boolean {
    return /^(?:https?:|mailto:|tel:|ftp:|data:|blob:|javascript:|#|\/\/)/i.test(value);
}

/**
 * ファイルパスが出力変換するMarkdown系文書かを判定する。
 * @param value - MarkdownまたはTextile拡張子かを判定するファイルパス。
 * @returns 条件が成立したかを示す真偽値。
 */
function isMarkdownPath(value: string): boolean {
    return /\.(?:md|markdown|textile)$/i.test(value);
}

/**
 * HTML出力文書の拡張子に合う専用描画形式を選ぶ。
 * @param value - MarkdownまたはTextile文書のファイルパス。
 * @returns Textile専用拡張子ではTextile形式、それ以外ではMarkdown形式。
 */
function getHtmlRenderFormat(value: string): 'mixed' | 'textile' {
    return /\.textile$/i.test(value) ? 'textile' : 'mixed';
}

/**
 * Windowsでは大文字・小文字を統一し、POSIXでは別文書の大小文字を保持する比較用パスを返す。
 * @param value - 文書の収集、描画結果、リンク先を照合するファイルパス。
 * @returns 絶対化・正規化したパス。小文字化はWindowsに限る。
 */
function normalizePath(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * ファイルパス末尾の拡張子を指定した拡張子へ置き換える。
 * @param value - 拡張子を置き換えるファイルパス。
 * @param extension - 置き換え後に付ける拡張子。

 */
function replaceExtension(value: string, extension: string): string {
    return value.replace(/\.[^./\\]+$/, extension);
}

/**
 * 出力ファイルパスにHTML拡張子がない場合は.htmlを付ける。
 * @param value - HTML拡張子を付ける出力ファイルパス。
 * @returns .html/.htmはそのまま、その他は.htmlを補完する。検査と書き込みで共用する。
 */
export function ensureHtmlExtension(value: string): string {
    return /\.html?$/i.test(value) ? value : `${value}.html`;
}

/**
 * HTML属性値に含まれるアンパサンド、山括弧、引用符をエンティティへ変換する。
 * @param value - HTML属性へ出力する未エスケープ文字列。

 */
function escapeAttribute(value: string): string {
    return value.replace(/[&<>"']/g,
        /**
         * HTML属性内で特別な扱いが必要な1文字を文字参照へ置き換える。
         * @param character - 現在置換するアンパサンド、山括弧、引用符のいずれか。
         * @returns 対応するHTML文字参照。
         */
        (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/**
 * PDFまたはHTML出力前に危険な要素と属性をHTML本文から除去する。
 * @param value - PDFまたはHTML出力前に危険な要素・属性を除去するHTML本文。

 */
function stripUnsafeMarkup(value: string): string {
    return value
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
        .replace(/javascript:/gi, '');
}

/**
 * ファイル拡張子からHTML出力で使う画像MIMEタイプを決める。
 * @param filePath - 拡張子から画像MIMEタイプを判定するファイルパス。
 * @returns 拡張子に対応するMIMEタイプ。不明な拡張子はapplication/octet-stream。
 */
function mimeFromPath(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();
    return ({
        '.avif': 'image/avif',
        '.gif': 'image/gif',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp'
    } as Record<string, string>)[extension] ?? 'image/png';
}


/** HTMLアウトラインの幅をポインターまたはキーボードで変更するスクリプト本文。 */
export const HTML_OUTLINE_RESIZER_SCRIPT = `
(() => {
  const layout = document.querySelector('.mve-html-layout-with-outline');
  const separator = layout?.querySelector('.mve-html-outline-resizer');
  const hideButton = layout?.querySelector('.mve-html-outline-hide');
  const showButton = layout?.querySelector('.mve-html-outline-show');
  if (!(layout instanceof HTMLElement) || !(separator instanceof HTMLElement)) return;
  const canToggleOutline = hideButton instanceof HTMLButtonElement && showButton instanceof HTMLButtonElement;

  const minimumWidth = 160;
  const maximumWidth = 800;
  const separatorWidth = 8;
  const mainMinimumWidth = 240;
  let width = Number(separator.getAttribute('aria-valuenow')) || 240;
  let dragOffset = 0;

  const getMaximumWidth = () => {
    if (window.matchMedia('(max-width: 720px)').matches) return maximumWidth;
    return Math.max(minimumWidth, Math.min(maximumWidth, layout.clientWidth - separatorWidth - mainMinimumWidth));
  };

  const updateWidth = (nextWidth) => {
    const maxWidth = getMaximumWidth();
    width = Math.min(maxWidth, Math.max(minimumWidth, Math.round(nextWidth)));
    layout.style.setProperty('--mve-html-outline-width', width + 'px');
    separator.setAttribute('aria-valuemax', String(maxWidth));
    separator.setAttribute('aria-valuenow', String(width));
    separator.setAttribute('aria-valuetext', width + 'px');
  };

  if (canToggleOutline) {
    const setOutlineVisible = (visible) => {
      layout.classList.toggle('mve-html-outline-hidden', !visible);
      hideButton.setAttribute('aria-expanded', String(visible));
      showButton.setAttribute('aria-expanded', String(visible));
      showButton.hidden = visible;
      updateWidth(width);
      (visible ? hideButton : showButton).focus();
    };

    hideButton.addEventListener('click', () => setOutlineVisible(false));
    showButton.addEventListener('click', () => setOutlineVisible(true));
  }

  separator.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragOffset = event.clientX - layout.getBoundingClientRect().left - width;
    separator.setPointerCapture(event.pointerId);
    document.body.classList.add('mve-html-is-resizing');
    event.preventDefault();
  });

  separator.addEventListener('pointermove', (event) => {
    if (!separator.hasPointerCapture(event.pointerId)) return;
    updateWidth(event.clientX - layout.getBoundingClientRect().left - dragOffset);
  });

  const stopResizing = () => document.body.classList.remove('mve-html-is-resizing');
  separator.addEventListener('pointerup', stopResizing);
  separator.addEventListener('pointercancel', stopResizing);
  separator.addEventListener('lostpointercapture', stopResizing);

  separator.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowLeft') updateWidth(width - step);
    else if (event.key === 'ArrowRight') updateWidth(width + step);
    else if (event.key === 'Home') updateWidth(minimumWidth);
    else if (event.key === 'End') updateWidth(getMaximumWidth());
    else return;
    event.preventDefault();
  });

  window.addEventListener('resize', () => updateWidth(width));
  updateWidth(width);
})();
`;

const HTML_CSS = /**
 * HTML出力用の印刷・レイアウト規則、白背景向けコード配色、テーマ別見出し色を生成する。
 * @param fontFamily - body要素へ適用するCSSフォント指定。
 * @param editorTheme - 見出し色の選択に使うテーマ。未指定時はダークテーマ。
 * @returns 白いHTML背景上でコードと見出しを判読できるCSS。

 */ (fontFamily: string, editorTheme: EditorTheme = 'dark'): string => `
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: ${fontFamily}; color: #202124; background: #fff; }
  .mve-html :is(h1, h2, h3, h4, h5, h6) { color: ${editorTheme === 'light' ? '#0969da' : '#0550ae'}; }
  .mve-html-layout { min-height: 100vh; }
  .mve-html-layout-with-outline { display: grid; grid-template-columns: minmax(160px, var(--mve-html-outline-width, 240px)) 8px minmax(0, 1fr); grid-template-areas: "sidebar divider content"; }
  .mve-html { grid-area: content; min-width: 0; max-width: 100%; margin: 0 auto; padding: 24px; box-sizing: border-box; }
  .mve-html-outline { grid-area: sidebar; position: sticky; top: 0; box-sizing: border-box; height: 100vh; overflow: auto; border-right: 1px solid #dadce0; background: #f8f9fa; }
  .mve-html-layout-with-outline.mve-html-outline-hidden { grid-template-columns: minmax(0, 1fr); grid-template-areas: "toolbar" "content"; }
  .mve-html-outline-hidden .mve-html-outline, .mve-html-outline-hidden .mve-html-outline-resizer { display: none; }
  .mve-html-outline-hidden .mve-html-outline-show:not([hidden]) { display: inline-flex; grid-area: toolbar; justify-self: start; margin: 12px 24px 0; }
  .mve-html-outline-show[hidden] { display: none; }
  .mve-html-outline-resizer { position: relative; cursor: col-resize; touch-action: none; user-select: none; }
  .mve-html-outline-resizer { grid-area: divider; }
  .mve-html-outline-resizer::after { position: absolute; top: 0; bottom: 0; left: 3px; width: 2px; background: transparent; content: ''; }
  .mve-html-outline-resizer:hover::after, .mve-html-outline-resizer:focus-visible::after { background: #9aa0a6; }
  .mve-html-outline-resizer:focus-visible { outline: 2px solid #1a73e8; outline-offset: -2px; }
  body.mve-html-is-resizing, body.mve-html-is-resizing * { cursor: col-resize !important; user-select: none !important; }
  .mve-html-outline-toggle { align-items: center; justify-content: center; border: 1px solid #dadce0; border-radius: 4px; background: #fff; color: #202124; cursor: pointer; font: inherit; }
  .mve-html-outline-toggle:hover { background: #e8eaed; }
  .mve-html-outline-toggle:focus-visible { outline: 2px solid #1a73e8; outline-offset: 2px; }
  .mve-html-outline-hide { display: inline-flex; width: 28px; height: 28px; padding: 0; font-size: 18px; line-height: 1; }
  .mve-html-outline-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #dadce0; color: #5f6368; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
  .mve-html-outline-show { width: 36px; height: 36px; padding: 0; }
  .mve-html-outline-show-icon { position: relative; display: block; width: 18px; height: 16px; box-sizing: border-box; border: 1px solid currentColor; border-radius: 2px; }
  .mve-html-outline-show-icon::before { position: absolute; top: 0; bottom: 0; left: 5px; border-left: 1px solid currentColor; content: ''; }
  .mve-html-outline-show-icon::after { position: absolute; top: 3px; left: 9px; width: 5px; height: 1px; background: currentColor; box-shadow: 0 4px 0 currentColor, 0 8px 0 currentColor; content: ''; }
  .mve-html-outline nav { padding: 8px 8px 12px; }
  .mve-html-outline-tree, .mve-html-outline-children { margin: 0; padding: 0; list-style: none; }
  .mve-html-outline-children { margin-left: 18px; }
  .mve-html-outline a { display: block; overflow: hidden; padding: 3px 6px; border-radius: 3px; color: #202124; line-height: 1.4; text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
  .mve-html-outline a:hover { background: #e8eaed; }
  .mve-html-outline a:focus-visible { outline: 2px solid #1a73e8; outline-offset: -2px; background: #e8eaed; }
  .mve-html-outline-empty { padding: 0 12px; color: #5f6368; font-size: 12px; }
  img { max-width: 100%; height: auto; }
  /* 表は内容の最大幅を基準にし、親要素を超える長文はセル内で折り返す。 */
  table { width: max-content; max-width: 100%; border-collapse: collapse; }
  /* 白背景のHTML出力では見出しセルを本文セルから色で判別できるようにする。 */
  .mve-html table th { color: #202124; background-color: #bdd5ef; }
  table th, table td { word-break: normal; overflow-wrap: anywhere; }
  /* 入力HTMLのnowrap属性が残っても、表示幅不足時は折り返す。 */
  table th[data-mve-nowrap="true"], table td[data-mve-nowrap="true"] { white-space: normal; overflow-wrap: anywhere; }
  /* 短い候補の列は内容幅を保ち、表で幅が足りない場合だけ緊急折り返しを許可する。 */
  table th[data-mve-short-value-candidate="true"], table td[data-mve-short-value-candidate="true"] { word-break: keep-all; overflow-wrap: break-word; }
  /* 空白を含む短い見出し語句は通常幅で一組にし、狭い画面では折り返しへ戻す。 */
  table th[data-mve-short-value-label="true"] { white-space: nowrap; overflow-wrap: normal; }
  @media screen and (max-width: 400px) { table th[data-mve-short-value-label="true"] { white-space: normal; overflow-wrap: anywhere; } }
  .mve-html pre { color: #24292f; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 4px; padding: 12px; overflow-x: auto; overflow-wrap: anywhere; white-space: pre-wrap; }
  .mve-html pre code { color: inherit; background: transparent !important; }
  .mve-html :not(pre) > code { color: #24292f; background: #eff1f3; border-radius: 3px; padding: .12em .35em; }
  .mve-html .hljs-keyword, .mve-html .hljs-selector-tag, .mve-html .hljs-literal { color: #8250df; }
  .mve-html .hljs-string, .mve-html .hljs-attr { color: #0a3069; }
  .mve-html .hljs-title, .mve-html .hljs-section { color: #953800; }
  .mve-html .hljs-comment { color: #6e7781; }
  .mve-html .hljs-number { color: #0550ae; }
  pre { overflow-x: auto; }
  a { color: inherit; text-decoration: underline; }
  .mve-html .mve-heading-anchor { color: inherit; }
  .mve-html .mve-heading-anchor:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
  @media (max-width: 720px) {
    .mve-html-layout-with-outline { display: block; }
    .mve-html-outline { position: relative; height: auto; max-height: 40vh; border-right: 0; border-bottom: 1px solid #dadce0; }
    .mve-html-outline-resizer { display: none; }
    .mve-html-outline-hidden .mve-html-outline-show:not([hidden]) { display: inline-flex; margin: 12px 24px 0; }
  }
`;
