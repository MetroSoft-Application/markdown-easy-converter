/**
 * @fileoverview Markdownを段階的に解析・変換し、HTML・見出し・画像情報を安定した中間結果へまとめる。
 */
import katex from 'katex';
import { Marked, Renderer, type Token, type Tokens, type TokenizerAndRendererExtension } from 'marked';
import { footnoteDefinitionSyntax, mathBlockSyntax, tableOfContentsSyntax } from '../../shared/markdownBlockSyntax';
import {
    getOutline,
    nextHeadingAnchorId,
    slugify,
    WORKSPACE_SECTION_LINK_TITLE,
    type OutlineItem
} from '../../shared/markdown';
import { decodeTextileCodeEntities, renderTextile } from '../../shared/textileAdapter';
import { getMessages, type Messages, type SupportedLanguage } from '../../shared/messages';
import { classifyShortValueTableCell } from '../../shared/tableShortValueFit';

/**
 * 既定Markdown、Textile専用、Markdown優先の混在描画を区別する形式。
 */
export type MarkdownRenderFormat = 'markdown' | 'mixed' | 'textile';

/**
 * Markdown変換へ渡す設定項目と既定値のデータ形状。
 */
export interface RenderOptions {

    /**
     * trueならhttp(s)画像を読み込み、falseなら画像本体の代わりにブロック表示する。
     */
    remoteImagesEnabled: boolean;

    /**
     * 描画形式。省略時は既存文書との互換性を保つMarkdown。
     */
    renderFormat?: MarkdownRenderFormat;

    /**
     * メッセージとKaTeXエラー表示に使う言語。省略時は日本語。
     */
    language?: SupportedLanguage;
}

/**
 * 独自Markdownトークンの種別と解析済み内容を表します。
 */
interface CustomToken {

    /**
     * Markdown parserが付けたカスタムトークンの種別名です。
     */
    type: string;

    /**
     * Markdown変換で扱うrawの文字列。
     */
    raw: string;

    /**
     * 表示・解析・変換の対象となる本文。
     */
    text: string;

    /**
     * ネストしたMarkdown inline token。rendererで装飾内の内容を再帰描画する。
     */
    tokens?: Token[];
}

/**
 * 脚注ラベルと脚注として表示する本文を表します。
 */
interface FootnoteDefinition {

    /**
     * Markdown変換で扱うidの文字列。
     */
    id: string;

    /**
     * 表示・解析・変換の対象となる本文。
     */
    text: string;

    /**
     * トークン範囲の先頭を示すMarkdown本文内UTF-16オフセットです。
     */
    from: number;

    /**
     * トークン範囲の末尾を示すMarkdown本文内UTF-16オフセットです。
     */
    to: number;
}

/**
 * 安全でない要素を除去する対象ブロックの範囲と本文です。
 */
export interface UnsafeMarkdownBlock {

    /**
     * 表示または出力するHTML本文。
     */
    html: string;
    /** 見出しブロックの本文内開始位置。 */
    headingOffset?: number;
    /** 実際に描画した見出しのID。 */
    headingId?: string;
    /**
     * 一つのTextile描画ブロックに含まれる複数見出しのソース位置と描画ID。
     * 脚注など文書全体の文脈を必要とする場合も、アウトラインの対応を保つ。
     */
    headingIds?: Array<{ offset: number; id: string }>;

    /**
     * trueならHTML出力をサニタイズする必要がある。Markdown由来の非HTML変換結果ではfalse。
     */
    requiresSanitization: boolean;
}

/**
 * 描画済み見出しのIDをアウトラインへ反映し、Setext見出しでもリンク先を一致させる。
 * @param outline 表示する見出し一覧。
 * @param blocks 描画後の見出しIDを含むMarkdownブロック一覧。
 * @returns 描画済みIDを反映したアウトライン。対応するブロックがない項目は除く。
 */
export function alignOutlineHeadingIds(
    outline: OutlineItem[],
    blocks: UnsafeMarkdownBlock[]
): OutlineItem[] {
    const byOffset = new Map<number, string>();
    for (const block of blocks) {
        for (const heading of block.headingIds ?? []) {
            byOffset.set(heading.offset, heading.id);
        }
        if (block.headingOffset !== undefined && block.headingId) {
            byOffset.set(block.headingOffset, block.headingId);
        }
    }
    return outline.flatMap((item) => {
        const id = byOffset.get(item.offset);
        if (!id) return [];
        return [id !== item.id ? { ...item, id } : item];
    });
}

/**
 * fenced code blockの本文を表示用HTMLへ変換する。
 * @param text - 表示・解析・変換の対象となる本文。
 * @param language - 言語判定と表示文言の選択に使うロケールコード。
 * @returns 強調表示したHTML。未対応言語などで変換しない場合はundefined。
 */
export type CodeHighlighter = (text: string, language: string) => string | undefined;

/**
 * Markdownをサニタイズ前の安全なブロックとコード強調HTMLへ変換する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @param options 言語、表示モード、HTML許可設定などの変換オプション。
 * @param highlightCode fenced code blockの本文と言語から強調表示HTMLを作る関数。
 * @returns 強調表示HTMLを含む安全化前ブロックの一覧。
 */
