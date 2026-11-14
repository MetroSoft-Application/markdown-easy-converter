/**
 * @fileoverview DOCXの中間モデル（model.ts）からWordprocessingML（OOXML）の各パーツを作り、ZIPへまとめる。
 * 実行境界: Node（CLI）。入力はブラウザー内で抽出・サニタイズ済みのデータと、画像のバイト列だけで、ファイルを読まない。
 *
 * 守る不変条件:
 * - 要素の並び順はECMA-376のスキーマ順（pPr・rPr・tcPr・sectPrなど）に合わせる。順序違反はWordで「修復」扱いになる。
 * - 文字列はすべてescapeXmlを通し、XMLとして不正な制御文字を除く。数式（OMML）はmathml.tsが同じ規則で作る。
 * - 用紙サイズ・余白・文字サイズ・行間・見出し色・ヘッダー/フッターはPDFと同じ正規化済み設定から決める。
 * - 出力に日時や乱数を含めず、同じ入力から同じバイト列を作る。
 */
import type { EditorTheme, NormalizedPdfOptions, PdfTextAlign } from '../shared/protocol';
import { LITERAL_BRACE } from '../documentMetadata';
import { PAPER_DIMENSIONS_MM } from '../pdf';
import { escapeXml } from './mathml';
import type {
    DocxBlock, DocxBorder, DocxImage, DocxInline, DocxListFormat, DocxModel, DocxParagraph, DocxRunStyle, DocxTable
} from './model';
import { createZip, type ZipEntry } from './zip';

/** 埋め込む画像の実体。 */
export interface DocxMedia {
    /** 画像のバイト列。 */
    data: Uint8Array;
    /** 拡張子。Content Typesの既定値と対応する。 */
    extension: 'png' | 'jpeg' | 'gif' | 'bmp';
}

/** DOCXパッケージの組み立てに必要な入力。 */
export interface DocxBuildInput {
    /** 抽出済みの本文。 */
    model: DocxModel;
    /** `model.images`と同じ添字の画像。取得できなかった画像はundefinedで、代替テキストを出す。 */
    media: ReadonlyArray<DocxMedia | undefined>;
    /** PDFと共有する正規化済みのページ・文字設定。ヘッダー/フッターは置換・プレースホルダー展開済み。 */
    options: NormalizedPdfOptions;
    /** 見出し色を選ぶテーマ。PDFと同じ色を使う。 */
    theme: EditorTheme;
    /** 文書プロパティのタイトル。 */
    title: string;
    /** `--language`の値。文書の既定言語（w:lang）に使う。 */
    language: string;
}

/** 名前空間宣言。本文・脚注・ヘッダー/フッターで共有する。 */
const NAMESPACES = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    + ' xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'
    + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
    + ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
    + ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
/** XML宣言。 */
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** 関係の種類。 */
const REL = {
    styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
    settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
    numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
    fontTable: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable',
    footnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
    header: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
    footer: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
    image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
    hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink'
} as const;
/** CSSピクセルからEMU（English Metric Unit）への換算。1px = 1/96インチ = 9525EMU。 */
const EMU_PER_PIXEL = 9525;
/** mmからtwipへの換算。 */
const TWIPS_PER_MM = 1440 / 25.4;
/** mmからEMUへの換算。 */
const EMU_PER_MM = 36000;
/** 箇条書きの記号。入れ子の深さごとに循環させる。 */
const BULLETS = ['•', '◦', '▪'];
/** `--language`からWordの言語タグへの対応。 */
const LANGUAGE_TAGS: Record<string, string> = {
    ja: 'ja-JP', en: 'en-US', 'zh-cn': 'zh-CN', ko: 'ko-KR', fr: 'fr-FR', de: 'de-DE', es: 'es-ES'
};
/** 本文フォントを決められないときの代替。 */
const FALLBACK_FONT = 'Calibri';
/** コード用フォントを決められないときの代替。 */
const FALLBACK_CODE_FONT = 'Consolas';

/**
 * 画像の関係先で、拡張子を後から確定させるための仮の値。関係は本文を書きながら登録し、
 * 画像の形式（PNG・JPEGなど）は書き出し時に確定するため、toXmlで置き換える。
 */
const MEDIA_EXTENSION_PLACEHOLDER = '__ext__';

/**
 * 1つのXMLパーツ（本文・脚注・ヘッダー/フッター）が持つ関係（画像・リンク）を管理する。
 */
class PartRelationships {
    /** 関係の一覧。 */
    private readonly entries: Array<{ id: string; type: string; target: string; external: boolean }> = [];
    /** 画像の添字から関係IDへの対応。同じ画像を同じパーツで再利用する。 */
    private readonly images = new Map<number, string>();
    /** 外部リンク先から関係IDへの対応。 */
    private readonly links = new Map<string, string>();

    /**
     * 関係を追加する。
     * @param type - 関係の種類。
     * @param target - 対象（パーツ内の相対パス、または外部URL）。
     * @param external - 外部の対象ならtrue。
     * @returns 関係ID。
     */
    add(type: string, target: string, external = false): string {
        const id = `rId${this.entries.length + 1}`;
        this.entries.push({ id, type, target, external });
        return id;
    }

    /** @param index - 画像の添字。 @returns 画像の関係ID。 */
    image(index: number): string {
        let id = this.images.get(index);
        if (!id) {
            id = this.add(REL.image, `media/image${index + 1}.${MEDIA_EXTENSION_PLACEHOLDER}`);
            this.images.set(index, id);
        }
        return id;
    }

    /** @param href - 外部リンク先。 @returns ハイパーリンクの関係ID。 */
    link(href: string): string {
        let id = this.links.get(href);
        if (!id) {
            id = this.add(REL.hyperlink, href, true);
            this.links.set(href, id);
        }
        return id;
    }

    /**
     * @param extensions - 画像の添字ごとの確定した拡張子。
     * @returns 関係パーツ（.rels）のXML。
     */
    toXml(extensions: ReadonlyArray<string | undefined>): string {
        const items = this.entries.map((entry) => {
            const target = entry.type === REL.image
                ? entry.target.replace(/image(\d+)\.__ext__$/, (_, index: string) => `image${index}.${extensions[Number(index) - 1] ?? 'png'}`)
                : entry.target;
            return `<Relationship Id="${entry.id}" Type="${entry.type}" Target="${escapeXml(target)}"${entry.external ? ' TargetMode="External"' : ''}/>`;
        }).join('');
        return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
    }

