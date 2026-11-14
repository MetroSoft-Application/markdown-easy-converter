/**
 * @fileoverview 印刷用HTMLを読み込んだページ内で、描画済みDOMをDOCXの中間モデル（model.ts）へ変換する。
 * 実行境界: ブラウザー内。build.mjsが`dist/docx-extract.js`（IIFE、グローバル名`mveDocxExtract`）へ束ね、
 * Node側（render.ts）がJavaScript無効のコンテキストで`page.evaluate`に文字列として渡して実行する。
 *
 * 書式・配置・表示可否・画像寸法は、PDFと同じ印刷CSSを適用した計算済みスタイルと描画結果から読む。
 * Markdown由来の要素と生HTMLを区別せず扱えるようにし、PDFとDOCXで見た目の判断を揃えるため。
 * Wordがそのまま扱えない要素（Mermaid、SVG・WebP画像、リモート画像、OMMLへ変換できない数式）には
 * `data-mve-docx-raster`属性を付け、Node側が要素のスクリーンショットでPNG化する。DOMへの変更はこの属性だけに限る。
 */
import type {
    DocxBlock, DocxBorder, DocxImage, DocxInline, DocxListFormat, DocxModel, DocxNumbering, DocxParagraph, DocxRunStyle,
    DocxTable, DocxTableCell, DocxToc
} from './model';
import { mathmlToOmml, UnsupportedMathError } from './mathml';

/** CSSピクセルからtwip（1/1440インチ）への換算。CSSの1pxは1/96インチ。 */
const TWIPS_PER_PIXEL = 15;
/** リストの入れ子1段ごとの字下げ（twip）。印刷CSSのリスト字下げ（約2em）に近い値。 */
const LIST_INDENT = 420;
/** 引用の入れ子1段ごとの字下げ（twip）。 */
const QUOTE_INDENT = 284;
/** Wordの番号付けが扱える入れ子の最大段数（0始まりで8）。 */
const MAX_LIST_LEVEL = 8;

/** ブロックを辿るときに受け継ぐ文脈。 */
interface BlockContext {
    /** 引用の入れ子の深さ。 */
    quote: number;
    /** 本文の左端（twip）。 */
    indent: number;
    /** リストの入れ子の深さ（リスト外は-1）。 */
    listLevel: number;
    /** 次に作る段落へ付けるリスト番号。リスト項目の最初の段落だけが番号を持つ。 */
    pending?: { numbering: DocxNumbering; used: boolean };
    /** 最も内側の引用の縦線。 */
    quoteBorder?: DocxBorder;
    /** 最も内側の引用の背景色。 */
    quoteShading?: string;
    /** 最も内側の引用の通し番号。隣り合う別々の引用（連続するGitHub Alertsなど）を区別する。 */
    quoteGroup?: number;
}

/** 段落内の要素を辿るときに受け継ぐ文脈。 */
interface InlineContext {
    /** 囲んでいるリンク。 */
    link?: { href: string } | { anchor: string };
    /** 段落の基準色。これと同じ文字色は書式から省く。 */
    baseColor: string;
    /** 段落のWordスタイルの文字サイズ（CSSピクセル）。これと異なる文字列だけに文字サイズを付ける。 */
    baseSize: number;
}

/**
 * 段落を組み立てる途中の状態。行内の要素を受け取り、独立数式などのブロックが現れたら段落を区切る。
 */
class ParagraphBuilder {
    /** 組み立て中の段落の行内要素。 */
    private inlines: DocxInline[] = [];

    /**
     * @param output - 完成したブロックの出力先。
     * @param template - 段落の共通属性（見出し段階、配置、インデントなど）。
     * @param context - 番号の付与に使うブロック文脈。
     */
    constructor(
        private readonly output: DocxBlock[],
        private readonly template: Omit<DocxParagraph, 'type' | 'inlines'>,
        private readonly context: BlockContext
    ) { }

    /** @param inline - 段落に追加する行内要素。 */
    add(inline: DocxInline): void {
        this.inlines.push(inline);
    }

    /**
     * 独立数式を、組み立て中の段落と同じ字下げ・罫線・背景の段落として追加する。
     * @param omml - m:oMathPara要素。
     */
    addMath(omml: string): void {
        const { heading: _heading, bookmark: _bookmark, numbering: _numbering, ...paragraph } = this.template;
        this.flush();
        // 数式段落は番号を持てないため、リスト項目が数式で始まる場合は番号だけの段落を先に置く。
        emitPendingNumbering(this.context, this.output);
        this.output.push({ type: 'math', omml, paragraph });
    }

    /**
     * 中央揃えの独立段落を追加する。OMMLへ変換できなかった独立数式の画像に使う。
     * @param inline - 段落の唯一の要素。
     */
    addCentered(inline: DocxInline): void {
        const { heading: _heading, bookmark: _bookmark, numbering: _numbering, ...paragraph } = this.template;
        this.flush();
        emitPendingNumbering(this.context, this.output);
        this.output.push({ type: 'paragraph', ...paragraph, align: 'center', inlines: [inline] });
    }

    /**
     * 組み立て中の段落を出力へ確定する。前後の空白だけの段落は作らない。
     * @param force - 内容が空でも段落を作る（見出し、空のセル）ときtrue。
     */
    flush(force = false): void {
        const inlines = trimInlines(this.inlines);
        this.inlines = [];
        if (!inlines.length && !force) return;
        const paragraph: DocxParagraph = { type: 'paragraph', ...this.template, inlines };
        applyListNumbering(paragraph, this.context);
        consumePageBreak(paragraph);
        this.output.push(paragraph);
    }
}