export function renderMarkdownUnsafeBlocks(
    markdown: string,
    options: RenderOptions,
    highlightCode?: CodeHighlighter
): UnsafeMarkdownBlock[] {
    const requestedFormat = options.renderFormat ?? 'markdown';
    const renderFormat = requestedFormat === 'mixed' && !hasMixedTextileSyntaxCandidate(markdown)
        ? 'markdown'
        : requestedFormat;
    if (renderFormat === 'textile') {
        return renderTextileDocumentBlocks(markdown, options, highlightCode);
    }
    // 見出しIDと脚注参照番号を1回の描画中だけ保持し、同名見出しや複数参照を区別する。
    const messages = getMessages(options.language ?? 'ja');
    const renderer = new Renderer();
    const headingIds = new Map<string, number>();
    const usedHeadingIds = new Set<string>();
    let renderedHeadingId: string | undefined;
    const footnoteDefinitions = collectFootnoteDefinitions(markdown);
    const footnoteCounts = new Map<string, number>();
    let imageIndex = 0;
    const sourceHeadings = renderFormat === 'mixed' && hasMixedTextileHeadingCandidate(markdown)
        ? getSourceOutlineForFormat(markdown, renderFormat)
        : [];
    const sourceHeadingIdsByOffset = new Map(sourceHeadings.map(
        /**
         * heading rendererが元文書位置から見出しIDを引けるようにする。
         * @param heading - 描画形式を反映したアウトライン項目。
         * @returns 見出しソース位置と確定IDの組。
         */
        (heading) => [heading.offset, heading.id]
    ));
    const textileHeadings = renderFormat === 'mixed'
        ? sourceHeadings.filter(
            /**
             * 明示的なTextile見出しだけをTextileトークンへ関連付ける。
             * @param heading - 描画形式を反映したアウトライン項目。
             * @returns ソース位置がTextile見出しの場合はtrue。
             */
            (heading) => /^h[1-6](?:[<>=()]*)(?:\([^)]*\))?(?:\{[^}]*\})?(?:\[[^\]]*\])?\./i.test(markdown.slice(heading.offset))
        )
        : sourceHeadings;
    const textileHeadingsByOffset = new Map(textileHeadings.map(
        /**
         * Textile block rendererが見出しを参照できるようにする。
         * @param heading - Textileソースに対応するアウトライン項目。
         * @returns 見出しソース位置とアウトライン項目の組。
         */
        (heading) => [heading.offset, heading]
    ));
    let activeTextileSourceOffset: number | undefined;
    let renderedTextileHeadingId: string | undefined;
    let mixedTextileImageIndex = 0;

    /**
     * Textileブロック画像にMarkdown画像編集経路と独立した連番を割り当てる。
     * @returns 次の混在Textile画像番号。
     */
    function nextMixedTextileImageIndex(): number {
        return mixedTextileImageIndex++;
    }

    /**
     * Markdown見出しから固有IDを決め、アウトラインへのリンク先を保つrenderer。
     */
    renderer.heading =
        /**
         * heading IDを重複回避付きで決め、タイトル属性を除いた見出しHTMLを生成する。
         * @param tokens - 見出し文字列を構成するMarked token一覧。
         * @param depth - h1からh6までの見出しレベル。
         * @returns mve見出しIDを付与した見出し要素。
         */
        function ({ tokens, depth }) {
            const content = this.parser.parseInline(tokens);
            const id = renderFormat === 'mixed'
                ? sourceHeadingIdsByOffset.get(activeTextileSourceOffset ?? -1)
                ?? nextHeadingAnchorId(tokens.map((token) => token.raw).join(''), headingIds, usedHeadingIds)
                : nextHeadingAnchorId(tokens.map((token) => token.raw).join(''), headingIds, usedHeadingIds);
            renderedHeadingId = id;
            return `<h${depth} id="${escapeAttribute(id)}" data-mve-heading="true">${content.replace(/\s+\{#[^}]+\}(?=(?:<\/span>)*\s*$)/, '')}</h${depth}>`;
        };

    renderer.tablecell =
        /**
         * 短い日本語語句・英字token・短い複合見出しだけに折り返し優先CSS用の属性を付ける。
         * @param cell - Markedが解析した表セルの本文、見出し状態、配置。
         * @returns 通常のth/tdに、短文候補だけを示すdata属性を付けたHTML。
         */
        function (cell) {
            const content = this.parser.parseInline(cell.tokens);
            const tagName = cell.header ? 'th' : 'td';
            const alignAttribute = cell.align ? ` align="${cell.align}"` : '';
            const shortValueMarker = classifyShortValueTableCell(cell.text, cell.header);
            const candidateAttribute = shortValueMarker.candidate ? ' data-mve-short-value-candidate="true"' : '';
            const labelAttribute = shortValueMarker.label ? ' data-mve-short-value-label="true"' : '';
            return `<${tagName}${alignAttribute}${candidateAttribute}${labelAttribute}>${content}</${tagName}>\n`;
        };

    /**
     * Markdownのリンク、コード、HTML token用rendererを束ねる。
     */
    renderer.link =
        /**
         * ローカルMarkdownリンクをHost処理用のdata属性へ変換し、外部リンクは通常のhrefで出力する。
         * @param href - リンク先。
         * @param title - Markdownリンクに指定された任意のtitle属性。
         * @param tokens - リンク本文を構成するMarked inline token一覧。
         * @returns ローカル遷移属性または通常のhrefを持つリンク要素。
         */
        function ({ href, title, tokens }) {
            const content = this.parser.parseInline(tokens);
            const workspaceRooted = title === WORKSPACE_SECTION_LINK_TITLE;
            const titleAttribute = title !== null && title !== undefined && !workspaceRooted
                ? ` title="${escapeAttribute(title)}"`
                : '';
            const workspaceRootedAttribute = workspaceRooted ? ' data-mve-workspace-rooted="true"' : '';
            if (isLocalMarkdownLink(href)) {
                return `<a href="#" data-mve-link="${escapeAttribute(href)}"${workspaceRootedAttribute}${titleAttribute}>${content}</a>`;
            }
            return `<a href="${escapeAttribute(href)}"${workspaceRootedAttribute}${titleAttribute}>${content}</a>`;
        };

    /** Markdown imageトークンを表示用またはブロック済み画像HTMLへ変換するrenderer。 */
    renderer.image =
        /**
         * Markdown image tokenの参照、代替テキスト、任意タイトルからHTMLを生成する。
         * @param href - img要素のsrc属性へ出力する画像参照。
         * @param title - 指定された場合にtitle属性へ出力する補足文字列。
         * @param text - img要素のalt属性へ出力する代替テキスト。
         * @returns 画像またはブロック済み画像を表すHTML。
         */
        ({ href, title, text }) => {
            const currentImageIndex = imageIndex++;
            if (!options.remoteImagesEnabled && /^https?:/i.test(href)) {
                return `<span class="blocked-image" title="${escapeAttribute(messages.renderer.remoteImageDisabled)}">🖼️ ${escapeHtml(text || href)}</span>`;
            }
            const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : '';
            const resizable = !/^https?:\/\//i.test(href);
            return `<img src="${escapeAttribute(href)}" loading="lazy" decoding="async" data-original-src="${escapeAttribute(href)}" data-mve-image-index="${currentImageIndex}" data-mve-image-kind="markdown" data-mve-image-align="left" data-mve-resizable="${resizable ? 'true' : 'false'}" data-mve-can-reset="false" alt="${escapeAttribute(text)}"${titleAttribute}>`;
        };

    /** Markdown code tokenを言語情報付きのコードHTMLへ変換するrenderer。 */
    renderer.code =
        /**
         * Markdown code tokenの本文と言語から表示用コードHTMLを生成する。
         * @param text - コードブロック本文。
         * @param lang - fence指定から受け取る言語ラベル。
         * @returns 言語表示とコード本文を含むHTML。
         */
        ({ text, lang }) => {
            const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
            if (language === 'mermaid') {
                return `<div class="diagram-block mermaid" data-mermaid-source="${escapeAttribute(encodeURIComponent(text))}"></div>`;
            }
            const highlighted = highlightCode?.(text, language) ?? escapeHtml(text);
            return `<figure class="code-figure" data-language="${escapeAttribute(language)}"><figcaption><span>${escapeHtml(language || messages.editor.plainText)}</span><button type="button" data-copy-code="true">${messages.renderer.copy}</button></figcaption><pre><code class="hljs language-${escapeAttribute(language)}">${highlighted}</code></pre></figure>`;
        };

    /** Markdown内のHTML tokenを表示用ブロックまたは装飾済みHTMLへ変換するrenderer。 */
    renderer.html =
        /**
         * MarkdownのHTML tokenへ混在形式の言語付きコード強調を適用し、画像情報を付ける。
         * @param text - HTML tokenに含まれる本文。
         * @returns ページ区切り、強調済みコード、または画像情報を付加したHTML。
         */
        ({ text }) => {
            if (/^<!--\s*pagebreak\s*-->$/i.test(text.trim())) return `<div class="page-break" aria-label="${escapeAttribute(messages.renderer.pageBreak)}"></div>`;
            const html = renderFormat === 'mixed' ? highlightTextileCodeBlocks(text, highlightCode, true) : text;
            return decorateHtmlImages(html,
                /**
                 * HTML token内のimg要素へ文書内の連番を付与する。
                 * @returns 次のHTML画像番号。
                 */
                () => imageIndex++);
        };

    // Textile専用ブロックは明示的な接頭辞とTextile表だけに限定し、曖昧な記法はMarkedへ残す。
    const parser = new Marked({ gfm: true, breaks: false, renderer });
    if (renderFormat === 'mixed') {
        parser.use({
            extensions: [
                createMixedTextileBlockExtension(
                    options,
                    highlightCode,
                    nextMixedTextileImageIndex,
                    /**
                     * Textileブロック開始位置に対応するアウトライン見出しを返す。
                     * @param offset - 現在ブロックのUTF-16開始位置。
                     * @returns 見出し項目が存在する場合は1項目の一覧。
                     */
                    (offset) => {
                        const heading = textileHeadingsByOffset.get(offset);
                        return heading ? [heading] : [];
                    },
                    /**
                     * Textile block rendererが確定した見出しIDをブロック結果へ渡す。
                     * @param headingId - Textile見出しの描画ID。
                     */
                    (headingId) => {
                        renderedTextileHeadingId = headingId;
                    },
                    /**
                     * 変換中のMarked tokenの原文開始位置を参照する。
                     * @returns 現在のtoken開始位置。位置がない場合はundefined。
                     */
                    () => activeTextileSourceOffset
                ),
                ...createMixedTextileInlineExtensions(options, messages.renderer.remoteImageDisabled)
            ]
        });
    }
    // 標準Markdown拡張と既存独自構文を同じトークン処理へ流す。
    parser.use({
        extensions: [
            inlineDelimited('highlight', /^==(?=\S)([\s\S]*?\S)==/, 'mark'),
            inlineDelimited('inserted', /^\+\+(?=\S)([\s\S]*?\S)\+\+/, 'ins'),
            inlineDelimited('superscript', /^\^(?=\S)([^\n^]*?\S)\^/, 'sup'),
            inlineDelimited('subscript', /^~(?=\S)([^\n~]*?\S)~/, 'sub'),
            mathBlockExtension(messages),
            mathInlineExtension(messages),
            tocExtension(markdown, messages),
            footnoteDefinitionExtension(),
            footnoteReferenceExtension(footnoteDefinitions, footnoteCounts)
        ]
    });

    // トークンを元本文の範囲へ対応付け、プレビュー要素から編集位置へ戻れるようにする。
    const tokens = parser.lexer(markdown);
    const ranges = locateTokenRanges(markdown, tokens);
    const links = (tokens as typeof tokens & {
        /**
         * Markdown変換で扱うlinksの文字列。
         */
        links?: Record<string, unknown>
    }).links;
    // ブロック単位でHTMLを描画して出典範囲属性を付け、脚注セクションを本文末尾へ追加する。
    const blocks = tokens.map(
        /**
         * 各tokenからlistを取り出して一覧化する。
         * @param token - tokenのlistを参照する走査対象。
         * @param index - 走査中の配列における0始まりの要素位置。
         * @returns listを取り出した変換結果の一覧。
         */
        (token, index): UnsafeMarkdownBlock | undefined => {
            const tokenList = Object.assign([token], { links });
            renderedHeadingId = undefined;
            renderedTextileHeadingId = undefined;
            activeTextileSourceOffset = ranges[index]?.from;
            const rendered = String(parser.parser(tokenList));
            if (!rendered.trim()) return undefined;
            const range = ranges[index];
            const textileHeading = token.type === 'mveTextileBlock'
                ? textileHeadingsByOffset.get(range.from)
                : undefined;
            return {
                html: `<div class="markdown-source-block" data-source-from="${range.from}" data-source-to="${range.to}">${rendered}</div>`,
                headingOffset: token.type === 'heading' ? range.from : textileHeading?.offset,
                headingId: token.type === 'heading' ? renderedHeadingId : renderedTextileHeadingId,
                // コード/Mermaid本文と属性はrenderer.code内ですべてエスケープ済み。
                requiresSanitization: token.type !== 'code'
            };
        }).filter(
            /**
             * 条件を満たすblockだけを残す。
             * @param block - トークンから生成したHTMLブロック。対象外トークンの場合はundefined。

             */
            (block): block is UnsafeMarkdownBlock => block !== undefined);
    const footnotes = renderFootnoteSection(footnoteDefinitions, messages);
    if (footnotes) blocks.push({ html: footnotes, requiresSanitization: false });
    // 各トップレベルブロックを独立させ、UI側でDOMPurifyを短時間ずつ実行できるようにする。
    return blocks.map(
        /**
         * 各blockからhtmlを取り出して一覧化する。
         * @param block - blockのhtmlを参照する走査対象。
         * @returns htmlを取り出した変換結果の一覧。
         */
        (block) => ({ ...block, html: renderAlerts(block.html, messages) }));
}

/**
 * Markdown本文を変換し、安全なHTML文字列として返す。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @param options 言語、表示モード、HTML許可設定などの変換オプション。
 * @param highlightCode fenced code blockの本文と言語から強調表示HTMLを作る関数。
 * @returns 安全化前HTMLへ結合したMarkdown描画結果。
 */
export function renderMarkdownUnsafe(
    markdown: string,
    options: RenderOptions,
    highlightCode?: CodeHighlighter
): string {
    return renderMarkdownUnsafeBlocks(markdown, options, highlightCode).map(
        /**
         * 各blockからhtmlを取り出して一覧化する。
         * @param block - blockのhtmlを参照する走査対象。
         * @returns htmlを取り出した変換結果の一覧。
         */
        (block) => block.html).join('');
}

/**
 * Markdown変換の条件を判定する。
 * @param href - リンク操作領域の遷移先URI。
 * @returns 条件が成立したかを示す真偽値。
 */
function isLocalMarkdownLink(href: string): boolean {
    if (!href || href.startsWith('#')) return false;
    if (/^https?:\/\/file\+\.vscode-resource\.vscode-cdn\.net\//i.test(href)) return true;
    if (/^(?:file:|[A-Za-z]:[\\/]|\\\\|\/\/)/i.test(href)) return true;
    return !/^(?:https?|mailto|tel|ftp|data|javascript):/i.test(href);
}

/**
 * MarkdownとTextileの見出しを描画済みブロックIDへ対応付ける。
 * @param source - 原文を変更せずに解析する文書本文。
 * @param format - Markdown専用、Textile専用、または両形式を混在させる描画形式。
 * @param blocks - 描画後の見出しIDとソース位置を含むブロック一覧。
 * @returns 文書順に並んだ見出し項目。表示できない見出しは除く。
 */
export function getOutlineForFormat(
    source: string,
    format: MarkdownRenderFormat,
    blocks: UnsafeMarkdownBlock[]
): OutlineItem[] {
    return alignOutlineHeadingIds(getSourceOutlineForFormat(source, format), blocks);
}

/**
 * 指定形式の見出しを文書順にまとめ、混在形式ではアンカーIDの重複も共有して採番する。
 * @param source - 原文を走査する文書本文。
 * @param format - Markdown専用、Textile専用、または両形式を混在させる描画形式。
 * @returns ソース順に並んだ見出し一覧。
 */
function getSourceOutlineForFormat(
    source: string,
    format: MarkdownRenderFormat
): OutlineItem[] {
    if (format === 'textile') return getTextileOutline(source);
    const markdownItems = getOutline(source);
    if (format === 'markdown') return markdownItems;
    const textileItems = getTextileOutline(source, true);
    const counts = new Map<string, number>();
    const usedIds = new Set<string>();
    return [...markdownItems, ...textileItems]
        .sort(
            /**
             * 混在形式のMarkdown・Textile見出しを原文順へ並べる。
             * @param left - 左側の見出し候補。
             * @param right - 右側の見出し候補。
             * @returns 原文位置の昇順を示す比較値。
             */
            (left, right) => left.offset - right.offset
        )
        .map(
            /**
             * MarkdownとTextileの見出しへ文書順の重複回避IDを割り当てる。
             * @param item - MarkdownまたはTextileのアウトライン候補。
             * @returns 確定IDを割り当てたアウトライン項目。
             */
            (item) => {
                const rawLine = source.slice(item.offset).split(/\r\n|\r|\n/, 1)[0] ?? '';
                const markdownHeading = /^#{1,6}\s+(.+?)\s*$/.exec(rawLine);
                const textileHeading = /^h[1-6](?:[<>=()]*)(?:\([^)]*\))?(?:\{[^}]*\})?(?:\[[^\]]*\])?\.\s+(.+?)\s*$/i.exec(rawLine);
                const rawHeading = textileHeading
                    ? stripTextileHeadingMarkup(textileHeading[1])
                    : markdownHeading?.[1] ?? item.text;
                return {
                    ...item,
                    id: nextHeadingAnchorId(rawHeading, counts, usedIds)
                };
            }
        );
}