    /** @returns 関係が1件もなければtrue。 */
    get empty(): boolean {
        return this.entries.length === 0;
    }
}

/** パッケージ全体で共有する状態。 */
interface BuildState {
    /** 組み立ての入力（本文・画像・設定）。 */
    input: DocxBuildInput;
    /** 図形のid（wp:docPr）の通し番号。パッケージ内で一意にする。 */
    drawingId: number;
    /** ブックマークのid。 */
    bookmarkId: number;
    /** リストの番号から、numbering.xmlのw:numへの対応。 */
    numbers: Map<number, { numId: number; format: DocxListFormat; level: number; start: number }>;
    /** 本文の印刷可能幅（EMU）。画像をこの幅に収める。 */
    contentWidthEmu: number;
    /** 本文の印刷可能幅（twip）。表をこの幅に収める。 */
    contentWidthTwips: number;
    /** 画像を収める本文の高さ（EMU）。Word・Writerは画像をページで分割できず、はみ出た部分は表示されないため。 */
    contentHeightEmu: number;
}

/**
 * 中間モデルからDOCXパッケージを作る。
 * @param input - 本文、画像、設定。
 * @returns DOCXファイルのバイト列。
 */
export function buildDocx(input: DocxBuildInput): Buffer {
    const page = pageGeometry(input.options);
    const state: BuildState = {
        input,
        drawingId: 0,
        bookmarkId: 0,
        numbers: new Map(),
        contentWidthEmu: Math.round(page.contentWidthMm * EMU_PER_MM),
        contentWidthTwips: Math.round(page.contentWidthMm * TWIPS_PER_MM),
        // 画像の段落の行間・段落後の間隔に加え、直前の見出し1つ分（合わせて約30mm）を差し引く。
        // 本文の高さいっぱいの画像は見出しと同じページに収まらず、見出しだけがページ末に残るため。
        // 小さい用紙や大きい余白で縮めすぎないよう、差し引く量は本文の高さの25%までにする。
        contentHeightEmu: Math.round(Math.max(10, page.contentHeightMm - Math.min(30, page.contentHeightMm * 0.25)) * EMU_PER_MM)
    };
    const documentRels = new PartRelationships();
    documentRels.add(REL.styles, 'styles.xml');
    documentRels.add(REL.settings, 'settings.xml');
    documentRels.add(REL.numbering, 'numbering.xml');
    documentRels.add(REL.fontTable, 'fontTable.xml');
    documentRels.add(REL.footnotes, 'footnotes.xml');
    const headerXml = headerFooterXml('hdr', input.options.header, input.options.headerAlign, input.options);
    const footerXml = headerFooterXml('ftr', input.options.footer, input.options.footerAlign, input.options);
    const headerId = headerXml ? documentRels.add(REL.header, 'header1.xml') : undefined;
    const footerId = footerXml ? documentRels.add(REL.footer, 'footer1.xml') : undefined;

    let body = blocksXml(input.model.body, state, documentRels);
    // Wordは本文の最後が表だと段落を補って「修復」するため、空の段落で終える。
    if (!input.model.body.length || input.model.body[input.model.body.length - 1].type === 'table') body += '<w:p/>';
    const footnoteRels = new PartRelationships();
    const footnotes = input.model.footnotes.map((blocks, index) => footnoteXml(blocks, index + 1, state, footnoteRels)).join('');

    const extensions = input.media.map((media) => media?.extension);
    const entries: ZipEntry[] = [
        { name: '[Content_Types].xml', data: contentTypesXml(Boolean(headerXml), Boolean(footerXml)) },
        { name: '_rels/.rels', data: packageRelsXml() },
        { name: 'docProps/core.xml', data: corePropertiesXml(input.title, input.language) },
        { name: 'docProps/app.xml', data: appPropertiesXml() },
        { name: 'word/document.xml', data: `${XML_HEADER}<w:document ${NAMESPACES}><w:body>${body}${sectionXml(input.options, headerId, footerId)}</w:body></w:document>` },
        { name: 'word/_rels/document.xml.rels', data: documentRels.toXml(extensions) },
        { name: 'word/styles.xml', data: stylesXml(input) },
        { name: 'word/settings.xml', data: settingsXml() },
        { name: 'word/numbering.xml', data: numberingXml(state) },
        { name: 'word/fontTable.xml', data: fontTableXml(input.model) },
        { name: 'word/footnotes.xml', data: footnotesXml(footnotes) }
    ];
    if (!footnoteRels.empty) entries.push({ name: 'word/_rels/footnotes.xml.rels', data: footnoteRels.toXml(extensions) });
    if (headerXml) entries.push({ name: 'word/header1.xml', data: headerXml });
    if (footerXml) entries.push({ name: 'word/footer1.xml', data: footerXml });
    input.media.forEach((media, index) => {
        if (media) entries.push({ name: `word/media/image${index + 1}.${media.extension}`, data: media.data });
    });
    return createZip(entries);
}

/**
 * 用紙の寸法と本文の幅・高さを求める。
 * @param options - 正規化済みの設定。
 * @returns 向きを反映した用紙の幅・高さと、余白を除いた本文の幅・高さ（mm）。
 */
function pageGeometry(options: NormalizedPdfOptions): { widthMm: number; heightMm: number; contentWidthMm: number; contentHeightMm: number } {
    const portrait = PAPER_DIMENSIONS_MM[options.format];
    const landscape = options.orientation === 'landscape';
    const widthMm = landscape ? portrait.height : portrait.width;
    const heightMm = landscape ? portrait.width : portrait.height;
    return {
        widthMm, heightMm,
        contentWidthMm: Math.max(10, widthMm - options.margins.left - options.margins.right),
        contentHeightMm: Math.max(10, heightMm - options.margins.top - options.margins.bottom)
    };
}