/** 抽出1回分の状態。 */
interface ExtractState {
    /** 登録した画像。添字を`DocxInline`の`image.id`が参照する。 */
    images: DocxImage[];
    /** 脚注の本文。添字を`DocxInline`の`footnote.id`が参照する。 */
    footnotes: DocxBlock[][];
    /** 利用者へ出す警告。 */
    warnings: string[];
    /** 画像化を登録済みの要素と、その画像の添字。同じ要素を2回登録すると属性が上書きされ、前の画像を撮れなくなるため再利用する。 */
    rasterIndexes: WeakMap<Element, number>;
    /** 引用の通し番号。引用ごとに増やし、段落の`quoteGroup`にする。 */
    quoteCounter: number;
    /** 脚注本文の要素と、その脚注の添字。2回目以降の参照は同じ脚注を指す（WordのNOTEREF）。 */
    footnoteIndexes: Map<Element, number>;
    /** 変換中の脚注の深さ。Wordの脚注は入れ子にできないため、脚注本文の中の脚注参照は文字のまま出す。自己参照による無限再帰も防ぐ。 */
    footnoteDepth: number;
    /** 見出しの段階ごとの計算済みの文字サイズ（CSSピクセル、最初に現れた見出し）。Wordの見出しスタイルの文字サイズにする。 */
    headingSizes: Record<string, number>;
    /** 見出しの段階ごとの計算済みの色（最初に現れた見出し）。Wordの見出しスタイルの色にし、`--css`の指定を反映する。 */
    headingColors: Record<string, string>;
    /** 見出しのid属性から、Wordのブックマーク名への対応。 */
    bookmarks: Map<string, string>;
    /** 番号付けの通し番号。リストごとに新しい番号を振り、番号付きリストの開始番号を独立させる。 */
    listCounter: number;
    /** スクリーンショット対象に付ける通し番号。 */
    rasterCounter: number;
    /** 次の段落の前で改ページする（`<!-- pagebreak -->`）。 */
    pageBreak: boolean;
    /** 本文の文字色。 */
    bodyColor: string;
    /** 本文の文字サイズ（CSSピクセル）。`--css`を含む計算済みの値で、Wordの標準スタイルの文字サイズにする。 */
    bodySize: number;
    /** コードの文字サイズ（CSSピクセル）。コードの言語ラベル（CodeCaption）の文字サイズと同じ値。 */
    codeSize: number;
    /** 本文のフォント候補。 */
    bodyFonts: string[];
}

/** 現在の抽出状態。抽出は1回の同期処理で完了するため、関数引数で引き回さずに保持する。 */
let state: ExtractState;

/**
 * 印刷用HTMLの本文（`main.mve-print`）を中間モデルへ変換する。
 * @returns 本文・脚注・画像・基準書式・警告。
 * @throws Error - 本文の要素が見つからない場合。
 */
export function extractDocxModel(): DocxModel {
    const root = document.querySelector('main.mve-print');
    if (!root) throw new Error('DOCX export could not find the rendered document body.');
    const rootStyle = getComputedStyle(root);
    state = {
        images: [],
        footnotes: [],
        warnings: [],
        rasterIndexes: new WeakMap(),
        footnoteDepth: 0,
        quoteCounter: 0,
        footnoteIndexes: new Map(),
        headingColors: {},
        headingSizes: {},
        bookmarks: new Map(),
        listCounter: 0,
        rasterCounter: 0,
        pageBreak: false,
        bodyColor: cssColorToHex(rootStyle.color) ?? '202124',
        bodyFonts: parseFontFamilies(rootStyle.fontFamily),
        bodySize: parseFloat(rootStyle.fontSize) || 16,
        codeSize: codeFontSize(root)
    };
    // 文書内リンクの飛び先になる見出しへ、先にブックマーク名を割り当てる。
    root.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]').forEach((heading, index) => {
        state.bookmarks.set(heading.id, `_mve${index + 1}`);
    });
    const body: DocxBlock[] = [];
    walkBlocks(root, { quote: 0, indent: 0, listLevel: -1 }, body);
    return {
        body,
        footnotes: state.footnotes,
        images: state.images,
        base: {
            fonts: state.bodyFonts, codeFonts: codeFontFamilies(root), color: state.bodyColor, headingColors: state.headingColors,
            bodySize: halfPoints(state.bodySize), codeSize: halfPoints(state.codeSize),
            lineHeight: lineHeightOf(root, 'p'), codeLineHeight: lineHeightOf(root, 'pre'),
            spacing: blockSpacing(root),
            headingSizes: Object.fromEntries(Object.entries(state.headingSizes).map(([tag, size]) => [tag, halfPoints(size)]))
        },
        warnings: state.warnings
    };
}

/**
 * CSSピクセルをWordの文字サイズ単位（半ポイント、整数、最小1pt）へ換算する。
 * @param pixels - CSSピクセル。
 * @returns 半ポイント。
 */
function halfPoints(pixels: number): number {
    return Math.max(2, Math.round(pixels * 0.75 * 2));
}

/**
 * コードに使われるフォントを、一時的な`code`要素の計算済みスタイルから読む。
 * @param root - 印刷本文の要素。一時要素はすぐ取り除く。
 * @returns フォント候補。
 */
function codeFontFamilies(root: Element): string[] {
    const probe = document.createElement('code');
    root.append(probe);
    const fonts = parseFontFamilies(getComputedStyle(probe).fontFamily);
    probe.remove();
    return fonts;
}

/**
 * 段落と見出しの前後の間隔を、印刷CSSの計算済みの余白から求める。
 * CSSでは隣り合う上下の余白は大きい方に重なる（相殺）が、Wordは前の段落の「後」と次の段落の「前」を足し合わせる。
 * そのため段落の間隔は後ろだけに置き（重なった値 max(上, 下)）、見出しの「前」は段落の間隔を超える分だけにする。
 * 見出しの「後」には下の余白に加え、下線までの内側の余白（padding-bottom）と次の段落の上余白との重なりを反映する。
 * @param root - 印刷本文の要素。一時要素はすぐ取り除く。
 * @returns 間隔（pt）。
 */
function blockSpacing(root: Element): DocxModel['base']['spacing'] {
    /** 一時要素の上下の余白と内側の余白（pt）を読む。 */
    const measure = (tag: string): { top: number; bottom: number; padding: number } => {
        const probe = document.createElement(tag);
        probe.textContent = 'x';
        root.append(probe);
        const style = getComputedStyle(probe);
        const result = {
            top: (parseFloat(style.marginTop) || 0) * 0.75,
            bottom: (parseFloat(style.marginBottom) || 0) * 0.75,
            padding: (parseFloat(style.paddingBottom) || 0) * 0.75
        };
        probe.remove();
        return result;
    };
    const paragraph = measure('p');
    const gap = Math.max(paragraph.top, paragraph.bottom);
    const headings: Record<string, { before: number; after: number }> = {};
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
        const heading = measure(tag);
        headings[tag] = {
            before: Math.max(0, Math.max(heading.top, gap) - gap),
            after: heading.padding + Math.max(heading.bottom, paragraph.top)
        };
    }
    const round = (value: number): number => Math.round(value * 100) / 100;
    return {
        paragraph: round(gap),
        headings: Object.fromEntries(Object.entries(headings).map(([tag, value]) => [tag, { before: round(value.before), after: round(value.after) }]))
    };
}