/**
 * Textile見出しをソース位置と一意なアンカーID付きで収集する。
 * Markdown混在時はMarkdownフェンス内を除外し、Textileコードブロック内も常に除外する。
 * @param source - 見出しを解析する文書本文。
 * @param skipMarkdownFences - 混在文書のMarkdownフェンス内容を無視する場合はtrue。
 * @returns Textile見出しのアウトライン項目。
 */
function getTextileOutline(source: string, skipMarkdownFences = false): OutlineItem[] {
    const result: OutlineItem[] = [];
    const counts = new Map<string, number>();
    const usedIds = new Set<string>();
    let offset = 0;
    let lineNumber = 0;
    let fenceCharacter: string | undefined;
    let fenceLength = 0;
    let inTextileCode = false;
    let extendedTextileBlock = false;
    let rawPreformatted = false;
    let rawNoTextile = false;
    for (const rawLine of source.split(/(?<=\n)|(?<=\r)(?!\n)/)) {
        const line = rawLine.replace(/(?:\r\n|\r|\n)$/, '');
        const fence = /^\s{0,3}(\x60{3,}|~{3,})/.exec(line);
        if (skipMarkdownFences && fence) {
            const marker = fence[1][0];
            if (!fenceCharacter) {
                fenceCharacter = marker;
                fenceLength = fence[1].length;
            } else if (marker === fenceCharacter && fence[1].length >= fenceLength) {
                fenceCharacter = undefined;
                fenceLength = 0;
            }
            offset += rawLine.length;
            lineNumber += 1;
            continue;
        }
        if (fenceCharacter) {
            offset += rawLine.length;
            lineNumber += 1;
            continue;
        }
        if (extendedTextileBlock && isTextileBlockLead(line)) extendedTextileBlock = false;
        else if (extendedTextileBlock) {
            offset += rawLine.length;
            lineNumber += 1;
            continue;
        }
        if (rawPreformatted) {
            if (/<\/pre\s*>/i.test(line)) rawPreformatted = false;
            offset += rawLine.length;
            lineNumber += 1;
            continue;
        }
        if (rawNoTextile) {
            if (/<\/notextile\s*>/i.test(line)) rawNoTextile = false;
            offset += rawLine.length;
            lineNumber += 1;
            continue;
        }
        if (inTextileCode) {
            if (!line.trim()) inTextileCode = false;
            offset += rawLine.length;
            lineNumber += 1;
            continue;
        }
        if (/<pre\b[^>]*>/i.test(line)) {
            if (!/<\/pre\s*>/i.test(line)) rawPreformatted = true;
            offset += rawLine.length;
            lineNumber += 1;
            continue;
        }
        if (/<notextile\b[^>]*>/i.test(line)) {
            if (!/<\/notextile\s*>/i.test(line)) rawNoTextile = true;
            offset += rawLine.length;
            lineNumber += 1;
            continue;
        }
        if (isTextileExtendedBlockLead(line)) {
            extendedTextileBlock = true;
            offset += rawLine.length;
            lineNumber += 1;
            continue;
        }
        if (/^(?:bc|pre|notextile)(?:\([^)]*\))?(?:\{[^}]*\})?(?:\[[^\]]*\])?\.\s/i.test(line)) {
            inTextileCode = true;
            offset += rawLine.length;
            lineNumber += 1;
            continue;
        }
        const heading = /^h([1-6])(?:[<>=()]*)(?:\([^)]*\))?(?:\{[^}]*\})?(?:\[[^\]]*\])?\.\s+(.+?)\s*$/i.exec(line);
        if (heading) {
            const text = stripTextileHeadingMarkup(heading[2]);
            result.push({
                level: Number(heading[1]),
                text,
                line: lineNumber + 1,
                offset,
                id: nextHeadingAnchorId(text, counts, usedIds)
            });
        }
        offset += rawLine.length;
        lineNumber += 1;
    }
    return result;
}

/**
 * Textile見出しの表示文字列から装飾記号、リンク先、HTML風タグを除去する。
 * @param source - Textile見出しの記法付き本文。
 * @returns slugとアウトライン表示に使う見出し文字列。
 */
function stripTextileHeadingMarkup(source: string): string {
    return source
        .replace(/"([^"\r\n]+)":\S+/g, '$1')
        .replace(/!([^!\r\n(]+)\(([^)]*)\)!/g, '$2')
        .replace(/!([^!\r\n]+)!/g, '')
        .replace(/@([^@\r\n]+)@/g, '$1')
        .replace(/\*\*?([^*\r\n]+)\*\*?/g, '$1')
        .replace(/__?([^_\r\n]+)__?/g, '$1')
        .replace(/\+\+?([^+\r\n]+)\+\+?/g, '$1')
        .replace(/--?([^- \r\n][^- \r\n]*?)--?/g, '$1')
        .replace(/\?\?([^?\r\n]+)\?\?/g, '$1')
        .replace(/<\/?[^>]+>/g, '')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .trim();
}

/**
 * Textile専用文書を空行区切りの原文範囲ごとに描画する。
 * @param source - Textile構文を含む原文。
 * @param options - 画像と表示言語の描画設定。
 * @param highlightCode - 言語クラス付きコードへ使うハイライト関数。
 * @returns サニタイズ前HTMLと編集位置を対応付けたTextileブロック一覧。
 */
function renderTextileDocumentBlocks(
    source: string,
    options: RenderOptions,
    highlightCode?: CodeHighlighter
): UnsafeMarkdownBlock[] {
    const headings = getTextileOutline(source);
    const blocks: UnsafeMarkdownBlock[] = [];
    let imageIndex = 0;

    /**
     * Textileプレビュー内画像へ文書内の通し番号を割り当てる。
     * @returns 次のTextile画像番号。
     */
    function nextTextileImageIndex(): number {
        return imageIndex++;
    }

    for (const range of getTextileSourceRanges(source)) {
        const headingsInRange = headings.filter((heading) => heading.offset >= range.from && heading.offset < range.to);
        appendTextileSourceBlock(
            blocks,
            source,
            range.from,
            range.to,
            headingsInRange,
            options,
            nextTextileImageIndex,
            highlightCode
        );
    }
    return blocks;
}

/**
 * Textile文書を通常ブロックと複数行ブロックに分け、文書スコープの記法は一括変換へ渡す。
 * bc..、pre..、notextile..は次の明示ブロックまで空行を含めて保持する。
 * @param source - 分割せず保持しているTextile原文。
 * @returns ソース位置を保った描画単位。脚注を含む場合は文書全体を一単位で返す。
 */
function getTextileSourceRanges(source: string): Array<{ from: number; to: number }> {
    if (!source.trim()) return [];
    if (/(?:^|\r?\n)\s*fn\d+\./i.test(source)) return [{ from: 0, to: source.length }];

    let sourceOffset = 0;
    const lines = source.split(/(?<=\n)|(?<=\r)(?!\n)/).map(
        /**
         * 各原文行へUTF-16開始・終了位置を付け、描画単位の境界を算出する。
         * @param raw - 改行を含む原文の一行。
         * @returns 行本文と原文範囲。
         */
        (raw) => {
            const from = sourceOffset;
            sourceOffset += raw.length;
            return {
                text: raw.replace(/(?:\r\n|\r|\n)$/, ''),
                from,
                to: from + raw.length
            };
        }
    );
    const ranges: Array<{ from: number; to: number }> = [];
    let blockFrom: number | undefined;
    let blockTo = 0;
    let extendedBlock = false;
    let rawPreformatted = false;
    let rawNoTextile = false;
    let index = 0;

    while (index < lines.length) {
        const line = lines[index];
        if (!line) break;
        if (extendedBlock && isTextileBlockLead(line.text)) {
            if (blockFrom !== undefined) ranges.push({ from: blockFrom, to: line.from });
            blockFrom = undefined;
            extendedBlock = false;
            rawPreformatted = false;
            rawNoTextile = false;
            continue;
        }
        if (blockFrom === undefined && !line.text.trim()) {
            index += 1;
            continue;
        }
        blockFrom ??= line.from;
        blockTo = line.text.trim() || extendedBlock || rawPreformatted ? line.to : line.from;

        if (/<pre\b[^>]*>/i.test(line.text) && !/<\/pre\s*>/i.test(line.text)) rawPreformatted = true;
        if (rawPreformatted && /<\/pre\s*>/i.test(line.text)) rawPreformatted = false;
        if (/<notextile\b[^>]*>/i.test(line.text) && !/<\/notextile\s*>/i.test(line.text)) rawNoTextile = true;
        if (rawNoTextile && /<\/notextile\s*>/i.test(line.text)) rawNoTextile = false;
        if (isTextileExtendedBlockLead(line.text)) extendedBlock = true;
        if (extendedBlock || rawPreformatted || rawNoTextile) {
            blockTo = line.to;
            index += 1;
            continue;
        }
        if (!line.text.trim()) {
            if (blockFrom !== undefined) ranges.push({ from: blockFrom, to: blockTo });
            blockFrom = undefined;
        }
        index += 1;
    }
    if (blockFrom !== undefined) ranges.push({ from: blockFrom, to: blockTo });
    return ranges.filter((range) => range.to > range.from);
}

/**
 * Textileのブロック接頭辞または表行として独立して始まる行か判定する。
 * @param line - 走査中のTextile行。
 * @returns Textileブロック境界として扱う場合はtrue。
 */
function isTextileBlockLead(line: string): boolean {
    return /^(?:p|div|bq|bc|pre|notextile|h[1-6])(?:[<>=()]*)(?:\([^)]*\))?(?:\{[^}]*\})?(?:\[[^\]]*\])?\.{1,2}(?:\s|$)/i.test(line)
        || isTextileTableRow(line)
        || /^(?:p|div|bq|bc|pre|notextile|h[1-6])\.(?:https?:\/\/|\()/i.test(line);
}

/**
 * 次の明示ブロックまで空行を含めて保持するTextile構文か判定する。
 * @param line - 描画単位の先頭候補行。
 * @returns 二重ピリオドの拡張ブロックならtrue。
 */
function isTextileExtendedBlockLead(line: string): boolean {
    return /^(?:p|div|bq|bc|pre|notextile|h[1-6])(?:[<>=()]*)(?:\([^)]*\))?(?:\{[^}]*\})?(?:\[[^\]]*\])?\.\.(?:\s|$)/i.test(line);
}

/**
 * Textileソース範囲を変換し、見出しIDと画像情報を付けてブロック配列へ追加する。
 * @param blocks - 描画結果を追加する配列。
 * @param source - 元文書本文。
 * @param from - ブロック開始位置のUTF-16オフセット。
 * @param to - ブロック終了位置のUTF-16オフセット。
 * @param headingsByOffset - Textile見出しを位置から引く対応表。
 * @param options - 画像と表示言語の描画設定。
 * @param nextImageIndex - 次の文書内画像番号を発行する関数。
 * @param highlightCode - 言語クラス付きコードへ使うハイライト関数。
 */
function appendTextileSourceBlock(
    blocks: UnsafeMarkdownBlock[],
    source: string,
    from: number,
    to: number,
    headings: readonly OutlineItem[],
    options: RenderOptions,
    nextImageIndex: () => number,
    highlightCode?: CodeHighlighter
): void {
    const result = renderTextileOutput(source.slice(from, to), options, nextImageIndex, headings, highlightCode);
    blocks.push({
        html: '<div class="markdown-source-block" data-source-from="' + from + '" data-source-to="' + to + '">' + result.html + '</div>',
        headingOffset: headings.length === 1 ? headings[0]?.offset : undefined,
        headingId: headings.length === 1 ? result.headingIds[0]?.id : undefined,
        headingIds: result.headingIds,
        requiresSanitization: true
    });
}