/**
 * ブロックの並びをXMLにする。
 * @param blocks - ブロック。
 * @param state - パッケージの状態。
 * @param rels - 出力先パーツの関係。
 * @returns XML。
 */
function blocksXml(blocks: readonly DocxBlock[], state: BuildState, rels: PartRelationships): string {
    let previous: BlockFormat | undefined;
    return blocks.map((block) => {
        const current = blockFormat(block);
        const separator = separatorBetween(previous, current);
        previous = current;
        switch (block.type) {
            case 'paragraph': return separator + paragraphXml(block, state, rels);
            case 'math': return `${separator}<w:p>${paragraphPropertiesXml({ type: 'paragraph', inlines: [], ...block.paragraph }, state)}${block.omml}</w:p>`;
            case 'table': return tableXml(block, state, rels);
            case 'toc': return tocXml(block, state, rels);
        }
    }).join('');
}

/** 区切りの判定に使う、ブロックの段落書式。表と目次は書式を持たない（区切りの判定をそこで止める）。 */
type BlockFormat = Omit<DocxParagraph, 'type' | 'inlines'>;

/**
 * ブロックの段落書式を取り出す。
 * @param block - ブロック。
 * @returns 段落・数式の書式。表と目次はundefined。
 */
function blockFormat(block: DocxBlock): BlockFormat | undefined {
    return block.type === 'paragraph' ? block : block.type === 'math' ? block.paragraph : undefined;
}

/**
 * 隣り合う2つのブロックの間に置く区切りの段落を作る。
 * Wordは罫線・背景・字下げが同じ段落を1つの枠にまとめるため、同じ深さの別々の引用（連続するAlertsなど）や、
 * 続けて置かれたコードブロック（1つが1段落）の間には小さな空の段落を挟んで枠を分ける（PDFでは別々の枠になる）。
 * 区切りの段落は前後と同じ字下げにし、引用の中のコードの間では引用の縦線を保つ（コードの段落は引用ではなくコードの背景を持つため、区切りに背景は付けない）。
 * @param previous - 前のブロックの書式。
 * @param current - 後のブロックの書式。
 * @returns 区切りの段落。不要なら空文字列。
 */
function separatorBetween(previous: BlockFormat | undefined, current: BlockFormat | undefined): string {
    if (!previous || !current) return '';
    const separateQuotes = previous.quoteGroup !== undefined && current.quoteGroup !== undefined
        && previous.quoteGroup !== current.quoteGroup && previous.quote === current.quote;
    const separateCode = previous.style === 'code' && current.style === 'code';
    if (!separateQuotes && !separateCode) return '';
    const keepQuote = separateCode && !separateQuotes && current.quoteGroup !== undefined;
    let properties = keepQuote && current.leftBorder ? `<w:pBdr>${borderXml('left', current.leftBorder, 8)}</w:pBdr>` : '';
    properties +='<w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="exact"/>';
    if (current.indent) properties += `<w:ind w:left="${Math.round(current.indent)}"/>`;
    return `<w:p><w:pPr>${properties}</w:pPr></w:p>`;
}

/**
 * 段落をXMLにする。見出しのブックマークは段落全体を囲む。
 * @param paragraph - 段落。
 * @param state - パッケージの状態。
 * @param rels - 出力先パーツの関係。
 * @param prefix - 段落の先頭に置く追加の要素（脚注記号、フィールド開始）。
 * @param suffix - 段落の末尾に置く追加の要素（フィールド終了）。
 * @param defaultStyle - 段落に固有のスタイルがないときに使うスタイル（脚注本文のFootnoteText）。
 * @returns w:p要素。
 */
function paragraphXml(
    paragraph: DocxParagraph, state: BuildState, rels: PartRelationships, prefix = '', suffix = '', defaultStyle?: string
): string {
    let content = prefix + inlinesXml(paragraph.inlines, state, rels) + suffix;
    if (paragraph.bookmark) {
        state.bookmarkId += 1;
        content = `<w:bookmarkStart w:id="${state.bookmarkId}" w:name="${escapeXml(paragraph.bookmark)}"/>${content}<w:bookmarkEnd w:id="${state.bookmarkId}"/>`;
    }
    return `<w:p>${paragraphPropertiesXml(paragraph, state, defaultStyle)}${content}</w:p>`;
}

/**
 * 段落の書式（w:pPr）を作る。要素はスキーマ順（pStyle, pageBreakBefore, widowControl, numPr, pBdr, shd, ind, jc）に並べる。
 * @param paragraph - 段落。
 * @param state - パッケージの状態。番号の定義を登録する。
 * @param defaultStyle - 段落に固有のスタイルがないときに使うスタイル。
 * @returns w:pPr要素。書式がなければ空文字列。
 */
function paragraphPropertiesXml(paragraph: DocxParagraph, state: BuildState, defaultStyle?: string): string {
    const style = paragraph.heading ? `Heading${paragraph.heading}`
        : paragraph.tocLevel ? `TOC${paragraph.tocLevel}`
            : paragraph.style === 'code' ? 'Code'
                : paragraph.style === 'caption' ? 'CodeCaption'
                    : paragraph.style === 'tocTitle' ? 'TOCHeading'
                        : paragraph.list ? 'ListParagraph'
                            : paragraph.quote ? 'Quote' : defaultStyle;
    let xml = style ? `<w:pStyle w:val="${style}"/>` : '';
    if (paragraph.pageBreakBefore) xml += '<w:pageBreakBefore/>';
    // 画像を含む段落では、画像1枚が1行になる。孤立行の制御（ページ末・先頭に1行だけ残さない）が働くと、
    // 連続した画像がページに収まるのに次のページへ送られ、1ページに画像1枚だけが並ぶため外す。pPrの順序上、pageBreakBeforeの後。
    if (paragraph.inlines.some((inline) => inline.type === 'image')) xml += '<w:widowControl w:val="0"/>';
    if (paragraph.numbering) {
        const numId = registerNumbering(paragraph.numbering, state);
        xml += `<w:numPr><w:ilvl w:val="${paragraph.numbering.level}"/><w:numId w:val="${numId}"/></w:numPr>`;
    }
    // pBdrの子はtop・left・bottom・rightの順。左罫線は本文から8pt離し、下罫線は文字のすぐ下に引く。
    const borders = (paragraph.leftBorder ? borderXml('left', paragraph.leftBorder, 8) : '')
        + (paragraph.bottomBorder ? borderXml('bottom', paragraph.bottomBorder, 4) : '');
    if (borders) xml += `<w:pBdr>${borders}</w:pBdr>`;
    if (paragraph.shading) xml += `<w:shd w:val="clear" w:color="auto" w:fill="${paragraph.shading}"/>`;
    if (paragraph.indent || paragraph.hanging) {
        xml += `<w:ind w:left="${Math.round(paragraph.indent ?? 0)}"${paragraph.hanging ? ` w:hanging="${Math.round(paragraph.hanging)}"` : ''}/>`;
    }
    if (paragraph.align) xml += `<w:jc w:val="${paragraph.align}"/>`;
    return xml ? `<w:pPr>${xml}</w:pPr>` : '';
}