/**
 * 段落・コードブロックの行の高さを、一時的な要素の計算済みスタイルから読む。
 * line-heightが`normal`の場合は、文字サイズの1.2倍（ブラウザーの一般的な既定）とみなす。
 * @param root - 印刷本文の要素。一時要素はすぐ取り除く。
 * @param tag - 調べる要素名（`p`・`pre`）。
 * @returns 行の高さ（pt）。
 */
function lineHeightOf(root: Element, tag: string): number {
    const probe = document.createElement(tag);
    probe.textContent = 'x';
    root.append(probe);
    const style = getComputedStyle(probe);
    const fontSize = parseFloat(style.fontSize) || 16;
    const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.2;
    probe.remove();
    return Math.round(lineHeight * 0.75 * 100) / 100;
}

/**
 * コードブロックの文字サイズを、一時的な`pre`要素の計算済みスタイルから読む。
 * @param root - 印刷本文の要素。一時要素はすぐ取り除く。
 * @returns CSSピクセル。読めなければ本文と同じ16px。
 */
function codeFontSize(root: Element): number {
    const probe = document.createElement('pre');
    root.append(probe);
    const size = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return size || 16;
}

/**
 * 要素の子を順にブロックへ変換する。行内の子は暗黙の段落へまとめる。
 * @param container - 子を辿る要素。
 * @param context - 受け継ぐブロック文脈。
 * @param output - ブロックの出力先。
 */
function walkBlocks(container: Element, context: BlockContext, output: DocxBlock[]): void {
    const builder = new ParagraphBuilder(output, paragraphTemplate(container, context), context);
    const inline: InlineContext = { baseColor: state.bodyColor, baseSize: state.bodySize };
    for (const child of Array.from(container.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
            addText(child as Text, builder, inline);
            continue;
        }
        if (!(child instanceof Element) || !isRendered(child)) continue;
        if (isInlineElement(child)) {
            walkInline(child, builder, inline);
            continue;
        }
        builder.flush();
        convertBlock(child, context, output);
    }
    builder.flush();
}

/**
 * ブロック要素を1つ変換する。
 * @param element - 変換する要素。
 * @param context - 受け継ぐブロック文脈。
 * @param output - ブロックの出力先。
 */
function convertBlock(element: Element, context: BlockContext, output: DocxBlock[]): void {
    const tag = element.localName;
    if (/^h[1-6]$/.test(tag)) {
        const style = getComputedStyle(element);
        const builder = new ParagraphBuilder(output, {
            ...paragraphTemplate(element, context),
            heading: Number(tag[1]),
            bookmark: element.id ? state.bookmarks.get(element.id) : undefined,
            // 印刷CSSのh1・h2の下線を写す。
            bottomBorder: borderOf(style.borderBottomStyle, style.borderBottomWidth, style.borderBottomColor)
        }, context);
        // 段階ごとに最初の見出しの色をスタイルの色にし、同じ色の文字には色を付けない（Wordでスタイルの色を変えられる）。
        const color = cssColorToHex(style.color) ?? state.bodyColor;
        state.headingColors[tag] ??= color;
        state.headingSizes[tag] ??= parseFloat(style.fontSize) || state.bodySize;
        walkInlineChildren(element, builder, { baseColor: state.headingColors[tag], baseSize: state.headingSizes[tag] });
        builder.flush(true);
        return;
    }
    if (tag === 'ul' || tag === 'ol') {
        emitPendingNumbering(context, output);
        convertList(element, context, output);
        return;
    }
    if (tag === 'pre') {
        output.push(codeParagraph(element, context));
        return;
    }
    if (tag === 'table') {
        emitPendingNumbering(context, output);
        const table = convertTable(element as HTMLTableElement, context);
        if (table) output.push(table);
        return;
    }
    if (tag === 'hr') {
        const style = getComputedStyle(element);
        const paragraph: DocxParagraph = {
            type: 'paragraph', ...paragraphTemplate(element, context),
            bottomBorder: { color: cssColorToHex(style.borderTopColor) ?? 'BBBBBB', width: Math.max(1, parseFloat(style.borderTopWidth) || 1) },
            inlines: []
        };
        consumePageBreak(paragraph);
        output.push(paragraph);
        return;
    }
    if (tag === 'summary') {
        // ブラウザーが::markerとして描く開閉マーカーはDOMにないため、印刷と同じ記号（閉: ▶、開: ▼）を先頭に置く。
        const builder = new ParagraphBuilder(output, paragraphTemplate(element, context), context);
        const open = element.parentElement?.localName === 'details' && element.parentElement.hasAttribute('open');
        builder.add({ type: 'text', text: open ? '▼ ' : '▶ ', style: {} });
        walkInlineChildren(element, builder, { baseColor: state.bodyColor, baseSize: state.bodySize });
        builder.flush();
        return;
    }
    if (tag === 'figcaption') {
        const builder = new ParagraphBuilder(output, { ...paragraphTemplate(element, context), style: 'caption' }, context);
        walkInlineChildren(element, builder, { baseColor: state.bodyColor, baseSize: state.codeSize });
        builder.flush();
        return;
    }
    if (element.classList.contains('page-break')) {
        state.pageBreak = true;
        return;
    }
    if (element.classList.contains('table-of-contents')) {
        output.push(convertToc(element, context));
        return;
    }
    if (element.classList.contains('footnotes')) {
        // 脚注は参照位置でWordの脚注として出すため、文末の一覧は出力しない。
        return;
    }
    if (element.classList.contains('diagram-block') && element.getAttribute('data-mermaid-status') !== 'error') {
        const svg = element.querySelector('svg');
        if (svg) {
            // 図の揃えは描画位置から決める。図はtext-alignではなくmarginで中央に置かれる場合があるため。
            const box = element.getBoundingClientRect();
            const figure = svg.getBoundingClientRect();
            const left = figure.left - box.left;
            const right = box.right - figure.right;
            // 枠より広い図（はみ出し）は本文幅に縮めて置くため中央にする。
            const align = figure.width >= box.width || Math.abs(left - right) <= 2 ? 'center' : left > right ? 'right' : undefined;
            const builder = new ParagraphBuilder(output, { ...paragraphTemplate(element, context), align }, context);
            builder.add(rasterImage(svg, 'Mermaid diagram'));
            builder.flush();
            return;
        }
    }
    if (tag === 'blockquote' || element.classList.contains('markdown-alert')) {
        // Wordの段落罫線は左に1本だけのため、入れ子の引用は最も内側の縦線と背景を使い、字下げで深さを表す。
        const style = getComputedStyle(element);
        walkBlocks(element, {
            ...context,
            quote: context.quote + 1,
            indent: context.indent + QUOTE_INDENT,
            pending: undefined,
            quoteBorder: borderOf(style.borderLeftStyle, style.borderLeftWidth, style.borderLeftColor) ?? context.quoteBorder,
            quoteShading: cssColorToHex(style.backgroundColor) ?? context.quoteShading,
            quoteGroup: ++state.quoteCounter
        }, output);
        return;
    }
    if (tag === 'svg') {
        const builder = new ParagraphBuilder(output, paragraphTemplate(element, context), context);
        builder.add(rasterImage(element, ''));
        builder.flush();
        return;
    }
    walkBlocks(element, context, output);
}