/**
 * Textile構文をHTMLへ変換し、既存のリンク・画像・見出し属性を適用する。
 * @param source - 変換対象のTextile本文。
 * @param options - リモート画像を含むプレビュー設定。
 * @param nextImageIndex - 次の文書内画像番号を発行する関数。
 * @param headings - このブロックに対応するアウトライン見出し。
 * @param highlightCode - 言語クラス付きコードへ使うハイライト関数。
 * @returns Textile HTMLと対応する見出しID。
 */
function renderTextileOutput(
    source: string,
    options: RenderOptions,
    nextImageIndex: () => number,
    headings: readonly OutlineItem[],
    highlightCode?: CodeHighlighter
): { html: string; headingId?: string; headingIds: Array<{ offset: number; id: string }> } {
    let headingIndex = 0;
    const headingIds: Array<{ offset: number; id: string }> = [];
    let html = renderTextile(source);
    html = highlightTextileCodeBlocks(html, highlightCode);
    html = html.replace(
        /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi,
        /**
         * Textile.jsの見出しへアウトラインと一致するIDを設定する。
         * @param tag - Textile.jsが生成した見出し全体。
         * @param level - h1からh6までの見出しレベル文字列。
         * @param attributes - 見出しの既存属性。
         * @param content - 見出しタグ内の描画本文。
         * @returns 開始タグにIDを付けた見出しHTML。
         */
        (tag, level: string, attributes: string, content: string) => {
            const heading = headings[headingIndex];
            if (!heading || heading.level !== Number(level) || stripTextileHeadingMarkup(content) !== heading.text) return tag;
            headingIndex += 1;
            headingIds.push({ offset: heading.offset, id: heading.id });
            const openingTag = upsertHtmlAttribute(
                upsertHtmlAttribute('<h' + level + attributes + '>', 'id', escapeAttribute(heading.id)),
                'data-mve-heading',
                'true'
            );
            return openingTag + content + '</h' + level + '>';
        }
    );
    html = html.replace(
        /<a\b[^>]*>/gi,
        /**
         * TextileのローカルリンクをHost経由で解決する属性へ変換する。
         * @param tag - Textile.jsが生成したリンク開始タグ。
         * @returns ローカルリンク用data属性を付けた開始タグ。
         */
        (tag) => {
            const href = readHtmlAttribute(tag, 'href');
            if (!href || href.startsWith('#') || !isLocalMarkdownLink(href)) return tag;
            return upsertHtmlAttribute(
                upsertHtmlAttribute(tag, 'href', '#'),
                'data-mve-link',
                href
            );
        }
    );
    html = html.replace(
        /<img\b[^>]*>/gi,
        /**
         * Textile画像にリモート画像ポリシーを適用する。
         * @param tag - Textile.jsが生成した画像要素。
         * @returns 許可された画像要素、または代替文字列。
         */
        (tag) => {
            const sourceUri = readHtmlAttribute(tag, 'src') ?? '';
            if (!options.remoteImagesEnabled && /^https?:/i.test(sourceUri)) {
                const alt = readHtmlAttribute(tag, 'alt') || sourceUri;
                return '<span class="blocked-image">' + escapeHtml(alt) + '</span>';
            }
            return tag;
        }
    );
    const decoratedHtml = decorateHtmlImages(html, nextImageIndex, 'textile');
    const renderHtml = options.renderFormat === 'mixed'
        ? decoratedHtml.replace(
            /<img\b[^>]*>/gi,
            /**
             * Textile画像はMarkdown用のソース書換え機能へ渡さない。
             * @param tag - Textile.jsが生成した装飾済み画像要素。
             * @returns 編集ハンドルを無効にした画像要素。
             */
            (tag) => upsertHtmlAttribute(tag, 'data-mve-resizable', 'false')
        )
        : decoratedHtml;
    return { html: renderHtml, headingId: headingIds[0]?.id, headingIds };
}

/**
 * 言語クラス付きTextile raw HTMLコードを既存のコードハイライト処理へ渡す。
 * @param html - Textile変換後のHTML。
 * @param highlighter - 指定言語の本文をHTMLトークンへ変換する関数。
 * @param trimWrapperNewlines - 混在Markdownのraw HTMLでは、pre/codeタグ直内の整形用改行を一つずつ除く。
 * @returns 認識された言語を持つcode要素へハイライト結果を反映したHTML。
 */
function highlightTextileCodeBlocks(
    html: string,
    highlighter?: CodeHighlighter,
    trimWrapperNewlines = false
): string {
    if (!highlighter) return html;
    return html.replace(
        /<pre\b([^>]*)>\s*<code\b([^>]*)>([\s\S]*?)<\/code\s*>\s*<\/pre\s*>/gi,
        /**
         * 既存のpre/code属性を保ち、言語クラスに対応する本文だけを強調表示する。
         * @param _block - 置換対象のpre要素全体。
         * @param preAttributes - pre要素の開始タグ属性。
         * @param codeAttributes - code要素の開始タグ属性。
         * @param body - エスケープ済みコード本文。
         * @returns 強調表示できた場合は更新したpre要素、未対応言語なら原文要素。
         */
        (block, preAttributes: string, codeAttributes: string, body: string) => {
            const codeOpen = `<code${codeAttributes}>`;
            const classNames = (readHtmlAttribute(codeOpen, 'class') ?? '').split(/\s+/).filter(Boolean);
            const languageCandidates = classNames.map((className) => {
                const languageClass = /^(?:language-|lang-)(.+)$/i.exec(className);
                return languageClass?.[1] ?? className;
            }).filter((language) => language.toLowerCase() !== 'hljs');
            const decodedBody = decodeTextileCodeEntities(body);
            const source = trimWrapperNewlines
                ? decodedBody.replace(/^(?:\r\n|\r|\n)/, '').replace(/(?:\r\n|\r|\n)$/, '')
                : decodedBody;
            let highlighted: string | undefined;
            for (const language of languageCandidates) {
                highlighted = highlighter(source, language);
                if (highlighted !== undefined) break;
            }
            if (highlighted === undefined) return block;
            const updatedClasses = [...new Set([...classNames, 'hljs'])].join(' ');
            const highlightedCodeOpen = upsertHtmlAttribute(codeOpen, 'class', updatedClasses);
            return `<pre${preAttributes}>${highlightedCodeOpen}${highlighted}</code></pre>`;
        }
    );
}

/**
 * Markdownブロック構文と衝突しないTextile接頭辞または表行か判定する。
 * @param line - 現在の文書行。
 * @returns Textileブロックとして解析できる場合はtrue。
 */
function isMixedTextileBlockLead(line: string): boolean {
    return isTextileBlockLead(line);
}

/**
 * Textile表の行形式を判定し、通常の文章中のパイプを除外する。
 * @param line - Textile表候補行。
 * @returns 先頭と末尾を含む複数セル形式の場合はtrue。
 */
function isTextileTableRow(line: string): boolean {
    return /^\|.+\|$/.test(line) && line.indexOf('|', 1) >= 0;
}

/**
 * Textile表のMarkdown混在ブロックをソース先頭から切り出す。
 * 見出しは1行、Textile表は連続する表行、それ以外は空行または次のMarkdownブロックまで。
 * @param source - 現在のMarked入力残部。
 * @returns Textileブロックの原文。開始位置が一致しない場合はundefined。
 */
function readMixedTextileBlock(source: string): string | undefined {
    const firstLine = readSourceLine(source, 0);
    if (!firstLine || !isMixedTextileBlockLead(firstLine.text)) return undefined;
    const heading = /^h[1-6](?:[<>=()]*)(?:\([^)]*\))?(?:\{[^}]*\})?(?:\[[^\]]*\])?\.\s+/i.test(firstLine.text);
    const code = /^(?:bc|pre)(?:\([^)]*\))?(?:\{[^}]*\})?(?:\[[^\]]*\])?\.{1,2}\s+/i.test(firstLine.text);
    const extended = isTextileExtendedBlockLead(firstLine.text);
    const table = isTextileTableRow(firstLine.text);
    if (table && isMarkdownPipeTable(source, firstLine.nextOffset)) return undefined;
    let end = firstLine.nextOffset;
    if (heading || firstLine.nextOffset === source.length) return source.slice(0, end);
    let cursor = end;
    while (cursor < source.length) {
        const line = readSourceLine(source, cursor);
        if (!line) break;
        if (extended && isTextileBlockLead(line.text)) break;
        if (!line.text.trim()) {
            if (extended) {
                end = line.nextOffset;
                cursor = line.nextOffset;
                continue;
            }
            break;
        }
        if (table) {
            if (!isTextileTableRow(line.text)) break;
        } else if (!code && isMarkdownBlockStart(line.text)) {
            break;
        }
        end = line.nextOffset;
        cursor = line.nextOffset;
    }
    return source.slice(0, end);
}

/**
 * Textile表候補の直後に1列以上のMarkdown GFM区切り行があるか判定する。
 * @param source - 表候補から始まるMarkdown本文。
 * @param nextOffset - 1行目の直後にある次行の開始位置。
 * @returns Markdown表として認識される場合はtrue。
 */
function isMarkdownPipeTable(source: string, nextOffset: number): boolean {
    const separator = readSourceLine(source, nextOffset)?.text;
    return Boolean(separator && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(separator));
}

/**
 * Markdown独自拡張と衝突しないTextile phrase modifierの候補正規表現。
 * 単語境界は候補が見つかった後にコードポイント単位で確認し、全文描画での正規表現負荷を抑える。
 */
const MIXED_TEXTILE_PHRASE_PATTERN = /(?<!\+)\+(?!\+)[^+\s\r\n](?:[^+\r\n]*[^+\s\r\n])?\+(?!\+)|(?<!-)-(?!-)[^-\s\r\n](?:[^-\r\n]*[^-\s\r\n])?-(?!-)|(?<!\?)\?\?(?!\?)[^?\s\r\n](?:[^?\r\n]*[^?\s\r\n])?\?\?(?!\?)/;

/** Textile phrase候補を現在位置で確認し、各文字位置からの再検索を避けるsticky matcher。 */
const MIXED_TEXTILE_PHRASE_AT_POSITION = new RegExp(MIXED_TEXTILE_PHRASE_PATTERN.source, 'y');
/** Textileリンク候補を現在位置で確認するsticky matcher。 */
const MIXED_TEXTILE_LINK_AT_POSITION = /"[^"\r\n]+":\S/y;
/** Textile shortcut linkをMarkdown linkと区別して確認するsticky matcher。 */
const MIXED_TEXTILE_REFERENCE_LINK_AT_POSITION = /\[[a-z][\w-]*\]https?:\/\/[^\s\]]+/iy;
/** Textile画像の後ろにリンクURLが続くNotePM形式を確認するsticky matcher。 */
const MIXED_TEXTILE_LINKED_IMAGE_AT_POSITION = /!(?!\[)[^!\s()]+(?:\([^)]*\))?!https?:\/\/[^\s]+/y;
/** Textile画像候補を現在位置で確認するsticky matcher。 */
const MIXED_TEXTILE_IMAGE_AT_POSITION = /!(?!\[)[^!\s()]+(?:\([^)]*\))?!/y;
/** Textileのclass付きphrase span候補を現在位置で確認するsticky matcher。 */
const MIXED_TEXTILE_CLASS_SPAN_AT_POSITION = /%\([a-z][\w-]*\)[^%\r\n]+%/iy;
/** Textile inline code候補を現在位置で確認するsticky matcher。 */
const MIXED_TEXTILE_CODE_AT_POSITION = /@[^@\r\n]+@/y;
/**
 * Textile固有の綴りがない文書で境界解析を省略する広い候補検査。
 * コードやHTML内の一致も許容し、正確な判定は後続の状態付き走査に任せる。
 */