/**
 * 段落の罫線を1辺作る。太さはCSSピクセルを1/8ポイント単位へ換算し、Wordの範囲（2–96）に収める。
 * @param side - 辺。
 * @param border - 色と太さ。
 * @param space - 本文との間隔（ポイント）。
 * @returns 罫線の要素。
 */
function borderXml(side: 'left' | 'bottom', border: DocxBorder, space: number): string {
    const eighths = Math.max(2, Math.min(96, Math.round(border.width * 0.75 * 8)));
    return `<w:${side} w:val="single" w:sz="${eighths}" w:space="${space}" w:color="${border.color}"/>`;
}

/**
 * リスト番号をnumbering.xmlの定義へ登録する。リストごとに別のw:numを作り、番号付きリストの開始番号を独立させる。
 * @param numbering - 段落のリスト番号。
 * @param state - パッケージの状態。
 * @returns w:numId。
 */
function registerNumbering(numbering: NonNullable<DocxParagraph['numbering']>, state: BuildState): number {
    const existing = state.numbers.get(numbering.list);
    if (existing) return existing.numId;
    const numId = state.numbers.size + 1;
    state.numbers.set(numbering.list, { numId, format: numbering.format, level: numbering.level, start: numbering.start });
    return numId;
}

/**
 * 段落内の要素をXMLにする。同じリンク先の連続した文字列は1つのw:hyperlinkにまとめる。
 * @param inlines - 段落内の要素。
 * @param state - パッケージの状態。
 * @param rels - 出力先パーツの関係。
 * @returns XML。
 */
function inlinesXml(inlines: readonly DocxInline[], state: BuildState, rels: PartRelationships): string {
    let xml = '';
    let index = 0;
    while (index < inlines.length) {
        const inline = inlines[index];
        if (inline.type !== 'text' || !inline.link) {
            xml += inlineXml(inline, state, rels);
            index += 1;
            continue;
        }
        const link = inline.link;
        const key = JSON.stringify(link);
        let runs = '';
        while (index < inlines.length) {
            const current = inlines[index];
            if (current.type !== 'text' || JSON.stringify(current.link) !== key) break;
            runs += textRunXml(current.text, current.style);
            index += 1;
        }
        xml += 'href' in link
            ? `<w:hyperlink r:id="${rels.link(link.href)}" w:history="1">${runs}</w:hyperlink>`
            : `<w:hyperlink w:anchor="${escapeXml(link.anchor)}" w:history="1">${runs}</w:hyperlink>`;
    }
    return xml;
}

/**
 * リンク以外の段落内要素を1つXMLにする。
 * @param inline - 段落内の要素。
 * @param state - パッケージの状態。
 * @param rels - 出力先パーツの関係。
 * @returns XML。
 */
function inlineXml(inline: DocxInline, state: BuildState, rels: PartRelationships): string {
    switch (inline.type) {
        case 'text': return textRunXml(inline.text, inline.style);
        case 'break': return '<w:r><w:br/></w:r>';
        case 'math': return inline.omml;
        case 'footnote': {
            // 脚注番号は参照の順に1から振られ、脚注のidの順と一致する（最初の参照の順に脚注を作るため）。
            const number = inline.id + 1;
            const name = `_mveFn${number}`;
            if (inline.repeat) {
                // フィールドスイッチ \f（脚注の書式）と \h（ハイパーリンク）は文字のバックスラッシュで書く。
                return `<w:fldSimple w:instr=" NOTEREF ${name} \\f \\h "><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:t>${number}</w:t></w:r></w:fldSimple>`;
            }
            // 2回目以降の参照（NOTEREF）の飛び先として、最初の参照をブックマークで囲む。
            state.bookmarkId += 1;
            return `<w:bookmarkStart w:id="${state.bookmarkId}" w:name="${name}"/>`
                + `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${number}"/></w:r>`
                + `<w:bookmarkEnd w:id="${state.bookmarkId}"/>`;
        }
        case 'image': return imageXml(inline.id, state, rels);
    }
}

/**
 * 書式付きの文字列をw:rにする。タブはw:tabへ置き換える。
 * @param text - 文字列。
 * @param style - 書式。
 * @returns w:r要素。
 */
function textRunXml(text: string, style: DocxRunStyle): string {
    const content = text.split('\t').map((part) => part ? `<w:t xml:space="preserve">${escapeXml(part)}</w:t>` : '').join('<w:tab/>');
    return `<w:r>${runPropertiesXml(style)}${content}</w:r>`;
}

/**
 * 文字の書式（w:rPr）を作る。要素はスキーマ順（rFonts, b, i, strike, color, u, shd, vertAlign）に並べる。
 * @param style - 書式。
 * @returns w:rPr要素。書式がなければ空文字列。
 */