/**
 * 段落の共通属性を、文脈と要素の計算済みスタイルから作る。
 * @param element - 段落になる要素。文字揃えを読む。
 * @param context - 受け継ぐブロック文脈。
 * @returns 段落の共通属性。
 */
function paragraphTemplate(element: Element, context: BlockContext): Omit<DocxParagraph, 'type' | 'inlines'> {
    // 表のalign属性は計算済みスタイルで`-webkit-center`などになるため、接頭辞を除いて判定する。
    const textAlign = getComputedStyle(element).textAlign.replace(/^-webkit-/, '');
    const align = textAlign === 'center' ? 'center'
        : textAlign === 'right' || textAlign === 'end' ? 'right'
            : textAlign === 'justify' ? 'both' : undefined;
    return {
        align,
        quote: context.quote || undefined,
        leftBorder: context.quote ? context.quoteBorder : undefined,
        quoteGroup: context.quote ? context.quoteGroup : undefined,
        shading: context.quote ? context.quoteShading : undefined,
        list: context.listLevel >= 0 || undefined,
        indent: context.indent || undefined
    };
}

/**
 * CSSの罫線を段落の罫線へ写す。
 * @param style - border-*-style。
 * @param width - border-*-width。
 * @param color - border-*-color。
 * @returns 罫線。線がない・透明な場合はundefined。
 */
function borderOf(style: string, width: string, color: string): DocxBorder | undefined {
    const pixels = parseFloat(width);
    const hex = cssColorToHex(color);
    if (style === 'none' || style === 'hidden' || !(pixels > 0) || !hex) return undefined;
    return { color: hex, width: pixels };
}

/**
 * リスト項目の最初の段落へ番号を付け、2つ目以降の段落は番号の右へ揃える。
 * @param paragraph - 確定する段落。
 * @param context - リスト番号を持つブロック文脈。
 */
function applyListNumbering(paragraph: DocxParagraph, context: BlockContext): void {
    if (!context.pending || paragraph.heading) return;
    if (!context.pending.used) {
        context.pending.used = true;
        paragraph.numbering = context.pending.numbering;
        paragraph.hanging = LIST_INDENT;
    }
}

/**
 * リスト項目が段落以外（入れ子のリスト・表・独立数式）で始まる場合に、番号・記号だけの段落を先に置く。
 * 番号を持てない要素の前で番号が失われ、項目の区切りが見えなくなるのを防ぐ。
 * @param context - リスト番号を持つブロック文脈。
 * @param output - ブロックの出力先。
 */
function emitPendingNumbering(context: BlockContext, output: DocxBlock[]): void {
    if (!context.pending || context.pending.used) return;
    const paragraph: DocxParagraph = { type: 'paragraph', list: true, indent: context.indent || undefined, inlines: [] };
    applyListNumbering(paragraph, context);
    consumePageBreak(paragraph);
    output.push(paragraph);
}

/**
 * 保留中の改ページを段落へ付ける。
 * @param paragraph - 次に出力する段落。
 */
function consumePageBreak(paragraph: DocxParagraph): void {
    if (!state.pageBreak) return;
    state.pageBreak = false;
    paragraph.pageBreakBefore = true;
}

/**
 * 箇条書き・番号付きリストを変換する。形式は計算済みのlist-style-typeから決める（タスクリストは記号なし）。
 * @param list - ul・ol要素。
 * @param context - 受け継ぐブロック文脈。
 * @param output - ブロックの出力先。
 */
function convertList(list: Element, context: BlockContext, output: DocxBlock[]): void {
    state.listCounter += 1;
    const listId = state.listCounter;
    const level = Math.min(MAX_LIST_LEVEL, context.listLevel + 1);
    const start = list.localName === 'ol' ? (list as HTMLOListElement).start : 1;
    const itemIndent = context.indent + LIST_INDENT;
    for (const item of Array.from(list.children)) {
        if (item.localName !== 'li' || !isRendered(item)) continue;
        const format = listFormat(getComputedStyle(item).listStyleType);
        walkBlocks(item, {
            ...context,
            indent: itemIndent,
            listLevel: level,
            pending: format === 'none' ? undefined : { numbering: { list: listId, level, format, start }, used: false }
        }, output);
    }
}

/**
 * CSSのlist-style-typeを番号の形式へ写す。未知の形式は記号の箇条書きにする。
 * @param value - 計算済みのlist-style-type。
 * @returns 番号の形式。
 */
function listFormat(value: string): DocxListFormat {
    switch (value) {
        case 'none': return 'none';
        case 'decimal':
        case 'decimal-leading-zero': return 'decimal';
        case 'lower-alpha':
        case 'lower-latin': return 'lowerLetter';
        case 'upper-alpha':
        case 'upper-latin': return 'upperLetter';
        case 'lower-roman': return 'lowerRoman';
        case 'upper-roman': return 'upperRoman';
        default: return 'bullet';
    }
}