const MIXED_TEXTILE_SYNTAX_HINT = /^(?: {0,3}(?:h[1-6]|p|div|bq|bc|pre|notextile)\S*\.(?:\.|[ \t]))|"(?:\([^)]+\)\.\s*)?[^"\r\n]+":\S+|\[[a-z][\w-]*\]https?:\/\/|!(?!\[)[^!\s()]+(?:\([^)]*\))?!|@[^@\r\n]+@|%\([a-z][\w-]*\)[^%\r\n]+%|(?<![\w+])\+(?!\+)[^\s+\r\n](?:[^+\r\n]*[^\s+\r\n])?\+(?![+\w])|(?<![\w>-])-(?!-)[^\s\r\n-](?:[^-\r\n]*[^-\s\r\n])?-(?![-\w>])|(?<!\w)\?\?(?!\?)[^\s?\r\n](?:[^?\r\n]*[^\s?\r\n])?\?\?(?!\?)(?!\w)/im;

/**
 * Textileブロック見出しが混在文書に含まれる場合だけ、重複回避用の共有アウトラインを作る。
 * @param source - Textile見出し候補を含む混在文書。
 * @returns Textileのh1.からh6.で始まる行が存在する場合はtrue。
 */
function hasMixedTextileHeadingCandidate(source: string): boolean {
    return /^h[1-6](?:[<>=()]*)(?:\([^)]*\))?(?:\{[^}]*\})?(?:\[[^\]]*\])?\.\s+/im.test(source);
}

/**
 * Textileブロックと記号を含む行だけ詳しく調べ、Markdownコード内の候補を除外する。
 * @param source - 構文候補を調べるMarkdown本文。
 * @returns 表示可能な範囲にTextile構文候補が見つかった場合はtrue。
 */
function hasMixedTextileSyntaxCandidate(source: string): boolean {
    if (!MIXED_TEXTILE_SYNTAX_HINT.test(source)) return source.includes('|') && hasNonMarkdownTextileTable(source);
    let fenceCharacter: string | undefined;
    let fenceLength = 0;
    let lineOffset = 0;
    // 通常文字は正規表現エンジンでまとめて飛ばし、記法候補だけ境界判定する。
    const inlineCandidates = /[\x60<"'!\[%@+\-?]/g;
    while (lineOffset < source.length) {
        const line = readSourceLine(source, lineOffset);
        if (!line) return false;
        const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line.text);
        if (fenceCharacter) {
            const isClosingFence = fence
                && fence[1][0] === fenceCharacter
                && fence[1].length >= fenceLength
                && !line.text.slice(fence[0].length).trim();
            if (isClosingFence) {
                fenceCharacter = undefined;
                fenceLength = 0;
            }
            lineOffset = line.nextOffset;
            continue;
        }
        if (fence) {
            fenceCharacter = fence[1][0];
            fenceLength = fence[1].length;
            lineOffset = line.nextOffset;
            continue;
        }
        if (isMixedTextileBlockLead(line.text)) return true;
        if (isTextileTableRow(line.text)) {
            const separator = readSourceLine(source, line.nextOffset);
            if (separator && isMarkdownPipeTable(source, line.nextOffset)) {
                lineOffset = separator.nextOffset;
                while (lineOffset < source.length) {
                    const row = readSourceLine(source, lineOffset);
                    if (!row || !isTextileTableRow(row.text)) break;
                    lineOffset = row.nextOffset;
                }
                continue;
            }
            return true;
        }
        let cursor = lineOffset;
        while (cursor < line.nextOffset) {
            inlineCandidates.lastIndex = cursor;
            const candidate = inlineCandidates.exec(source);
            if (!candidate || candidate.index >= line.nextOffset) break;
            cursor = candidate.index;
            const character = source[cursor];
            if (character === '`') {
                cursor = skipMarkdownInlineCode(source, cursor, line.nextOffset);
                continue;
            }
            if (character === '<') {
                cursor = skipHtmlTag(source, cursor, line.nextOffset);
                continue;
            }
            const linkedImage = character === '!'
                && matchesTextileCandidateAt(MIXED_TEXTILE_LINKED_IMAGE_AT_POSITION, source, cursor);
            const matcher = character === '"' ? MIXED_TEXTILE_LINK_AT_POSITION
                : character === '[' ? MIXED_TEXTILE_REFERENCE_LINK_AT_POSITION
                    : character === '!' ? linkedImage
                        ? MIXED_TEXTILE_LINKED_IMAGE_AT_POSITION
                        : MIXED_TEXTILE_IMAGE_AT_POSITION
                        : character === '%' ? MIXED_TEXTILE_CLASS_SPAN_AT_POSITION
                        : character === '@' ? MIXED_TEXTILE_CODE_AT_POSITION
                            : character === '+' || character === '-' || character === '?'
                                ? MIXED_TEXTILE_PHRASE_AT_POSITION : undefined;
            if (!matcher) {
                cursor += 1;
                continue;
            }
            if (isMarkdownEscaped(source, cursor)) {
                cursor += 1;
                continue;
            }
            if (matcher === MIXED_TEXTILE_PHRASE_AT_POSITION) {
                if (matchesMixedTextilePhraseAt(source, cursor)) return true;
            } else if (matcher && matchesTextileCandidateAt(matcher, source, cursor)) {
                return true;
            }
            cursor += 1;
        }
        lineOffset = line.nextOffset;
    }
    return false;
}

/**
 * Textile表候補だけを検索し、GFM区切り行で確認できるMarkdown表は飛ばす。
 * @param source - 表候補を含む可能性のあるMarkdown本文。
 * @returns Markdown表以外のTextile表行が見つかった場合はtrue。
 */
function hasNonMarkdownTextileTable(source: string): boolean {
    let pipeOffset = source.indexOf('|');
    while (pipeOffset >= 0) {
        const lineStart = Math.max(
            source.lastIndexOf('\n', pipeOffset - 1),
            source.lastIndexOf('\r', pipeOffset - 1)
        ) + 1;
        const line = readSourceLine(source, lineStart);
        if (!line) return false;
        if (isTextileTableRow(line.text)) {
            const separator = readSourceLine(source, line.nextOffset);
            if (separator && isMarkdownPipeTable(source, line.nextOffset)) {
                pipeOffset = source.indexOf('|', separator.nextOffset);
                while (pipeOffset >= 0) {
                    const rowStart = Math.max(
                        source.lastIndexOf('\n', pipeOffset - 1),
                        source.lastIndexOf('\r', pipeOffset - 1)
                    ) + 1;
                    const row = readSourceLine(source, rowStart);
                    if (!row || !isTextileTableRow(row.text)) break;
                    pipeOffset = source.indexOf('|', row.nextOffset);
                }
                continue;
            }
            return true;
        }
        pipeOffset = source.indexOf('|', line.nextOffset);
    }
    return false;
}

/**
 * Textile候補matcherを現在位置から実行し、グローバル検索状態を残さない。
 * @param matcher - Textileリンク、画像、code、phraseのsticky正規表現。
 * @param source - 混在Markdown本文。
 * @param offset - 現在走査しているUTF-16位置。
 * @returns matcherが現在位置から始まる候補を認識した場合はtrue。
 */
function matchesTextileCandidateAt(matcher: RegExp, source: string, offset: number): boolean {
    matcher.lastIndex = offset;
    return matcher.exec(source)?.index === offset;
}

/**
 * Textile phrase候補を検査し、前後が単語文字なら記法として扱わない。
 * @param source - 現在の混在Markdown本文。
 * @param offset - Textile記号の候補位置。
 * @returns 完全なphrase候補が単語境界にある場合はtrue。
 */
function matchesMixedTextilePhraseAt(source: string, offset: number): boolean {
    MIXED_TEXTILE_PHRASE_AT_POSITION.lastIndex = offset;
    const match = MIXED_TEXTILE_PHRASE_AT_POSITION.exec(source);
    return match?.index === offset
        && !isUnicodeWordCharacterBefore(source, offset)
        && !isUnicodeWordCharacterAt(source, offset + match[0].length);
}

/**
 * Markedのinline start hook用に次の有効Textile phrase開始位置を探す。
 * @param source - 現在のMarked inline入力残部。
 * @returns 有効候補の位置、または候補がない場合はundefined。
 */
function findMixedTextilePhraseCandidate(source: string): number | undefined {
    for (let offset = 0; offset < source.length; offset += 1) {
        const character = source[offset];
        if (character !== '+' && character !== '-' && character !== '?') continue;
        if (isMarkdownEscaped(source, offset)) continue;
        if (matchesMixedTextilePhraseAt(source, offset)) return offset;
    }
    return undefined;
}

/**
 * UTF-16位置にあるUnicode文字が英数字、漢字、かななどの単語文字か確認する。
 * @param source - 判定対象文字列。
 * @param offset - コードポイント開始位置。
 * @returns 文字がUnicode文字・数値・アンダースコアの場合はtrue。
 */
function isUnicodeWordCharacterAt(source: string, offset: number): boolean {
    if (offset < 0 || offset >= source.length) return false;
    const codePoint = source.codePointAt(offset);
    return codePoint !== undefined && /[\p{L}\p{N}_]/u.test(String.fromCodePoint(codePoint));
}

/**
 * UTF-16位置直前のUnicodeコードポイントが単語文字か確認する。
 * @param source - 判定対象文字列。
 * @param offset - 判定境界位置。
 * @returns 直前の文字がUnicode文字・数値・アンダースコアの場合はtrue。
 */
function isUnicodeWordCharacterBefore(source: string, offset: number): boolean {
    if (offset <= 0) return false;
    let previousIndex = offset - 1;
    const trailingUnit = source.charCodeAt(previousIndex);
    if (trailingUnit >= 0xdc00 && trailingUnit <= 0xdfff && previousIndex > 0) {
        const leadingUnit = source.charCodeAt(previousIndex - 1);
        if (leadingUnit >= 0xd800 && leadingUnit <= 0xdbff) previousIndex -= 1;
    }
    return isUnicodeWordCharacterAt(source, previousIndex);
}

/**
 * Markdownの同一行内にあるbacktick code spanを飛び越し、その内部を候補検査から除外する。
 * @param source - 混在Markdown本文。
 * @param offset - 開始backtickの位置。
 * @param lineEnd - 現在行の終端位置。
 * @returns 対応する閉じ記号の後、または開始記号の直後の位置。
 */
function skipMarkdownInlineCode(source: string, offset: number, lineEnd: number): number {
    let markerEnd = offset;
    while (markerEnd < lineEnd && source[markerEnd] === '`') markerEnd += 1;
    const markerLength = markerEnd - offset;
    let cursor = markerEnd;
    while (cursor < lineEnd) {
        const nextMarker = source.indexOf('`', cursor);
        if (nextMarker < 0 || nextMarker >= lineEnd) return markerEnd;
        let nextMarkerEnd = nextMarker;
        while (nextMarkerEnd < lineEnd && source[nextMarkerEnd] === '`') nextMarkerEnd += 1;
        if (nextMarkerEnd - nextMarker === markerLength) return nextMarkerEnd;
        cursor = nextMarkerEnd;
    }
    return markerEnd;
}

/**
 * HTML tagまたはautolinkを飛び越え、属性内のTextile記号を候補から除外する。
 * @param source - 混在Markdown本文。
 * @param offset - 開始山括弧の位置。
 * @param lineEnd - 現在行の終端位置。
 * @returns 閉じ山括弧の後、または開始山括弧の直後の位置。
 */