function runPropertiesXml(style: DocxRunStyle): string {
    let xml = '';
    if (style.fonts?.length) xml += fontsXml(style.fonts[0]);
    if (style.bold) xml += '<w:b/><w:bCs/>';
    if (style.italic) xml += '<w:i/><w:iCs/>';
    if (style.strike) xml += '<w:strike/>';
    if (style.color) xml += `<w:color w:val="${style.color}"/>`;
    if (style.size) xml += `<w:sz w:val="${style.size}"/><w:szCs w:val="${style.size}"/>`;
    if (style.underline) xml += '<w:u w:val="single"/>';
    if (style.shading && style.shading !== 'FFFFFF') xml += `<w:shd w:val="clear" w:color="auto" w:fill="${style.shading}"/>`;
    if (style.vertAlign) xml += `<w:vertAlign w:val="${style.vertAlign}"/>`;
    return xml ? `<w:rPr>${xml}</w:rPr>` : '';
}

/**
 * 全文字種へ同じフォントを指定するw:rFontsを作る。
 * @param font - フォント名。
 * @returns w:rFonts要素。
 */
function fontsXml(font: string): string {
    const name = escapeXml(font);
    return `<w:rFonts w:ascii="${name}" w:hAnsi="${name}" w:eastAsia="${name}" w:cs="${name}"/>`;
}

/**
 * 画像を行内の図（wp:inline）にする。本文の幅・高さを超える画像は縦横比を保って縮める。
 * 画像の実体がない場合（取得失敗）は代替テキストを出す。
 * @param index - 画像の添字。
 * @param state - パッケージの状態。
 * @param rels - 出力先パーツの関係。
 * @returns w:r要素。
 */
function imageXml(index: number, state: BuildState, rels: PartRelationships): string {
    const image: DocxImage | undefined = state.input.model.images[index];
    const media = state.input.media[index];
    if (!image || !media) return textRunXml(image?.alt ? `[${image.alt}]` : '[image]', {});
    let width = Math.max(1, Math.round(image.width * EMU_PER_PIXEL));
    let height = Math.max(1, Math.round(image.height * EMU_PER_PIXEL));
    if (width > state.contentWidthEmu) {
        height = Math.max(1, Math.round(height * state.contentWidthEmu / width));
        width = state.contentWidthEmu;
    }
    // 本文の高さを超える画像は、縦横比を保って1ページに収める（PDFは次のページへ続けて描くが、Wordは切り捨てる）。
    if (height > state.contentHeightEmu) {
        width = Math.max(1, Math.round(width * state.contentHeightEmu / height));
        height = state.contentHeightEmu;
    }
    state.drawingId += 1;
    const id = state.drawingId;
    const alt = escapeXml(image.alt);
    const relationship = rels.image(index);
    return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
        + `<wp:extent cx="${width}" cy="${height}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
        + `<wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/>`
        + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
        + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
        + `<pic:nvPicPr><pic:cNvPr id="${id}" name="image${index + 1}.${media.extension}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>`
        + `<pic:blipFill><a:blip r:embed="${relationship}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
        + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
        + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
}

/**
 * 表をXMLにする。列幅は描画上の幅を推奨値として使い、本文幅を超える場合は比率を保って縮める。
 * 描画上の幅は内容に合わせた最小の幅（max-content）のため、固定幅にするとフォントの違いだけで語が折り返す。
 * そのため自動調整（autofit）にして、Wordが内容に合わせて本文幅まで広げられるようにする。
 * セルの最後は段落でなければならないため、表で終わるセルには空の段落を補う。
 * @param table - 表。
 * @param state - パッケージの状態。
 * @param rels - 出力先パーツの関係。
 * @returns w:tbl要素。
 */
function tableXml(table: DocxTable, state: BuildState, rels: PartRelationships): string {
    const available = Math.max(720, state.contentWidthTwips - (table.indent ?? 0));
    // 計測幅は内容ぴったりのため、Word以外（推奨幅をそのまま使うLibreOfficeなど）でも語が折り返さないよう、
    // 字形の差を吸収する余裕（10%、最小150twip）を足す。本文幅を超える場合は比率を保って縮める。
    const padded = table.columns.map((width) => width + Math.max(150, width * 0.1));
    const total = padded.reduce((sum, width) => sum + width, 0);
    const scale = total > available ? available / total : 1;
    const columns = padded.map((width) => Math.max(1, Math.round(width * scale)));
    const grid = columns.map((width) => `<w:gridCol w:w="${width}"/>`).join('');
    const rows = table.rows.map((row) => {
        let column = 0;
        const cells = row.cells.map((cell) => {
            const width = columns.slice(column, column + cell.colSpan).reduce((sum, value) => sum + value, 0);
            column += cell.colSpan;
            let properties = `<w:tcW w:w="${width}" w:type="dxa"/>`;
            if (cell.colSpan > 1) properties += `<w:gridSpan w:val="${cell.colSpan}"/>`;
            if (cell.vMerge) properties += cell.vMerge === 'restart' ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>';
            if (cell.shading && cell.shading !== 'FFFFFF') properties += `<w:shd w:val="clear" w:color="auto" w:fill="${cell.shading}"/>`;
            if (cell.vAlign) properties += `<w:vAlign w:val="${cell.vAlign}"/>`;
            let content = blocksXml(cell.blocks, state, rels);
            if (!cell.blocks.length || cell.blocks[cell.blocks.length - 1].type === 'table') content += '<w:p/>';
            return `<w:tc><w:tcPr>${properties}</w:tcPr>${content}</w:tc>`;
        }).join('');
        // 印刷CSSと同じく行の途中では改ページしない（tr { break-inside: avoid }）。見出し行はページごとに繰り返す。
        return `<w:tr><w:trPr><w:cantSplit/>${row.header ? '<w:tblHeader/>' : ''}</w:trPr>${cells}</w:tr>`;
    }).join('');
    const indent = table.indent ? `<w:tblInd w:w="${Math.round(table.indent)}" w:type="dxa"/>` : '';
    // 表全体の幅は自動（w:w=0, auto）にし、列の推奨幅の合計で表が狭く固定されないようにする。
    return `<w:tbl><w:tblPr><w:tblStyle w:val="MveTable"/><w:tblW w:w="0" w:type="auto"/>${indent}`
        + '<w:tblLayout w:type="autofit"/><w:tblLook w:val="0420" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>'
        + `</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
}

/**
 * 目次をWordのTOCフィールドにする。描画済みの項目をフィールドの結果として入れ、Wordで更新するとページ番号付きになる。
 * @param toc - 目次。
 * @param state - パッケージの状態。
 * @param rels - 出力先パーツの関係。
 * @returns XML。
 */