/**
 * コードブロックを、改行を段落内改行にした1つの段落へ変換する。シンタックスハイライトの色は文字色として写す。
 * @param pre - pre要素。
 * @param context - 受け継ぐブロック文脈。
 * @returns コード段落。
 */
function codeParagraph(pre: Element, context: BlockContext): DocxParagraph {
    const preStyle = getComputedStyle(pre);
    const baseColor = cssColorToHex(preStyle.color) ?? state.bodyColor;
    const inlines: DocxInline[] = [];
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent) continue;
        const style = runStyle(parent, baseColor, parseFloat(preStyle.fontSize) || state.codeSize, pre);
        const lines = (node as Text).data.split('\n');
        lines.forEach((line, index) => {
            if (index > 0) inlines.push({ type: 'break' });
            if (line) inlines.push({ type: 'text', text: line, style });
        });
    }
    // 末尾の改行は空行として表示されないため除く。
    while (inlines.length && inlines[inlines.length - 1].type === 'break') inlines.pop();
    const paragraph: DocxParagraph = {
        type: 'paragraph',
        style: 'code',
        quote: context.quote || undefined,
        indent: context.indent || undefined,
        shading: cssColorToHex(preStyle.backgroundColor),
        inlines
    };
    applyListNumbering(paragraph, context);
    consumePageBreak(paragraph);
    return paragraph;
}

/**
 * 表を変換する。セルの結合は描画上の位置から求めるため、colspan・rowspanの指定ミスがあっても描画どおりになる。
 * @param table - table要素。
 * @param context - 受け継ぐブロック文脈。
 * @returns 表。行または列がない場合はundefined。
 */
function convertTable(table: HTMLTableElement, context: BlockContext): DocxTable | undefined {
    const rows = Array.from(table.rows).filter((row) => isRendered(row));
    const cells = rows.map((row) => Array.from(row.cells).filter((cell) => isRendered(cell)));
    // 全セルの左右端の位置から列の境界を求める。
    const edges = new Set<number>();
    cells.flat().forEach((cell) => {
        const rect = cell.getBoundingClientRect();
        edges.add(Math.round(rect.left));
        edges.add(Math.round(rect.right));
    });
    const boundaries = [...edges].sort((left, right) => left - right);
    const columns = boundaries.slice(1).map((edge, index) => Math.max(1, (edge - boundaries[index]) * TWIPS_PER_PIXEL));
    // 行や列のない表（`<table></table>`、全セルが非表示）は、Wordが修復対象にする不正な表になるため出力しない。
    if (!rows.length || !columns.length) return undefined;
    /** セルの端のx座標を列の境界の番号へ写す。上で集めた丸め方と同じ丸め方で探す。見つからなければ-1。 */
    const columnIndex = (x: number): number => boundaries.indexOf(Math.round(x));
    // 各行の各列を占めるセルを記録し、上から続く結合セルを後で補う。
    const grid: Array<Array<{ cell: HTMLTableCellElement; row: number; span: number } | undefined>> = rows.map(() => []);
    cells.forEach((rowCells, rowIndex) => {
        for (const cell of rowCells) {
            const rect = cell.getBoundingClientRect();
            const from = columnIndex(rect.left);
            const to = columnIndex(rect.right);
            if (from < 0 || to <= from) continue;
            const rowSpan = Math.max(1, Math.min(cell.rowSpan || 1, rows.length - rowIndex));
            for (let row = rowIndex; row < rowIndex + rowSpan; row += 1) {
                for (let column = from; column < to; column += 1) grid[row][column] = { cell, row: rowIndex, span: to - from };
            }
        }
    });
    const header = new Set(table.tHead ? Array.from(table.tHead.rows) : []);
    const resultRows: DocxTable['rows'] = rows.map((row, rowIndex) => {
        const rowCells: DocxTableCell[] = [];
        for (let column = 0; column < columns.length;) {
            const slot = grid[rowIndex][column];
            if (!slot) {
                rowCells.push({ blocks: [{ type: 'paragraph', inlines: [] }], colSpan: 1, width: columns[column] });
                column += 1;
                continue;
            }
            const width = columns.slice(column, column + slot.span).reduce((sum, value) => sum + value, 0);
            const merged = slot.cell.rowSpan > 1;
            if (slot.row !== rowIndex) {
                rowCells.push({ blocks: [{ type: 'paragraph', inlines: [] }], colSpan: slot.span, width, vMerge: 'continue' });
            } else {
                rowCells.push(convertCell(slot.cell, row, slot.span, width, merged, context));
            }
            column += slot.span;
        }
        return { header: header.has(row), cells: rowCells };
    });
    return { type: 'table', columns, rows: resultRows, indent: context.indent || undefined };
}

/**
 * 表のセルを変換する。セル内は本文と同じ規則でブロックへ変換し、空のセルにも段落を1つ置く。
 * @param cell - td・th要素。
 * @param row - セルの行。セルに背景がなければ行の背景を使う。
 * @param span - 横方向の結合数。
 * @param width - セル幅（twip）。
 * @param merged - 縦結合の起点ならtrue。
 * @param context - 表の外側のブロック文脈。セル内では引用・リストの字下げを引き継がない。
 * @returns セル。
 */
function convertCell(
    cell: HTMLTableCellElement, row: HTMLTableRowElement, span: number, width: number, merged: boolean, context: BlockContext
): DocxTableCell {
    const blocks: DocxBlock[] = [];
    walkBlocks(cell, { quote: 0, indent: 0, listLevel: -1 }, blocks);
    if (!blocks.length) blocks.push({ type: 'paragraph', ...paragraphTemplate(cell, context), quote: undefined, indent: undefined, inlines: [] });
    const style = getComputedStyle(cell);
    const verticalAlign = style.verticalAlign;
    return {
        blocks,
        colSpan: span,
        width,
        vMerge: merged ? 'restart' : undefined,
        shading: cssColorToHex(style.backgroundColor) ?? cssColorToHex(getComputedStyle(row).backgroundColor),
        vAlign: verticalAlign === 'middle' ? 'center' : verticalAlign === 'bottom' ? 'bottom' : undefined
    };
}

/**
 * 目次（`[toc]`）をWordの目次フィールドへ変換する。項目は描画済みの目次から作り、Wordで更新すればページ番号付きになる。
 * @param nav - 目次のnav要素。
 * @param context - 受け継ぐブロック文脈。
 * @returns 目次。
 */