function skipHtmlTag(source: string, offset: number, lineEnd: number): number {
    let quote: string | undefined;
    for (let cursor = offset + 1; cursor < lineEnd; cursor += 1) {
        const character = source[cursor];
        if (quote) {
            if (character === quote) quote = undefined;
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '>') {
            return cursor + 1;
        }
    }
    return offset + 1;
}

/**
 * Markdownのbackslash escapeに含まれる記号をTextile候補から除外する。
 * @param source - 混在Markdown本文。
 * @param offset - escapeされているか確認する記号位置。
 * @returns 直前の連続backslash数が奇数の場合はtrue。
 */
function isMarkdownEscaped(source: string, offset: number): boolean {
    let backslashes = 0;
    for (let cursor = offset - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) backslashes += 1;
    return backslashes % 2 === 1;
}

/**
 * Markdown本文の指定位置から改行コードを保って1行読む。
 * @param source - 原文本文。
 * @param offset - 読み始めるUTF-16オフセット。
 * @returns 行本文と次の行の開始位置。本文末尾ならundefined。
 */
function readSourceLine(source: string, offset: number): { text: string; nextOffset: number } | undefined {
    if (offset >= source.length) return undefined;
    const match = /[^\r\n]*(?:\r\n|\r|\n|$)/.exec(source.slice(offset));
    if (!match || !match[0]) return undefined;
    const raw = match[0];
    return {
        text: raw.replace(/(?:\r\n|\r|\n)$/, ''),
        nextOffset: offset + raw.length
    };
}

/**
 * Textile段落切り出し時にMarkdownの明確なブロック構文を優先する。
 * @param line - 次のソース行。
 * @returns 見出し、フェンス、引用、リストまたはHTML開始行ならtrue。
 */
function isMarkdownBlockStart(line: string): boolean {
    return /^(?: {0,3}(?:#{1,6}\s|\x60{3,}|~{3,}|>\s|[-+*]\s|\d+[.)]\s)| {0,3}<[A-Za-z!/])/.test(line);
}

/**
 * TextileブロックをMarkedのカスタムトークンとして登録する。
 * @param options - 画像と表示言語の描画設定。
 * @param highlighter - 言語クラス付きコードへ使うハイライト関数。
 * @param nextImageIndex - 文書内画像番号を発行する関数。
 * @param headingsAtOffset - ソース位置に対応する見出し一覧を取得する関数。
 * @param setRenderedHeadingId - HTML化した見出しIDを受け取る処理。
 * @param activeSourceOffset - 今描画中のMarkedトークンのソース開始位置を返す関数。
 * @returns 明示的なTextileブロックを描画するMarked拡張。
 */
function createMixedTextileBlockExtension(
    options: RenderOptions,
    highlighter: CodeHighlighter | undefined,
    nextImageIndex: () => number,
    headingsAtOffset: (offset: number) => readonly OutlineItem[],
    setRenderedHeadingId: (headingId: string | undefined) => void,
    activeSourceOffset: () => number | undefined
): TokenizerAndRendererExtension {
    return {
        name: 'mveTextileBlock',
        level: 'block',
        tokenizer:
            /**
             * 明示的なTextileブロックのみをMarkedカスタムトークンへ変換する。
             * @param source - 現在のMarked入力残部。
             * @returns Textileブロックトークン、またはMarkdownへ処理を戻すundefined。
             */
            (source) => {
                const raw = readMixedTextileBlock(source);
                return raw ? { type: 'mveTextileBlock', raw, text: raw } : undefined;
            },
        renderer:
            /**
             * Textileブロックを変換し、描画した見出しIDをアウトライン経路へ返す。
             * @param token - Textileブロックとして認識済みのMarkedトークン。
             * @returns Textile.jsが生成した未サニタイズHTML。
             */
            (token) => {
                const offset = activeSourceOffset();
                const result = renderTextileOutput(
                    token.raw,
                    options,
                    nextImageIndex,
                    offset === undefined ? [] : headingsAtOffset(offset),
                    highlighter
                );
                setRenderedHeadingId(result.headingId);
                return result.html;
            }
    };
}

/**
 * Markdown優先の混在文書にTextileリンク、画像、インラインコードを追加する。
 * Markdown書式記号の解釈はMarkedへ残す。
 * @param options - リモート画像許可状態を含む混在Markdown描画設定。
 * @param blockedImageMessage - リモート画像が無効なときに代替表示へ設定する説明。
 * @returns Textile固有インライン構文を処理するMarked拡張一覧。
 */
function createMixedTextileInlineExtensions(
    options: RenderOptions,
    blockedImageMessage: string
): TokenizerAndRendererExtension[] {
    return [
        {
            name: 'mveTextileReferenceLink',
            level: 'inline',
            start:
                /**
                 * Textile shortcut linkの英字ラベルとURLの組み合わせを探す。
                 * @param source - 現在位置以降のMarked inline入力残部。
                 * @returns 次のTextile shortcut link候補位置。候補がなければundefined。
                 */
                (source) => /\[[a-z][\w-]*\]https?:\/\/[^\s\]]+/i.exec(source)?.index,
            tokenizer:
                /**
                 * Markdownの角括弧リンクと衝突しないTextile shortcut linkを認識する。
                 * @param source - 現在のMarked inline入力残部。
                 * @returns Textile shortcut link token、または未認識時のundefined。
                 */
                (source) => {
                    const match = /^\[([a-z][\w-]*)\](https?:\/\/[^\s\]]+)/i.exec(source);
                    const destination = match ? splitTrailingTextileLinkPunctuation(match[2]) : undefined;
                    return match
                        ? { type: 'mveTextileReferenceLink', raw: match[0], href: destination?.href, trailing: destination?.trailing, text: match[1] }
                        : undefined;
                },
            renderer:
                /**
                 * Textile shortcut linkを安全な表示名とURI属性へ変換する。
                 * @param token - Textile shortcut link token。
                 * @returns リンク先の種類を保持したHTMLアンカー。
                 */
                (token) => renderMixedTextileLink(token.href, escapeHtml(token.text)) + escapeHtml(token.trailing ?? '')
        },
        {
            name: 'mveTextileLink',
            level: 'inline',
            start:
                /**
                 * Textileリンクらしい引用符までMarkedの走査位置を進める。
                 * @param source - 現在位置以降のMarked inline入力残部。
                 * @returns 次のTextileリンク候補位置。候補がない場合はundefined。
                 */
                (source) => /"[^"\r\n]+":\S/.exec(source)?.index,
            tokenizer:
                /**
                 * Textileリンク構文をMarkdownリンクと衝突しない位置で認識する。
                 * @param source - 現在のMarked inline入力残部。
                 * @returns Textileリンクトークン、または未認識時のundefined。
                 */
                (source) => {
                    const match = /^"(?:\(([^)]+)\)\.\s*)?([^"\r\n]+)":([^\s<>]+)/.exec(source);
                    const destination = match ? splitTrailingTextileLinkPunctuation(match[3]) : undefined;
                    return match
                        ? { type: 'mveTextileLink', raw: match[0], href: destination?.href, trailing: destination?.trailing, text: match[2], className: match[1] }
                        : undefined;
                },
            renderer:
                /**
                 * TextileリンクをHTMLへ出力し、ローカルURIはHost解決属性へ置き換える。
                 * @param token - Textileリンクトークン。
                 * @returns HTMLアンカー要素。
                 */
                (token) => {
                    const label = escapeHtml(token.text);
                    return renderMixedTextileLink(token.href, label, token.className) + escapeHtml(token.trailing ?? '');
                }
        },
        {
            name: 'mveTextileImage',
            level: 'inline',
            start:
                /**
                 * Markdown画像ではないTextile画像の開始位置をMarkedへ伝える。
                 * @param source - 現在位置以降のMarked inline入力残部。
                 * @returns 次のTextile画像候補位置。候補がない場合はundefined。
                 */
                (source) => /!(?!\[)[^!\s()]+(?:\([^)]*\))?!/.exec(source)?.index,
            tokenizer:
                /**
                 * Textile画像記法をMarkdown画像記法と区別して認識する。
                 * @param source - 現在のMarked inline入力残部。
                 * @returns Textile画像トークン、または未認識時のundefined。
                 */
                (source) => {
                    const match = /^!(?!\[)([^!\s()]+)(?:\(([^)]*)\))?!(https?:\/\/[^\s]+)?/i.exec(source);
                    const destination = match?.[3]
                        ? splitTrailingTextileLinkPunctuation(match[3])
                        : undefined;
                    return match
                        ? {
                            type: 'mveTextileImage',
                            raw: match[0],
                            href: match[1],
                            text: match[2] ?? '',
                            target: destination?.href,
                            trailing: destination?.trailing
                        }
                        : undefined;
                },
            renderer:
                /**
                 * Textile画像をソース書換えハンドルなしで出力し、Markdown画像の連番を保つ。
                 * @param token - Textile画像トークン。
                 * @returns 画像、または無効化されたリモート画像の代替表示。
                 */
                (token) => {
                    const image = renderMixedTextileImage(token.href, token.text, options, blockedImageMessage);
                    return token.target
                        ? renderMixedTextileLink(token.target, image) + escapeHtml(token.trailing ?? '')
                        : image;
                }
        },
        {
            name: 'mveTextileCode',
            level: 'inline',
            start:
                /**
                 * Textile @code@候補までMarkedの通常文字走査を省略する。
                 * @param source - 現在位置以降のMarked inline入力残部。
                 * @returns 次のTextile code候補位置。候補がない場合はundefined。
                 */
                (source) => /@[^@\r\n]+@/.exec(source)?.index,
            tokenizer:
                /**
                 * Textile @code@ を認識し、Markdownバッククォートとは別に扱う。
                 * @param source - 現在のMarked inline入力残部。
                 * @returns Textile code token、または未認識時のundefined。
                 */
                (source) => {
                    const match = /^@([^@\r\n]+)@/.exec(source);
                    return match
                        ? { type: 'mveTextileCode', raw: match[0], text: match[1] }
                        : undefined;
                },
            renderer:
                /**
                 * Textile inline code本文をHTML要素用にエスケープする。
                 * @param token - Textile inline code token。
                 * @returns HTML code要素。
                 */
                (token) => '<code>' + escapeHtml(token.text) + '</code>'
        },
        {
            name: 'mveTextileClassSpan',
            level: 'inline',
            start:
                /**
                 * Textileのclass付きphrase spanをMarkdown本文から探す。
                 * @param source - 現在位置以降のMarked inline入力残部。
                 * @returns 次のclass付きspan候補位置。候補がなければundefined。
                 */
                (source) => /%\([a-z][\w-]*\)[^%\r\n]+%/i.exec(source)?.index,
            tokenizer:
                /**
                 * Textile class spanのクラスと本文を認識する。
                 * @param source - 現在のMarked inline入力残部。
                 * @returns class span token、または未認識時のundefined。
                 */
                (source) => {
                    const match = /^%\(([a-z][\w-]*)\)([^%\r\n]+)%/i.exec(source);
                    return match
                        ? { type: 'mveTextileClassSpan', raw: match[0], className: match[1], text: match[2] }
                        : undefined;
                },
            renderer:
                /**
                 * Textile class spanをclass属性とエスケープ済み本文で出力する。
                 * @param token - class名と本文を持つTextile span token。
                 * @returns サニタイズ前のspan HTML。
                 */
                (token) => '<span class="' + escapeAttribute(token.className) + '">' + escapeHtml(token.text) + '</span>'
        },
        {
            name: 'mveTextilePhrase',
            level: 'inline',
            start:
                /**
                 * Markedの通常テキストを次のphrase modifier直前で分割する。
                 * @param source - 現在位置以降のMarked inline本文。
                 * @returns 次の有効候補位置。候補がない場合はundefined。
                 */
                (source) => findMixedTextilePhraseCandidate(source),
            tokenizer:
                /**
                 * Markdownと記号の意味が重ならないTextile phrase modifierを認識する。
                 * Markedがコード範囲を処理した後にだけ呼ばれ、GFM二重チルダを優先させる。
                 * @param source - 現在のMarked inline入力残部。
                 * @returns Textile phrase token、または未認識時のundefined。
                 */
                (source) => {
                    const marker = source.startsWith('??') ? '??' : source[0];
                    if (marker !== '+' && marker !== '-' && marker !== '??') {
                        return undefined;
                    }
                    if (marker !== '??' && source.startsWith(marker + marker)) {
                        return undefined;
                    }
                    const end = source.indexOf(marker, marker.length);
                    if (end <= marker.length) return undefined;
                    if (marker !== '??' && source[end + 1] === marker) return undefined;
                    const text = source.slice(marker.length, end);
                    if (/^\s|\s$/.test(text)) return undefined;
                    const raw = source.slice(0, end + marker.length);
                    return { type: 'mveTextilePhrase', raw, marker, text };
                },
            renderer:
                /**
                 * Textile phrase modifier本文を対応するHTML要素で囲み、本文をエスケープする。
                 * @param token - Textile phrase markerと本文を持つトークン。
                 * @returns サニタイズ前のins、del、cite、sup、sub要素。
                 */
                (token) => {
                    const tag = token.marker === '+' ? 'ins'
                        : token.marker === '-' ? 'del'
                            : token.marker === '??' ? 'cite' : undefined;
                    return tag ? '<' + tag + '>' + escapeHtml(token.text) + '</' + tag + '>' : escapeHtml(token.text);
                }
        }
    ];
}