function tocXml(toc: Extract<DocxBlock, { type: 'toc' }>, state: BuildState, rels: PartRelationships): string {
    const begin = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        + '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-6" \\h \\z \\u </w:instrText></w:r>'
        + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
    const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
    const title = toc.title ? paragraphXml(toc.title, state, rels) : '';
    if (!toc.entries.length) return `${title}<w:p>${begin}${end}</w:p>`;
    return title + toc.entries.map((entry, index) => paragraphXml(entry, state, rels,
        index === 0 ? begin : '', index === toc.entries.length - 1 ? end : '')).join('');
}

/**
 * 脚注を1つXMLにする。最初の段落の先頭に脚注番号を置く。
 * @param blocks - 脚注本文。
 * @param id - 脚注のid（1始まり）。
 * @param state - パッケージの状態。
 * @param rels - 脚注パーツの関係。
 * @returns w:footnote要素。
 */
function footnoteXml(blocks: readonly DocxBlock[], id: number, state: BuildState, rels: PartRelationships): string {
    const mark = '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>';
    const paragraphs = blocks.length ? blocks : [{ type: 'paragraph', inlines: [] } as DocxParagraph];
    // 脚注番号は最初の段落の先頭に置く。最初のブロックが表などの場合は、番号だけの段落を先に置く。
    const content = (paragraphs[0].type === 'paragraph' ? '' : `<w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>${mark}</w:p>`)
        + paragraphs.map((block, index) => separatorBetween(index > 0 ? blockFormat(paragraphs[index - 1]) : undefined, blockFormat(block))
            + (block.type === 'paragraph'
                ? paragraphXml(block, state, rels, index === 0 ? mark : '', '', 'FootnoteText')
                : blocksXml([block], state, rels))).join('');
    return `<w:footnote w:id="${id}">${content}</w:footnote>`;
}

/**
 * 脚注パーツを作る。区切り線（id -1, 0）はWordが脚注の表示に必須とする。
 * @param footnotes - 本文の脚注要素。
 * @returns footnotes.xml。
 */
function footnotesXml(footnotes: string): string {
    return `${XML_HEADER}<w:footnotes ${NAMESPACES}>`
        + '<w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote>'
        + '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
        + `${footnotes}</w:footnotes>`;
}

/**
 * ヘッダー・フッターのパーツを作る。`{page}`・`{pages}`はWordのPAGE・NUMPAGESフィールドにする。
 * PDFと同じく、エスケープされた波括弧（LITERAL_BRACE）は文字の`{`へ戻す。
 * @param kind - `hdr`（ヘッダー）または`ftr`（フッター）。
 * @param value - プレースホルダー展開・置換済みの文字列。
 * @param align - 文字揃え。
 * @param options - 文字サイズと左右の余白。
 * @returns パーツのXML。文字列が空ならundefined。
 */
function headerFooterXml(
    kind: 'hdr' | 'ftr', value: string, align: PdfTextAlign,
    options: Pick<NormalizedPdfOptions, 'headerFooterFontSize' | 'headerFooterPadding'>
): string | undefined {
    if (!value) return undefined;
    const runProperties = `<w:rPr><w:color w:val="666666"/><w:sz w:val="${Math.round(options.headerFooterFontSize * 2)}"/></w:rPr>`;
    const runs = value.split(/(\{pages?\})/).map((part) => {
        if (part === '{page}' || part === '{pages}') {
            return `<w:fldSimple w:instr=" ${part === '{page}' ? 'PAGE' : 'NUMPAGES'} "><w:r>${runProperties}<w:t>1</w:t></w:r></w:fldSimple>`;
        }
        const text = part.replaceAll(LITERAL_BRACE, '{');
        return text ? `<w:r>${runProperties}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>` : '';
    }).join('');
    const padding = Math.round(options.headerFooterPadding * TWIPS_PER_MM);
    const jc = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
    return `${XML_HEADER}<w:${kind} ${NAMESPACES}><w:p><w:pPr><w:spacing w:after="0"/><w:ind w:left="${padding}" w:right="${padding}"/><w:jc w:val="${jc}"/></w:pPr>${runs}</w:p></w:${kind}>`;
}

/**
 * セクションの設定（用紙・余白・ヘッダー/フッター）を作る。ヘッダー/フッターの位置は、PDFと同じく余白の中に置く。
 * @param options - 正規化済みの設定。
 * @param headerId - ヘッダーの関係ID。
 * @param footerId - フッターの関係ID。
 * @returns w:sectPr要素。
 */
function sectionXml(options: NormalizedPdfOptions, headerId: string | undefined, footerId: string | undefined): string {
    const page = pageGeometry(options);
    /** mmを整数のtwipへ丸める。Wordのページ設定は整数のtwipだけを受け付ける。 */
    const twips = (mm: number): number => Math.round(mm * TWIPS_PER_MM);
    const references = (headerId ? `<w:headerReference w:type="default" r:id="${headerId}"/>` : '')
        + (footerId ? `<w:footerReference w:type="default" r:id="${footerId}"/>` : '');
    const orientation = options.orientation === 'landscape' ? ' w:orient="landscape"' : '';
    const margins = options.margins;
    return `<w:sectPr>${references}<w:footnotePr><w:numFmt w:val="decimal"/></w:footnotePr>`
        + `<w:pgSz w:w="${twips(page.widthMm)}" w:h="${twips(page.heightMm)}"${orientation}/>`
        + `<w:pgMar w:top="${twips(margins.top)}" w:right="${twips(margins.right)}" w:bottom="${twips(margins.bottom)}" w:left="${twips(margins.left)}"`
        + ` w:header="${twips(margins.top / 3)}" w:footer="${twips(margins.bottom / 3)}" w:gutter="0"/>`
        + '<w:cols w:space="720"/></w:sectPr>';
}

/**
 * スタイル定義を作る。文字サイズ・行間・段落間隔・見出し色はPDFの印刷CSSと同じ設定値から決める。
 * @param input - 本文の基準書式と設定。
 * @returns styles.xml。
 */