function convertToc(nav: Element, context: BlockContext): DocxToc {
    const titleElement = Array.from(nav.children).find((child) => child.localName !== 'ul' && child.localName !== 'ol');
    let title: DocxParagraph | undefined;
    if (titleElement && isRendered(titleElement)) {
        const blocks: DocxBlock[] = [];
        const builder = new ParagraphBuilder(blocks, { ...paragraphTemplate(titleElement, context), style: 'tocTitle' }, context);
        walkInlineChildren(titleElement, builder, { baseColor: state.bodyColor, baseSize: state.bodySize });
        builder.flush();
        title = blocks[0] as DocxParagraph | undefined;
    }
    const entries: DocxParagraph[] = [];
    nav.querySelectorAll('li').forEach((item) => {
        const level = Math.min(6, Math.max(1, Number(/toc-level-(\d)/.exec(item.className)?.[1] ?? '1')));
        const blocks: DocxBlock[] = [];
        const builder = new ParagraphBuilder(blocks, { tocLevel: level }, context);
        walkInlineChildren(item, builder, { baseColor: state.bodyColor, baseSize: state.bodySize });
        builder.flush();
        if (blocks[0]) entries.push(blocks[0] as DocxParagraph);
    });
    return { type: 'toc', title, entries };
}

/**
 * 要素の子を段落内の要素として辿る。
 * @param element - 子を辿る要素。
 * @param builder - 段落の組み立て先。
 * @param context - 受け継ぐ行内文脈。
 */
function walkInlineChildren(element: Element, builder: ParagraphBuilder, context: InlineContext): void {
    for (const child of Array.from(element.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) addText(child as Text, builder, context);
        else if (child instanceof Element && isRendered(child)) walkInline(child, builder, context);
    }
}

/**
 * 段落内の要素を1つ変換する。ブロック表示の要素が行内に現れた場合も、内容を行内として扱う。
 * @param element - 変換する要素。
 * @param builder - 段落の組み立て先。
 * @param context - 受け継ぐ行内文脈。
 */
function walkInline(element: Element, builder: ParagraphBuilder, context: InlineContext): void {
    const tag = element.localName;
    if (tag === 'br') {
        builder.add({ type: 'break' });
        return;
    }
    if (tag === 'button') return;
    if (tag === 'input') {
        const input = element as HTMLInputElement;
        if (input.type === 'checkbox') builder.add({ type: 'text', text: input.checked ? '☑ ' : '☐ ', style: {} });
        return;
    }
    if (tag === 'img') {
        builder.add(imageInline(element as HTMLImageElement));
        return;
    }
    if (tag === 'svg') {
        builder.add(rasterImage(element, ''));
        return;
    }
    if (element.classList.contains('math-node')) {
        convertMath(element, builder);
        return;
    }
    // Wordの脚注は入れ子にできないため、脚注本文の中の脚注参照（自己参照・相互参照を含む）は文字のまま出す。
    if (element.classList.contains('footnote-ref') && state.footnoteDepth === 0) {
        const target = element.querySelector('a')?.getAttribute('href') ?? '';
        const footnote = target.startsWith('#') ? document.getElementById(safeDecode(target.slice(1))) : null;
        if (footnote) {
            // 2回目以降の参照は同じ脚注の番号を参照する（PDFと同じく同じ番号を表示する）。
            const existing = state.footnoteIndexes.get(footnote);
            if (existing !== undefined) builder.add({ type: 'footnote', id: existing, repeat: true });
            else {
                const id = footnoteFor(footnote);
                state.footnoteIndexes.set(footnote, id);
                builder.add({ type: 'footnote', id });
            }
            return;
        }
    }
    if (tag === 'a') {
        const href = element.getAttribute('href') ?? '';
        // 脚注本文の「戻る」リンクはWordの脚注では意味がないため出力しない。
        if (/^#fnref/i.test(href)) return;
        walkInlineChildren(element, builder, { ...context, link: resolveLink(href, element) ?? context.link });
        return;
    }
    walkInlineChildren(element, builder, context);
}

/**
 * リンク先をWordのハイパーリンクへ写す。文書内の見出しへのリンクはブックマークへ、外部・相対パスはそのまま使う。
 * 見出し自身へのリンク（見出しのアンカー記号）や、解決できない文書内リンクはリンクにしない。
 * @param href - href属性。
 * @param element - a要素。見出し内のアンカーかを判定する。
 * @returns リンク先。リンクにしない場合はundefined。
 */
function resolveLink(href: string, element: Element): InlineContext['link'] | undefined {
    if (!href) return undefined;
    if (href.startsWith('#')) {
        const id = safeDecode(href.slice(1));
        if (element.closest('h1, h2, h3, h4, h5, h6')?.id === id) return undefined;
        const bookmark = state.bookmarks.get(id);
        return bookmark ? { anchor: bookmark } : undefined;
    }
    if (/^(?:javascript|vbscript|data):/i.test(href)) return undefined;
    // Wordや他の読み取り側は空白などを含む不正なURIを拒否するため、ブラウザーと同じ規則で正規化する。
    // 絶対URLは解釈できなければリンクにせず、相対パスは文字をエンコードするだけにする。
    if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
        try {
            return { href: new URL(href).href };
        } catch {
            return undefined;
        }
    }
    return { href: encodeURI(safeDecode(href)) };
}

/**
 * 脚注本文を変換し、脚注の番号を返す。同じ脚注を複数回参照した場合も、Wordでは参照ごとに脚注を作る。
 * @param item - 脚注本文のli要素。
 * @returns `DocxModel.footnotes`の添字。
 */
function footnoteFor(item: Element): number {
    const blocks: DocxBlock[] = [];
    // 脚注の一覧は印刷時も表示されるが、本文の改ページ指示を脚注へ持ち込まないよう退避する。
    const pageBreak = state.pageBreak;
    state.pageBreak = false;
    state.footnoteDepth += 1;
    try {
        walkBlocks(item, { quote: 0, indent: 0, listLevel: -1 }, blocks);
    } finally {
        state.footnoteDepth -= 1;
        state.pageBreak = pageBreak;
    }
    state.footnotes.push(blocks);
    return state.footnotes.length - 1;
}