/**
 * 混在Markdown内のTextile画像をMarkdownソース編集用の画像連番に混ぜず描画する。
 * @param href - Textile画像ソースURI。
 * @param alt - Textile画像の代替文字列。
 * @param options - リモート画像許可状態を含む描画設定。
 * @param blockedImageMessage - リモート画像を表示できないときの説明。
 * @returns サニタイズ前の画像要素またはブロック表示。
 */
function renderMixedTextileImage(
    href: string,
    alt: string,
    options: RenderOptions,
    blockedImageMessage: string
): string {
    if (!options.remoteImagesEnabled && /^https?:/i.test(href)) {
        return '<span class="blocked-image" title="' + escapeAttribute(blockedImageMessage) + '">'
            + escapeHtml(alt || href)
            + '</span>';
    }
    const source = escapeAttribute(href);
    return '<img src="' + source + '" loading="lazy" decoding="async" data-original-src="' + source
        + '" data-mve-image-kind="textile" data-mve-image-align="left" data-mve-resizable="false"'
        + ' data-mve-can-reset="false" alt="' + escapeAttribute(alt) + '">';
}

/**
 * 混在Markdown内のTextileリンクをローカルURI解決属性または通常hrefで出力する。
 * @param href - リンク先URI。
 * @param content - エスケープ済みラベルまたは生成済み画像要素。
 * @param className - Textileリンクへ任意指定されたclass属性。
 * @returns サニタイズ前のアンカー要素。
 */
function renderMixedTextileLink(href: string, content: string, className?: string): string {
    const classAttribute = className ? ' class="' + escapeAttribute(className) + '"' : '';
    if (isLocalMarkdownLink(href)) {
        return '<a' + classAttribute + ' href="#" data-mve-link="' + escapeAttribute(href) + '">' + content + '</a>';
    }
    return '<a' + classAttribute + ' href="' + escapeAttribute(href) + '">' + content + '</a>';
}

/**
 * Textileリンクの直後にある通常文の句読点をリンク先URIから分離する。
 * @param href - 記法中のリンク先と、続けて入力された句読点。
 * @returns URI本体とアンカー外へ戻す句読点。
 */
function splitTrailingTextileLinkPunctuation(href: string): { href: string; trailing: string } {
    const punctuation = /[.,;!?]+$/u.exec(href)?.[0] ?? '';
    return punctuation
        ? { href: href.slice(0, -punctuation.length), trailing: punctuation }
        : { href, trailing: '' };
}

/**
 * HTML内の画像要素へ連番のdata属性を付ける。
 * @param html - 表示または出力するHTML本文。
 * @param nextIndex 次の画像インデックスを取得する関数。
 * @param kind 画像DOMに付与する描画形式。省略時は従来のHTML形式。
 * @returns 画像属性を補完したHTML。
 */
function decorateHtmlImages(
    html: string,
    nextIndex: () => number,
    kind: 'html' | 'textile' = 'html'
): string {
    return html.replace(
        /<img\b[^>]*>/gi,
        /**
         * 画像の元URI、プレビュー番号、形式、配置属性を既定値にそろえる。
         * @param tag - 正規表現に一致したHTMLのimg開始タグ。
         * @returns プレビュー属性を持つ画像開始タグ。
         */
        (tag) => {
            const source = readHtmlAttribute(tag, 'src') ?? '';
            const index = nextIndex();
            let decorated = upsertHtmlAttribute(tag, 'data-original-src', readHtmlAttribute(tag, 'data-original-src') ?? source);
            decorated = upsertHtmlAttribute(decorated, 'data-mve-image-index', String(index));
            decorated = upsertHtmlAttribute(decorated, 'data-mve-image-kind', kind);
            decorated = upsertHtmlAttribute(decorated, 'data-mve-image-align', normalizeImageAlignment(readHtmlAttribute(tag, 'align')));
            decorated = upsertHtmlAttribute(decorated, 'data-mve-resizable', /^https?:\/\//i.test(source) ? 'false' : 'true');
            decorated = upsertHtmlAttribute(decorated, 'data-mve-can-reset', hasHtmlAttribute(tag, 'width') ? 'true' : 'false');
            if (!readHtmlAttribute(tag, 'loading')) decorated = upsertHtmlAttribute(decorated, 'loading', 'lazy');
            if (!readHtmlAttribute(tag, 'decoding')) decorated = upsertHtmlAttribute(decorated, 'decoding', 'async');
            return decorated;
        }
    );
}

/**
 * 画像配置をleft、center、rightの有効値へ正規化する。
 * @param value - HTML画像タグから読み取った配置属性値。
 * @returns left、center、rightのいずれか。
 */
function normalizeImageAlignment(value: string | undefined): 'left' | 'center' | 'right' {
    return value === 'center' || value === 'right' ? value : 'left';
}

/**
 * HTMLタグから指定属性の引用符付きまたは引用符なしの値を読み取る。
 * @param tag - HTML属性を読み取る画像要素タグ全体。
 * @param name - 読み取るHTML属性名。
 * @returns 属性値。属性がない場合はundefined。
 */
function readHtmlAttribute(tag: string, name: string): string | undefined {
    const pattern = new RegExp(`\\s${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = pattern.exec(tag);
    return match?.[1] ?? match?.[2] ?? match?.[3];
}

/**
 * 指定属性があれば値を置換し、なければ閉じ括弧の直前へ追加する。
 * @param tag - 属性を書き換えるHTML要素タグ全体。
 * @param name - 更新するHTML属性名。
 * @param value - HTML属性へ設定する未エスケープの値。
 * @returns 属性値をHTMLエスケープして反映したタグ文字列。
 */
function upsertHtmlAttribute(tag: string, name: string, value: string): string {
    const pattern = new RegExp(`\\s${escapeRegExp(name)}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
    const escaped = escapeAttribute(value);
    if (pattern.test(tag)) return tag.replace(pattern, ` ${name}="${escaped}"`);
    const closing = tag.endsWith('/>') ? '/>' : '>';
    return tag.slice(0, -closing.length) + ` ${name}="${escaped}"` + closing;
}

/**
 * Markdown変換の条件を判定する。
 * @param tag - 属性の有無を検査するHTML要素タグ全体。
 * @param name - 検査するHTML属性名。
 * @returns 条件が成立したかを示す真偽値。
 */
function hasHtmlAttribute(tag: string, name: string): boolean {
    return new RegExp(`\\s${escapeRegExp(name)}\\s*=`, 'i').test(tag);
}

/**
 * 正規表現のメタ文字をリテラルとして扱えるようにエスケープする。
 * @param value - 正規表現へ埋め込む前にメタ文字をエスケープする文字列。

 */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 強調・挿入・上付き・下付き記法用のMarked inline extensionを生成する。
 * @param name - Markdown tokenを囲む出力HTML要素名。
 * @param rule - 対象のインライン区切り記法を検出する正規表現。
 * @param tag - tokenizerが認識した本文を囲むHTML要素名。
 * @returns 開始位置検索・token生成・装飾描画を行うextension。
 */
function inlineDelimited(name: string, rule: RegExp, tag: string): any {
    return {
        name,
        level: 'inline',
        /**
         * Markdown変換の表示または操作を開始する。
         * @param source - 解析・描画・変換の起点となる本文。

         */
        start(source: string) {
            const markers: Record<string, string> = { highlight: '==', inserted: '++', superscript: '^', subscript: '~' };
            const found = source.indexOf(markers[name]);
            return found >= 0 ? found : undefined;
        },
        /**
         * カスタム記法に一致した本文からMarked inline tokenを生成する。
         * @param source - 解析・描画・変換の起点となる本文。
         * @returns Markdown変換のtokenizerが生成する結果。
         */
        tokenizer(source: string) {
            const match = rule.exec(source);
            if (!match) return undefined;
            const token: CustomToken = { type: name, raw: match[0], text: match[1] };
            token.tokens = this.lexer.inlineTokens(token.text);
            return token;
        },
        /**
         * カスタムinline tokenの内容をHTMLへ描画する。
         * @param this - インライン解析を実行するMarked rendererのthisコンテキスト。
         * @param token - Markdown変換で走査または更新する要素。
         * @returns カスタムinline tokenから生成したHTML。
         */
        renderer(this: {
            /** Custom inline tokenをMarkdown HTMLへ変換するMarked parser。 */
            parser: {
                /**
                 * Marked inline token列をHTMLへ変換する。
                 * @param tokens - HTMLへ変換するMarked inline tokenの一覧。
                 * @returns 変換後のHTML文字列。
                 */
                parseInline: (tokens: Token[]) => string
            }
        }, token: CustomToken) {
            return `<${tag}>${this.parser.parseInline(token.tokens ?? [])}</${tag}>`;
        }
    };
}

/**
 * ブロック数式tokenをKaTeXで描画するMarked extensionを作る。
 * @param messages - KaTeX描画失敗時の文言を選ぶローカライズ済みメッセージ。
 * @returns block math syntaxを保持し、KaTeX rendererを追加したextension。
 */
function mathBlockExtension(messages: Messages): any {
    return {
        ...mathBlockSyntax(),
        /**
         * ブロック数式をKaTeXで描画し、失敗時はエラー表示を返す。
         * @param token - Markdown変換で走査または更新する要素。
         * @returns KaTeXの数式HTML、または数式エラーを示すHTML。
         */
        renderer(token: CustomToken) {
            const source = token.text;
            return renderKatex(source, true, messages);
        }
    };
}

/**
 * 単一行の$...$数式を認識してKaTeXで描画するMarked inline extensionを作る。
 * @param messages - KaTeX描画失敗時の文言を選ぶローカライズ済みメッセージ。
 * @returns $区切りを検索し、数式tokenを描画するextension。
 */
function mathInlineExtension(messages: Messages): any {
    return {
        name: 'mathInline',
        level: 'inline',
        /**
         * Markdown変換の表示または操作を開始する。
         * @param source - 解析・描画・変換の起点となる本文。
         * @returns Markdown変換のstartが生成する結果。
         */
        start(source: string) {
            const found = source.indexOf('$');
            return found >= 0 ? found : undefined;
        },
        /**
         * $...$形式のインライン数式をtokenizerで認識する。
         * @param source - 解析・描画・変換の起点となる本文。
         * @returns Markdown変換のtokenizerが生成する結果。
         */
        tokenizer(source: string) {
            const match = /^\$(?!\s|\$)([^\n$]*?\S)\$(?!\$)/.exec(source);
            if (!match) return undefined;
            return { type: 'mathInline', raw: match[0], text: match[1] } as CustomToken;
        },
        /**
         * インライン数式をKaTeXで描画する。
         * @param token - Markdown変換で走査または更新する要素。
         * @returns KaTeXのインライン数式HTML。
         */
        renderer(token: CustomToken) {
            return renderKatex(token.text, false, messages);
        }
    };
}

/**
 * 現在のMarkdownから作った目次を描画するMarked extensionを生成する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @param messages Markdown出力で使う翻訳済みメッセージと書式関数。
 * @returns TOC tokenを目次HTMLへ置き換えるextension。
 */
function tocExtension(markdown: string, messages: Messages): any {
    return {
        ...tableOfContentsSyntax(),
        /**
         * Markdown見出しから目次HTMLを生成するrenderer。
         * @returns Markdown見出しから生成した目次HTML。
         */
        renderer() {
            return buildToc(markdown, messages);
        }
    };
}

/**
 * 別処理で抽出した脚注定義を本文中へ重複表示しないためのMarked extensionを作る。
 * @returns 脚注定義tokenの描画結果を空文字にするextension。
 */
function footnoteDefinitionExtension(): any {
    return {
        ...footnoteDefinitionSyntax(),
        /**
         * 脚注定義本文を通常の描画結果へ出さないrenderer。
         * @returns 空文字列。
         */
        renderer() {
            return '';
        }
    };
}

/**
 * 脚注参照を解析し、各脚注の参照IDを生成する拡張機能を作る。
 * @param definitions Markdown本文中の脚注IDと脚注定義を結ぶ対応表。
 * @param counts 脚注IDごとの参照出現回数を保持するMap。
 * @returns Markdown parserへ登録する脚注参照拡張機能。
 */
function footnoteReferenceExtension(
    definitions: Map<string, FootnoteDefinition>,
    counts: Map<string, number>
): any {
    return {
        name: 'footnoteReference',
        level: 'inline',
        /**
         * Markdown変換の表示または操作を開始する。
         * @param source - 解析・描画・変換の起点となる本文。

         */
        start(source: string) {
            const found = source.indexOf('[^');
            return found >= 0 ? found : undefined;
        },
        /**
         * 対応する脚注定義がある[^label]参照をtokenizerで認識する。
         * @param source - 解析・描画・変換の起点となる本文。

         */
        tokenizer(source: string) {
            const match = /^\[\^([^\]]+)]/.exec(source);
            if (!match || !definitions.has(match[1])) return undefined;
            return { type: 'footnoteReference', raw: match[0], text: match[1] } as CustomToken;
        },
        /**
         * 脚注参照tokenを脚注本文へのリンクHTMLへ描画する。
         * @param token - Markdown変換で走査または更新する要素。

         */
        renderer(token: CustomToken) {
            const safeId = slugify(token.text);
            const count = (counts.get(token.text) ?? 0) + 1;
            counts.set(token.text, count);
            return `<sup class="footnote-ref"><a href="#fn-${safeId}" id="fnref-${safeId}-${count}">${escapeHtml(token.text)}</a></sup>`;
        }
    };
}

/**
 * KaTeXで数式をHTMLへ描画し、描画失敗時はエラー要素を返す。
 * @param source - HTMLへ変換するMarkdown本文。
 * @param displayMode - 出力先に応じて適用するMarkdown表示モード。
 * @param messages Markdown出力で使う翻訳済みメッセージと書式関数。

 */
function renderKatex(source: string, displayMode: boolean, messages: Messages): string {
    try {
        const rendered = katex.renderToString(source, { displayMode, throwOnError: true, strict: 'warn' });
        return `<span class="math-node${displayMode ? ' math-block' : ''}" data-math-source="${escapeAttribute(encodeURIComponent(source))}">${rendered}</span>`;
    } catch (error) {
        return `<span class="math-error" data-math-source="${escapeAttribute(encodeURIComponent(source))}" title="${escapeAttribute(messages.renderer.mathError)}: ${escapeAttribute(String(error))}">${escapeHtml(source)}</span>`;
    }
}

/**
 * Markdown見出しを解析して階層付き目次HTMLを生成する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @param messages Markdown出力で使う翻訳済みメッセージと書式関数。

 */
function buildToc(markdown: string, messages: Messages): string {
    const items = getOutline(markdown);
    if (!items.length) return '';
    return `<nav class="table-of-contents" aria-label="${escapeAttribute(messages.renderer.toc)}"><strong>${messages.renderer.toc}</strong><ul>${items
        .map(

            /**
             * 各項目からlevelを取り出して一覧化する。
             * @param item - 項目のlevelを参照する走査対象。
             * @returns levelを取り出した変換結果の一覧。
             */
            (item) =>
                `<li class="toc-level-${item.level}"><a href="#${escapeAttribute(item.id)}">${escapeHtml(item.text)}</a></li>`
        )
        .join('')}</ul></nav>`;
}

/**
 * HTML内のGitHub形式alert blockquoteをalert表示用HTMLへ変換する。
 * @param html - 表示または出力するHTML本文。
 * @param messages Markdown出力で使う翻訳済みメッセージと書式関数。

 */
function renderAlerts(html: string, messages: Messages): string {
    return html.replace(
        /<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*<br>?(?:\n)?([\s\S]*?)<\/p>\s*<\/blockquote>/gi,


        (_match, type: string, content: string) => {
            const label = messages.renderer.alerts[type.toLowerCase() as keyof Messages['renderer']['alerts']] ?? type;
            return `<aside class="markdown-alert alert-${type.toLowerCase()}"><strong>${escapeHtml(label)}</strong><div>${content}</div></aside>`;
        }
    );
}

/**
 * Markdown本文から脚注定義行と元テキスト上の範囲を収集する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * 脚注IDから定義本文と元テキスト範囲を引けるMap。
 */
function collectFootnoteDefinitions(markdown: string): Map<string, FootnoteDefinition> {
    const definitions = new Map<string, FootnoteDefinition>();
    for (const lineMatch of markdown.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
        const rawLine = lineMatch[0];
        if (!rawLine && lineMatch.index === markdown.length) break;
        const line = rawLine.replace(/(?:\r\n|\r|\n)$/, '');
        const match = /^\[\^([^\]]+)]\s*:\s*(.+)$/.exec(line);
        if (!match) continue;
        definitions.set(match[1], {
            id: match[1],
            text: match[2],
            from: lineMatch.index,
            to: lineMatch.index + rawLine.length
        });
    }
    return definitions;
}