function stylesXml(input: DocxBuildInput): string {
    const options = input.options;
    const bodyFont = input.model.base.fonts[0] ?? FALLBACK_FONT;
    const codeFont = input.model.base.codeFonts[0] ?? FALLBACK_CODE_FONT;
    /** ポイントをWordの文字サイズ単位（半ポイント、整数、最小1pt）へ換算する。 */
    const halfPoints = (points: number): number => Math.max(2, Math.round(points * 2));
    // 見出しの色は印刷CSS（`--css`を含む）の計算済みの色を使う。文書にない段階はPDFと同じテーマ色にする。
    const themeHeadingColor = input.theme === 'light' ? '0969DA' : '0550AE';
    const language = LANGUAGE_TAGS[input.language] ?? 'en-US';
    // 行の高さは印刷CSSの計算済みの値（pt）を「最小値（atLeast）」で指定する。
    // Wordの倍数指定（auto）はフォント固有の行の高さ（Noto Sans JPでは文字サイズの約1.45倍）に掛けるため、
    // CSSのline-height（文字サイズの倍数）より行間が広がり、ページ数が増える。最小値にするのは、行内の数式・画像を切らないため。
    // 段落・見出しの前後の間隔も、印刷CSSの余白から換算した値を使う（extract.tsのblockSpacing）。
    const spacing = input.model.base.spacing;
    const codeLine = Math.round(input.model.base.codeLineHeight * 20);
    const lineSpacing = `<w:spacing w:after="${Math.round(input.model.base.spacing.paragraph * 20)}" w:line="${Math.round(input.model.base.lineHeight * 20)}" w:lineRule="atLeast"/>`;
    const headings = ([1, 2, 3, 4, 5, 6] as const).map((level) => {
        // 文字サイズは印刷CSS（`--css`を含む）の計算済みの値を優先し、文書にない段階は設定値にする。
        const size = input.model.base.headingSizes[`h${level}`] ?? halfPoints(options.headingFontSizes[`h${level}`]);
        return `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>`
            + `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${Math.round((spacing.headings[`h${level}`]?.before ?? 12) * 20)}" w:after="${Math.round((spacing.headings[`h${level}`]?.after ?? 6) * 20)}"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>`
            + `<w:rPr><w:b/><w:bCs/><w:color w:val="${input.model.base.headingColors[`h${level}`] ?? themeHeadingColor}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
    }).join('');
    const tocLevels = [1, 2, 3, 4, 5, 6].map((level) =>
        `<w:style w:type="paragraph" w:styleId="TOC${level}"><w:name w:val="toc ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/>`
        // 印刷の目次は項目の間に段落間隔がないため、段落後の間隔をなくす。
        + `<w:pPr><w:spacing w:after="0"/><w:ind w:left="${(level - 1) * 240}"/></w:pPr></w:style>`).join('');
    return `${XML_HEADER}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
        + `<w:docDefaults><w:rPrDefault><w:rPr>${fontsXml(bodyFont)}<w:color w:val="${input.model.base.color}"/>`
        + `<w:sz w:val="${input.model.base.bodySize}"/><w:szCs w:val="${input.model.base.bodySize}"/><w:lang w:val="${language}"/></w:rPr></w:rPrDefault>`
        + `<w:pPrDefault><w:pPr>${lineSpacing}</w:pPr></w:pPrDefault></w:docDefaults>`
        + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
        + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>'
        + headings
        + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/></w:style>'
        // リスト内の段落どうしは間隔を詰め、リストの最後の段落だけが通常の段落間隔を持つ（印刷CSSのリストと同じ詰め方）。
        + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/>'
        + '<w:pPr><w:contextualSpacing/></w:pPr></w:style>'
        + `<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/>`
        + '<w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="DDDDDD"/><w:left w:val="single" w:sz="4" w:space="4" w:color="DDDDDD"/>'
        + '<w:bottom w:val="single" w:sz="4" w:space="4" w:color="DDDDDD"/><w:right w:val="single" w:sz="4" w:space="4" w:color="DDDDDD"/></w:pBdr>'
        + `<w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/><w:spacing w:before="0" w:after="160" w:line="${codeLine}" w:lineRule="atLeast"/><w:ind w:left="85" w:right="85"/></w:pPr>`
        + `<w:rPr>${fontsXml(codeFont)}<w:noProof/><w:sz w:val="${input.model.base.codeSize}"/><w:szCs w:val="${input.model.base.codeSize}"/></w:rPr></w:style>`
        + `<w:style w:type="paragraph" w:styleId="CodeCaption"><w:name w:val="Code Caption"/><w:basedOn w:val="Normal"/><w:next w:val="Code"/>`
        // 表の直後でも本文と離れるよう、前に間隔を取る（Wordの表は後ろの間隔を持てない）。
        + `<w:pPr><w:keepNext/><w:spacing w:before="160" w:after="40"/></w:pPr><w:rPr><w:color w:val="57606A"/><w:sz w:val="${input.model.base.codeSize}"/></w:rPr></w:style>`
        + `<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/>`
        + '<w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:bCs/></w:rPr></w:style>'
        + tocLevels
        + `<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/>`
        // 脚注も本文と同じく行の高さを最小値で指定する（倍数指定はフォント固有の行の高さに掛かり、行間が広がるため）。
        + `<w:pPr><w:spacing w:after="0" w:line="${Math.round(input.model.base.lineHeight * 20 * Math.max(12, input.model.base.bodySize - 4) / input.model.base.bodySize)}" w:lineRule="atLeast"/></w:pPr><w:rPr><w:sz w:val="${Math.max(12, input.model.base.bodySize - 4)}"/></w:rPr></w:style>`
        + '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:uiPriority w:val="99"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
        + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/>'
        + '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
        + '<w:style w:type="table" w:styleId="MveTable"><w:name w:val="Markdown Table"/><w:basedOn w:val="TableNormal"/>'
        // セル内の段落は段落後の間隔だけをなくし、行の高さは本文と同じにする（印刷CSSのセルは本文の行の高さを継承する）。
        + '<w:pPr><w:spacing w:after="0"/></w:pPr>'
        + '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="888888"/><w:left w:val="single" w:sz="4" w:space="0" w:color="888888"/>'
        + '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="888888"/><w:right w:val="single" w:sz="4" w:space="0" w:color="888888"/>'
        + '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="888888"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="888888"/></w:tblBorders>'
        + '<w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
        + '</w:styles>';
}

/**
 * 番号付けの定義を作る。形式ごとに抽象定義を1つ作り、リストごとのw:numが開始番号を上書きする。
 * 字下げは段落側で指定するため、ここでは既定の位置だけを持つ。
 * @param state - 登録済みのリスト番号。
 * @returns numbering.xml。
 */
function numberingXml(state: BuildState): string {
    const formats: DocxListFormat[] = ['bullet', 'decimal', 'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman'];
    const abstracts = formats.map((format, abstractId) => {
        const levels = Array.from({ length: 9 }, (_, level) => {
            const text = format === 'bullet' ? BULLETS[level % BULLETS.length] : `%${level + 1}.`;
            return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>`
                + `<w:pPr><w:ind w:left="${(level + 1) * 420}" w:hanging="420"/></w:pPr></w:lvl>`;
        }).join('');
        return `<w:abstractNum w:abstractNumId="${abstractId}"><w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`;
    }).join('');
    const nums = [...state.numbers.values()].map((entry) => {
        const abstractId = Math.max(0, formats.indexOf(entry.format));
        const override = entry.format === 'bullet' ? ''
            : `<w:lvlOverride w:ilvl="${entry.level}"><w:startOverride w:val="${Math.max(0, Math.trunc(entry.start))}"/></w:lvlOverride>`;
        return `<w:num w:numId="${entry.numId}"><w:abstractNumId w:val="${abstractId}"/>${override}</w:num>`;
    }).join('');
    return `${XML_HEADER}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${abstracts}${nums}</w:numbering>`;
}