/**
 * KaTeXの数式を変換する。MathMLをOMMLへ変換できない式は、描画結果の画像にして警告する。
 * @param node - `.math-node`要素。`math-block`クラスがあれば独立数式。
 * @param builder - 段落の組み立て先。
 */
function convertMath(node: Element, builder: ParagraphBuilder): void {
    const display = node.classList.contains('math-block') || node.querySelector('.katex-display') !== null;
    const math = node.querySelector('.katex-mathml math');
    try {
        if (!math) throw new UnsupportedMathError('math');
        const omml = mathmlToOmml(math, display);
        if (display) builder.addMath(omml);
        else builder.add({ type: 'math', omml });
    } catch (error) {
        if (!(error instanceof UnsupportedMathError)) throw error;
        const source = safeDecode(node.getAttribute('data-math-source') ?? '');
        state.warnings.push(`A math expression could not be converted to a Word equation (${error.message}); it was embedded as an image: ${source}`);
        const target = node.querySelector('.katex-html') ?? node;
        const image = rasterImage(target, source);
        if (display) builder.addCentered(image);
        else builder.add(image);
    }
}

/**
 * img要素を画像へ変換する。読み込めなかった画像は代替テキストに置き換えて警告する。
 * @param image - img要素。
 * @returns 画像、または代替テキスト。
 */
function imageInline(image: HTMLImageElement): DocxInline {
    const alt = image.getAttribute('alt') ?? '';
    const rect = image.getBoundingClientRect();
    if (!image.complete || image.naturalWidth === 0 || rect.width === 0 || rect.height === 0) {
        state.warnings.push(`An image could not be loaded and was replaced by its alternative text: ${image.getAttribute('src')?.slice(0, 200) ?? ''}`);
        // 印刷では代替テキストのない壊れた画像は何も見えないため、文字も出さない（警告は残す）。
        return { type: 'text', text: alt ? `[${alt}]` : '', style: {} };
    }
    const source = image.currentSrc || image.src;
    // Wordが直接表示できる形式だけをそのまま埋め込み、それ以外は描画結果を画像にする。
    // data URLの宣言と中身が食い違う場合に備え、そのまま埋め込む画像にもスクリーンショットの退避先を付ける。
    const dataUrl = /^data:image\/(?:png|jpeg|gif|bmp);base64,/i.test(source) ? source : undefined;
    return rasterImage(image, alt, dataUrl);
}

/**
 * 要素をスクリーンショットで画像化する対象として登録する。
 * @param element - 画像化する要素。`data-mve-docx-raster`属性を付ける。
 * @param alt - 代替テキスト。
 * @param dataUrl - そのまま埋め込める画像のdata URL。Node側で中身を確認できた場合はスクリーンショットを撮らない。
 * 同じ要素の2回目以降は最初の画像を再利用し、寸法のない要素は代替テキスト（なければ空文字列）にする。
 * @returns 画像。
 */
function rasterImage(element: Element, alt: string, dataUrl?: string): DocxInline {
    // 同じ要素（2回参照された脚注の中の図など）は、属性を上書きせず最初の画像を再利用する。
    const existing = state.rasterIndexes.get(element);
    if (existing !== undefined) return { type: 'image', id: existing };
    const rect = element.getBoundingClientRect();
    // 寸法のない要素はスクリーンショットを撮れず、待ち時間だけがかかるため画像にしない。
    if (rect.width < 1 || rect.height < 1) return { type: 'text', text: alt ? `[${alt}]` : '', style: {} };
    state.rasterCounter += 1;
    element.setAttribute('data-mve-docx-raster', String(state.rasterCounter));
    state.images.push({ dataUrl, rasterId: state.rasterCounter, width: rect.width, height: rect.height, alt });
    state.rasterIndexes.set(element, state.images.length - 1);
    return { type: 'image', id: state.images.length - 1 };
}

/**
 * テキストノードを書式付きの文字列として追加する。空白は計算済みのwhite-spaceに従って詰める。
 * @param node - テキストノード。
 * @param builder - 段落の組み立て先。
 * @param context - 受け継ぐ行内文脈。
 */
function addText(node: Text, builder: ParagraphBuilder, context: InlineContext): void {
    const parent = node.parentElement;
    if (!parent) return;
    // 閉じたdetailsの中で要素に包まれていない文字列は、親要素（details）が表示中でも描画されない。印刷と同じく出力しない。
    // 要素はcheckVisibilityで除けるが、テキストノードには使えず、描画矩形も返るため、summaryの外かどうかで判定する。
    const closed = parent.closest('details:not([open])');
    if (closed && parent.closest('summary')?.parentElement !== closed) return;
    const whiteSpace = getComputedStyle(parent).whiteSpace;
    const preserve = whiteSpace.startsWith('pre') || whiteSpace === 'break-spaces';
    const text = preserve ? node.data : node.data.replace(/[\t\n\r ]+/g, ' ');
    if (!text) return;
    const style = runStyle(parent, context.baseColor, context.baseSize);
    if (!preserve) {
        builder.add({ type: 'text', text, style, link: context.link });
        return;
    }
    text.split('\n').forEach((line, index) => {
        if (index > 0) builder.add({ type: 'break' });
        if (line) builder.add({ type: 'text', text: line, style, link: context.link, preserve: true });
    });
}

/**
 * 文字列の書式を計算済みスタイルから求める。text-decoration・vertical-align・背景は継承されないため、
 * 段落（ブロック表示の祖先）までの行内の祖先をたどって合成する。
 * @param element - 文字列の親要素。
 * @param baseColor - 段落の基準色。
 * @param baseSize - 段落のWordスタイルの文字サイズ（CSSピクセル）。異なる場合だけ文字サイズを付ける。
 * @param stop - たどるのを止める要素（コードブロックのpre）。省略時はブロック表示の祖先で止める。
 * @returns 書式。
 */