/**
 * 脚注定義から脚注セクションと本文への戻りリンクを生成する。
 * @param definitions Markdown本文中の脚注IDと脚注定義を結ぶ対応表。
 * @param messages Markdown出力で使う翻訳済みメッセージと書式関数。

 */
function renderFootnoteSection(definitions: Map<string, FootnoteDefinition>, messages: Messages): string {
    if (!definitions.size) return '';
    const entries = [...definitions.values()];
    const notes = entries.map(
        /**
         * 各設定をslugifyへ渡し、変換結果を一覧化する。

         */
        ({ id, text }) => {
            const safeId = slugify(id);
            return `<li id="fn-${safeId}">${escapeHtml(text)} <a href="#fnref-${safeId}-1" aria-label="${escapeAttribute(messages.renderer.backToText)}">↩</a></li>`;
        }).join('');
    const from = Math.min(...entries.map(
        /**
         * 各エントリからfromを取り出して一覧化する。
         * @param entry - エントリのfromを参照する走査対象。
         * @returns fromを取り出した変換結果の一覧。
         */
        (entry) => entry.from));
    const to = Math.max(...entries.map(
        /**
         * 各エントリからtoを取り出して一覧化する。
         * @param entry - エントリのtoを参照する走査対象。
         * @returns toを取り出した変換結果の一覧。
         */
        (entry) => entry.to));
    return `<section class="footnotes markdown-source-block" data-source-from="${from}" data-source-to="${to}"><hr><ol>${notes}</ol></section>`;
}

/**
 * Markdown本文中で各トークンが占める元ソース範囲を特定する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @param tokens - Markdown変換で走査または更新する要素。
 * @returns トークン順の半開オフセット範囲一覧。位置を対応付けられないトークンは含めない。
 */
function locateTokenRanges(markdown: string, tokens: Token[]): Array<{
    /**
     * トークン範囲の先頭を示すMarkdown本文内UTF-16オフセットです。
     */
    from: number;
    /**
     * トークン範囲の末尾を示すMarkdown本文内UTF-16オフセットです。
     */
    to: number
}> {
    const { normalized, originalOffsets } = normalizeWithOriginalOffsets(markdown);
    let cursor = 0;
    return tokens.map(
        /**
         * 各tokenからrawを取り出して一覧化する。
         * @param token - tokenのrawを参照する走査対象。
         * @returns rawを取り出した変換結果の一覧。
         */
        (token) => {
            const raw = normalizeLineEndings(token.raw ?? '');
            const found = normalized.indexOf(raw, cursor);
            const normalizedFrom = found >= 0 ? found : cursor;
            const normalizedTo = Math.min(normalized.length, normalizedFrom + raw.length);
            cursor = normalizedTo;
            return {
                from: originalOffsets[normalizedFrom] ?? markdown.length,
                to: originalOffsets[normalizedTo] ?? markdown.length
            };
        });
}

/**
 * 改行コードをLFへ統一し、正規化後の各オフセットに対応する元位置を記録する。
 * @param markdown - 解析・編集・変換の対象となるMarkdown本文。
 * @returns LFへ正規化した本文と、各位置に対応する原文オフセット配列。
 */
function normalizeWithOriginalOffsets(markdown: string): {
    /**
     * Markdown変換で扱うnormalizedの文字列。
     */
    normalized: string;
    /**
     * 正規化Markdownの各文字に対応する原文UTF-16オフセット配列。
     */
    originalOffsets: number[]
} {
    let normalized = '';
    const originalOffsets = [0];
    let offset = 0;
    while (offset < markdown.length) {
        if (markdown[offset] === '\r') {
            offset += markdown[offset + 1] === '\n' ? 2 : 1;
            normalized += '\n';
        } else {
            normalized += markdown[offset];
            offset += 1;
        }
        originalOffsets.push(offset);
    }
    return { normalized, originalOffsets };
}

/**
 * CRLFとCRをLFへ変換して改行コードを統一する。
 * @param value - 改行コードをLFへ統一するMarkdown本文。

 */
function normalizeLineEndings(value: string): string {
    return value.replace(/\r\n?|\n/g, '\n');
}

/**
 * HTML本文・属性値の予約文字をHTML文字参照へ置換する。
 * @param value - HTMLテキストとして出力する前の文字列。
 * @returns 予約文字をescapeしたHTML文字列。
 */
export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g,
        /**

         * @param character - Markdown変換へ渡す入力。

         */
        (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/**
 * HTML属性値へ埋め込む文字列の予約文字をエスケープする。
 * @param value - HTML属性値として出力する前の文字列。

 */
function escapeAttribute(value: string): string {
    return escapeHtml(value).replace(/`/g, '&#96;');
}