/**
 * 文書の設定を作る。互換モード15（Word 2013以降）を指定し、古い互換モードの表示を避ける。
 * 開いたときのフィールド更新（updateFields）は確認ダイアログを出すため指定しない。
 * @returns settings.xml。
 */
function settingsXml(): string {
    return `${XML_HEADER}<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
        + '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>'
        + '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>'
        + '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>'
        + '</w:settings>';
}

/**
 * フォント表を作る。CSSのフォント候補の2番目を代替名（w:altName）にし、未導入の環境での置き換え先の手がかりにする。
 * @param model - 本文とコードのフォント候補、文字列ごとのフォント指定。
 * @returns fontTable.xml。
 */
function fontTableXml(model: DocxModel): string {
    const stacks: Array<readonly string[]> = [model.base.fonts, model.base.codeFonts];
    /** 表のセル・目次・脚注の中まで辿り、文字列ごとのフォント候補を集める。 */
    const collect = (blocks: readonly DocxBlock[]): void => {
        for (const block of blocks) {
            if (block.type === 'paragraph') block.inlines.forEach((inline) => { if (inline.type === 'text' && inline.style.fonts) stacks.push(inline.style.fonts); });
            else if (block.type === 'table') block.rows.forEach((row) => row.cells.forEach((cell) => collect(cell.blocks)));
            else if (block.type === 'toc') collect([...(block.title ? [block.title] : []), ...block.entries]);
        }
    };
    collect(model.body);
    model.footnotes.forEach(collect);
    const fonts = new Map<string, string | undefined>();
    for (const stack of stacks) if (stack[0] && !fonts.has(stack[0])) fonts.set(stack[0], stack[1]);
    if (!model.base.fonts[0]) fonts.set(FALLBACK_FONT, undefined);
    if (!model.base.codeFonts[0]) fonts.set(FALLBACK_CODE_FONT, undefined);
    const entries = [...fonts].map(([name, alternate]) => `<w:font w:name="${escapeXml(name)}">`
        + `${alternate ? `<w:altName w:val="${escapeXml(alternate)}"/>` : ''}<w:charset w:val="00"/><w:family w:val="auto"/><w:pitch w:val="variable"/></w:font>`).join('');
    return `${XML_HEADER}<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${entries}</w:fonts>`;
}

/**
 * パーツの種類（Content Types）を作る。
 * @param header - ヘッダーがあるときtrue。
 * @param footer - フッターがあるときtrue。
 * @returns [Content_Types].xml。
 */
function contentTypesXml(header: boolean, footer: boolean): string {
    const main = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
    /** パーツごとの種類（Override要素）を作る。 */
    const override = (part: string, type: string): string => `<Override PartName="${part}" ContentType="${type}"/>`;
    return `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
        + '<Default Extension="gif" ContentType="image/gif"/><Default Extension="bmp" ContentType="image/bmp"/>'
        + override('/word/document.xml', `${main}.document.main+xml`)
        + override('/word/styles.xml', `${main}.styles+xml`)
        + override('/word/settings.xml', `${main}.settings+xml`)
        + override('/word/numbering.xml', `${main}.numbering+xml`)
        + override('/word/fontTable.xml', `${main}.fontTable+xml`)
        + override('/word/footnotes.xml', `${main}.footnotes+xml`)
        + (header ? override('/word/header1.xml', `${main}.header+xml`) : '')
        + (footer ? override('/word/footer1.xml', `${main}.footer+xml`) : '')
        + override('/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml')
        + override('/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml')
        + '</Types>';
}

/** @returns パッケージの関係（_rels/.rels）。 */
function packageRelsXml(): string {
    return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
        + '</Relationships>';
}

/**
 * 文書のプロパティ（タイトル・言語）を作る。作成日時は再現性のため含めない。
 * @param title - 文書タイトル。
 * @param language - `--language`の値。
 * @returns docProps/core.xml。
 */
function corePropertiesXml(title: string, language: string): string {
    return `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"`
        + ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        + `<dc:title>${escapeXml(title)}</dc:title><dc:language>${LANGUAGE_TAGS[language] ?? 'en-US'}</dc:language></cp:coreProperties>`;
}

/** @returns アプリケーションのプロパティ（docProps/app.xml）。 */
function appPropertiesXml(): string {
    return `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>mve-convert</Application></Properties>`;
}