function runStyle(element: Element, baseColor: string, baseSize: number, stop?: Element): DocxRunStyle {
    const style = getComputedStyle(element);
    const result: DocxRunStyle = {};
    if (Number(style.fontWeight) >= 600) result.bold = true;
    if (style.fontStyle === 'italic' || style.fontStyle.startsWith('oblique')) result.italic = true;
    const color = cssColorToHex(style.color);
    if (color && color !== baseColor) result.color = color;
    const fonts = parseFontFamilies(style.fontFamily);
    if (fonts.length && fonts[0] !== state.bodyFonts[0]) result.fonts = fonts;
    for (let current: Element | null = element; current && current !== stop; current = current.parentElement) {
        const currentStyle = getComputedStyle(current);
        if (!stop && !isInlineDisplay(currentStyle.display)) break;
        const decoration = currentStyle.textDecorationLine;
        if (decoration.includes('underline')) result.underline = true;
        if (decoration.includes('line-through')) result.strike = true;
        if (!result.vertAlign && (currentStyle.verticalAlign === 'super' || currentStyle.verticalAlign === 'sub')) {
            result.vertAlign = currentStyle.verticalAlign === 'super' ? 'superscript' : 'subscript';
        }
        if (!result.shading && !stop) result.shading = cssColorToHex(currentStyle.backgroundColor);
    }
    // インラインコード・kbdなど、段落と異なる文字サイズの文字列にだけサイズを付ける。
    // 上付き・下付きはWordが自動で縮めるため付けない。0.25px未満の差は丸めの誤差として無視する。
    const size = parseFloat(style.fontSize);
    if (!result.vertAlign && size > 0 && Math.abs(size - baseSize) >= 0.25) result.size = halfPoints(size);
    return result;
}

/**
 * 段落の前後の空白を除き、空の文字列を取り除く。
 * @param inlines - 段落の行内要素。
 * @returns 整えた行内要素。
 */
function trimInlines(inlines: DocxInline[]): DocxInline[] {
    // ブラウザーの空白の扱いに合わせる: 段落の先頭・末尾と、改行（<br>）の前後の空白は表示されず、
    // 要素の境目をまたいで続く空白は1つにまとまる。ソース上の改行が<br>の直後の行頭に空白として残るのを防ぐ。
    const result: DocxInline[] = [];
    let atLineStart = true;
    for (const inline of inlines) {
        if (inline.type === 'break') {
            const previous = result[result.length - 1];
            if (previous?.type === 'text' && !previous.preserve) result[result.length - 1] = { ...previous, text: previous.text.replace(/ +$/, '') };
            result.push(inline);
            atLineStart = true;
            continue;
        }
        if (inline.type !== 'text') {
            result.push(inline);
            atLineStart = false;
            continue;
        }
        const previous = result[result.length - 1];
        const followsSpace = previous?.type === 'text' && !previous.preserve && previous.text.endsWith(' ');
        // white-space: pre / pre-wrap の文字列は、ブラウザーと同じく空白を保持する。
        const text = !inline.preserve && (atLineStart || followsSpace) ? inline.text.replace(/^ +/, '') : inline.text;
        if (!text) continue;
        result.push({ ...inline, text });
        atLineStart = false;
    }
    const lastText = result.length - 1;
    const last = result[lastText];
    if (last?.type === 'text' && !last.preserve) result[lastText] = { ...last, text: last.text.replace(/ +$/, '') };
    while (result.length && result[result.length - 1].type === 'break') result.pop();
    return result.filter((inline) => inline.type !== 'text' || inline.text.length > 0);
}

/**
 * 要素が描画されているか判定する。display:none、閉じたdetailsの中身、visibility:hiddenを除く。
 * @param element - 判定する要素。
 * @returns 描画されていればtrue。
 */
function isRendered(element: Element): boolean {
    if (element.localName === 'br') return true;
    return element.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true });
}

/**
 * 段落内に置く要素か判定する。
 * @param element - 判定する要素。
 * @returns 行内表示（inline、inline-blockなど）ならtrue。数式は独立数式も段落内で処理する。
 */
function isInlineElement(element: Element): boolean {
    if (element.classList.contains('math-node')) return true;
    return isInlineDisplay(getComputedStyle(element).display);
}

/**
 * CSSのdisplay値が行内表示か判定する。
 * @param display - 計算済みのdisplay。
 * @returns 行内表示ならtrue。
 */
function isInlineDisplay(display: string): boolean {
    return display === 'inline' || display.startsWith('inline-') || display === 'contents' || display === 'ruby';
}

/**
 * 計算済みスタイルの色を`RRGGBB`へ変換する。半透明の色は白い用紙に重ねた色にする。
 * @param value - `rgb()`・`rgba()`形式の色。
 * @returns 16進の色。透明・解釈できない値はundefined。
 */
function cssColorToHex(value: string): string | undefined {
    const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(value.trim());
    if (!match) return undefined;
    const alphaText = match[4];
    const alpha = alphaText === undefined ? 1 : alphaText.endsWith('%') ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
    if (!(alpha > 0)) return undefined;
    return [match[1], match[2], match[3]].map((channel) => {
        const blended = Math.round(Number(channel) * alpha + 255 * (1 - alpha));
        return Math.max(0, Math.min(255, blended)).toString(16).padStart(2, '0');
    }).join('').toUpperCase();
}

/**
 * CSSのfont-familyを、総称名を除いたフォント名の並びへ分解する。
 * @param value - 計算済みのfont-family。
 * @returns フォント名の並び。
 */
function parseFontFamilies(value: string): string[] {
    // Wordのフォント指定には総称名がないため、等幅・明朝の総称名は代表的なWindowsのフォントへ置き換える。
    // それ以外の総称名（sans-serifなど）はWordの既定に任せて除く。コードの既定（UAのmonospace）はここで決まる。
    const substitutes: Record<string, string[]> = {
        monospace: ['Consolas', 'Courier New'],
        'ui-monospace': ['Consolas', 'Courier New'],
        serif: ['Times New Roman'],
        'ui-serif': ['Times New Roman']
    };
    const generic = new Set(['sans-serif', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif',
        'ui-rounded', 'math', 'emoji', 'fangsong', '-apple-system', 'blinkmacsystemfont']);
    const names = value.split(',')
        .map((name) => name.trim().replace(/^(["'])(.*)\1$/, '$2').trim())
        .flatMap((name) => substitutes[name.toLowerCase()] ?? [name])
        .filter((name) => name && !generic.has(name.toLowerCase()));
    return [...new Set(names)];
}

/**
 * URLエンコードを戻す。不正なエンコードは元の文字列のまま使う。
 * @param value - エンコードされた文字列。
 * @returns 戻した文字列。
 */
function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
