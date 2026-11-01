/**
 * @fileoverview 独立出力エンジンが使用するPDF・HTML設定、Mermaid寸法と正規化規則を定義する。
 */
import { DEFAULT_FONT_FAMILY_STACK } from './fontFamily';

/**
 * 編集画面に適用するライト・ダークテーマを表す値。
 */
export type EditorTheme = 'light' | 'dark';

/** Mermaid SVGの文字サイズ設定に使う既定値（px）。 */
export const DEFAULT_MERMAID_FONT_SIZE = 16;

/** Mermaid SVGで選択できる文字サイズの最小値（px）。 */
export const MIN_MERMAID_FONT_SIZE = 8;

/** Mermaid SVGで選択できる文字サイズの最大値（px）。 */
export const MAX_MERMAID_FONT_SIZE = 48;

/**
 * Mermaid文字サイズを整数の8〜48pxへ正規化し、不正値は16pxへ戻す。
 * @param value - 設定、メッセージ、または描画要求から受け取った候補値。
 * @returns Mermaid描画と出力へ適用する有効な文字サイズ。
 */
export function normalizeMermaidFontSize(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MERMAID_FONT_SIZE;
    return Math.max(MIN_MERMAID_FONT_SIZE, Math.min(MAX_MERMAID_FONT_SIZE, Math.round(value)));
}

/**
 * PDF設定で選択できる用紙サイズの一覧。
 */
export const PDF_PAPER_FORMATS = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B4', 'B5'] as const;
/**
 * PDF設定で選択できる用紙サイズのリテラル型。
 */
export type PdfPaperFormat = typeof PDF_PAPER_FORMATS[number];

/**
 * 印刷プレビュー、PDF出力、HTML出力の本文に適用する検索・置換ルール。PDFではヘッダーとフッターにも適用する。
 */
export interface TextReplacementRule {
    /**
     * 正規表現として扱う検索文字列。空欄は無効で、全一致を置換するためのフラグは内部で付与する。
     */
    pattern: string;
    /**
     * 一致箇所へ挿入する文字列。空文字なら一致箇所を削除し、$記号も展開せずそのまま挿入する。
     */
    replacement: string;
}

/**
 * PDF生成に使う用紙、向き、余白、本文スタイル、文字列置換の設定。
 */
export interface PdfOptions {
    /**
     * PDFで選択する用紙サイズ。
     */
    format: PdfPaperFormat;

    /**
     * PDFの用紙方向。
     */
    orientation: 'portrait' | 'landscape';

    /**
     * PDFの上下左右余白。
     */
    margins: {
        /**
         * PDF本文領域の上余白。
         */
        top: number;
        /**
         * PDF本文領域の右余白。
         */
        right: number;
        /**
         * PDF本文領域の下余白。
         */
        bottom: number;
        /**
         * PDF本文領域の左余白。
         */
        left: number
    };

    /**
     * PDFヘッダーに挿入する文字列。
     */
    header: string;

    /**
     * PDFフッターに挿入する文字列。
     */
    footer: string;

    /**
     * 印刷プレビュー、PDF出力、HTML出力の本文に上から順に適用する文字列置換ルール。PDFではヘッダーとフッターにも適用する。
     */
    textReplacements: TextReplacementRule[];
    /**
     * PDF本文に適用するフォント指定。
     */
    fontFamily?: string;
    /**
     * PDF本文の文字サイズ。
     */
    bodyFontSize?: number;
    /**
     * PDF見出しごとの文字サイズ設定。
     */
    headingFontSizes?: {
        /**
         * PDF見出し1の文字サイズ。
         */
        h1: number;
        /**
         * PDF見出し2の文字サイズ。
         */
        h2: number;
        /**
         * PDF見出し3の文字サイズ。
         */
        h3: number;
        /**
         * PDF見出し4の文字サイズ。
         */
        h4: number;
        /**
         * PDF見出し5の文字サイズ。
         */
        h5: number;
        /**
         * PDF見出し6の文字サイズ。
         */
        h6: number
    };
    /**
     * PDFコードブロックの文字サイズ。
     */
    codeFontSize?: number;
    /**
     * PDF本文の行間倍率。
     */
    lineHeight?: number;
    /**
     * PDF段落間の間隔。
     */
    paragraphSpacing?: number;

    /**
     * 出力を保存ダイアログなしで確定する設定。
     */
    saveWithoutDialog: boolean;
}

/**
 * 共有プロトコルへ渡す設定項目と既定値のデータ形状。
 */
export type NormalizedPdfOptions = Omit<PdfOptions, 'fontFamily' | 'bodyFontSize' | 'headingFontSizes' | 'codeFontSize' | 'lineHeight' | 'paragraphSpacing'> & {

    /**
     * PDF本文に適用するフォント指定。
     */
    fontFamily: string;

    /**
     * PDF本文の文字サイズ。
     */
    bodyFontSize: number;

    /**
     * PDF見出しごとの文字サイズ設定。
     */
    headingFontSizes: {
        /**
         * PDF見出し1の文字サイズ。
         */
        h1: number;
        /**
         * PDF見出し2の文字サイズ。
         */
        h2: number;
        /**
         * PDF見出し3の文字サイズ。
         */
        h3: number;
        /**
         * PDF見出し4の文字サイズ。
         */
        h4: number;
        /**
         * PDF見出し5の文字サイズ。
         */
        h5: number;
        /**
         * PDF見出し6の文字サイズ。
         */
        h6: number
    };

    /**
     * PDFコードブロックの文字サイズ。
     */
    codeFontSize: number;

    /**
     * PDF本文の行間倍率。
     */
    lineHeight: number;

    /**
     * PDF段落間の間隔。
     */
    paragraphSpacing: number;
};

/**
 * 共有プロトコルへ渡す設定項目と既定値のデータ形状。
 */
export interface HtmlExportOptions {

    /**
     * ローカル画像をHTMLへ埋め込む設定。
     */
    embedImages: boolean;

    /**
     * 文書から参照されたMarkdownもHTMLへ変換する設定。
     */
    convertLinkedMarkdown: boolean;

    /**
     * HTML出力へMarkdown見出しのアウトラインサイドバーを含める設定。
     */
    showOutlineSidebar?: boolean;

    /**
     * 出力を保存ダイアログなしで確定する設定。
     */
    saveWithoutDialog: boolean;
}

/**
 * 共有プロトコルへ渡す設定項目と既定値のデータ形状。
 */
export type HtmlExportSettings = Pick<
    HtmlExportOptions,
    'embedImages' | 'convertLinkedMarkdown' | 'showOutlineSidebar' | 'saveWithoutDialog'
>;

/**
 * PDF設定が未指定のときに使う用紙、余白、文字組みの既定値。
 */
export const DEFAULT_PDF_OPTIONS: NormalizedPdfOptions = {
    format: 'A4',
    orientation: 'portrait',
    margins: { top: 15, right: 15, bottom: 15, left: 15 },
    header: '',
    footer: '{page}/{pages}',
    fontFamily: DEFAULT_FONT_FAMILY_STACK,
    bodyFontSize: 11,
    headingFontSizes: { h1: 24, h2: 20, h3: 16, h4: 14, h5: 12, h6: 11 },
    codeFontSize: 9,
    lineHeight: 1.6,
    paragraphSpacing: 6,
    textReplacements: [],
    saveWithoutDialog: true
};

/**
 * PDF設定候補を既定値へ補完し、数値を出力で許可する範囲へ収める。
 * @param value - 用紙、余白、文字組版などを含むPDF設定候補。
 * @returns 用紙と向きの有効値、余白0〜50mm、本文6〜48pt、見出し6〜72pt、コード6〜36pt、行間0.8〜3、段落間隔0〜48ptへ収めた設定。形式不正の置換ルールは除き、正規表現の妥当性は別途検証する。
 */
export function normalizePdfOptions(value: unknown): NormalizedPdfOptions {
    const candidate = value && typeof value === 'object' ? value as Partial<PdfOptions> : {};
    const margins = (candidate.margins && typeof candidate.margins === 'object'
        ? candidate.margins
        : {}) as Partial<PdfOptions['margins']>;
    const headings = (candidate.headingFontSizes && typeof candidate.headingFontSizes === 'object'
        ? candidate.headingFontSizes
        : {}) as Partial<NonNullable<PdfOptions['headingFontSizes']>>;

    const numberInRange = /**
     * 数値候補を有限値へ変換し、指定範囲内に収める。
     * @param input - 数値または数値文字列として変換する設定値候補。
     * @param fallback - inputを有限数へ変換できない場合に返す既定値。
     * @param min - 正規化後に許可する最小値。
     * @param max - 正規化後に許可する最大値。
     * @returns 範囲内へ補正した値。不正値や有限値にできない候補にはfallbackを返す。
     */ (input: unknown, fallback: number, min: number, max: number): number => {
            const parsed = typeof input === 'number' ? input : Number(input);
            return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
        };

    const integerInRange = /**
     * 範囲内へ補正した数値を整数へ丸める。
     * @param input - 数値または数値文字列として変換する設定値候補。
     * @param fallback - inputを有限数へ変換できない場合に返す既定値。
     * @param min - 正規化後に許可する最小値。
     * @param max - 正規化後に許可する最大値。
     * @returns numberInRangeで補正した値を最も近い整数へ丸めた結果。
     */ (input: unknown, fallback: number, min: number, max: number): number =>
            Math.round(numberInRange(input, fallback, min, max));
    const format = typeof candidate.format === 'string' && (PDF_PAPER_FORMATS as readonly string[]).includes(candidate.format)
        ? candidate.format as PdfPaperFormat
        : 'A4';
    const orientation = candidate.orientation === 'landscape' ? 'landscape' : 'portrait';
    return {
        format,
        orientation,
        margins: {
            top: integerInRange(margins.top, DEFAULT_PDF_OPTIONS.margins.top, 0, 50),
            right: integerInRange(margins.right, DEFAULT_PDF_OPTIONS.margins.right, 0, 50),
            bottom: integerInRange(margins.bottom, DEFAULT_PDF_OPTIONS.margins.bottom, 0, 50),
            left: integerInRange(margins.left, DEFAULT_PDF_OPTIONS.margins.left, 0, 50)
        },
        header: typeof candidate.header === 'string' ? candidate.header : DEFAULT_PDF_OPTIONS.header,
        footer: typeof candidate.footer === 'string' ? candidate.footer : DEFAULT_PDF_OPTIONS.footer,
        textReplacements: Array.isArray(candidate.textReplacements)
            ? candidate.textReplacements.flatMap(
                /**
                 * 保存値の各要素から、文字列で構成された置換ルールだけを復元する。
                 * @param value VS Code設定または旧保存値に含まれる要素。
                 * @returns 型を満たす場合は正規化したルール1件、それ以外は空配列。
                */
                (value) => {
                    if (!value || typeof value !== 'object') return [];
                    const rule = value as Partial<TextReplacementRule>;
                    return typeof rule.pattern === 'string' && typeof rule.replacement === 'string'
                        ? [{ pattern: rule.pattern, replacement: rule.replacement }]
                        : [];
                }
            )
            : [],
        fontFamily: typeof candidate.fontFamily === 'string' && candidate.fontFamily.trim()
            ? candidate.fontFamily.trim()
            : DEFAULT_PDF_OPTIONS.fontFamily,
        bodyFontSize: numberInRange(candidate.bodyFontSize, DEFAULT_PDF_OPTIONS.bodyFontSize, 6, 48),
        headingFontSizes: {
            h1: numberInRange(headings.h1, DEFAULT_PDF_OPTIONS.headingFontSizes.h1, 6, 72),
            h2: numberInRange(headings.h2, DEFAULT_PDF_OPTIONS.headingFontSizes.h2, 6, 72),
            h3: numberInRange(headings.h3, DEFAULT_PDF_OPTIONS.headingFontSizes.h3, 6, 72),
            h4: numberInRange(headings.h4, DEFAULT_PDF_OPTIONS.headingFontSizes.h4, 6, 72),
            h5: numberInRange(headings.h5, DEFAULT_PDF_OPTIONS.headingFontSizes.h5, 6, 72),
            h6: numberInRange(headings.h6, DEFAULT_PDF_OPTIONS.headingFontSizes.h6, 6, 72)
        },
        codeFontSize: numberInRange(candidate.codeFontSize, DEFAULT_PDF_OPTIONS.codeFontSize, 6, 36),
        lineHeight: numberInRange(candidate.lineHeight, DEFAULT_PDF_OPTIONS.lineHeight, 0.8, 3),
        paragraphSpacing: numberInRange(candidate.paragraphSpacing, DEFAULT_PDF_OPTIONS.paragraphSpacing, 0, 48),
        saveWithoutDialog: typeof candidate.saveWithoutDialog === 'boolean'
            ? candidate.saveWithoutDialog
            : DEFAULT_PDF_OPTIONS.saveWithoutDialog
    };
}

/**
 * 置換ルールのパターンが空でなく、正規表現としてコンパイルできるか検証する。
 * @param pattern 設定された正規表現パターン。
 * @returns PDFとHTMLの出力へ適用できるパターンの場合はtrue。
 */
export function isTextReplacementPatternValid(pattern: string): boolean {
    if (!pattern) return false;
    try {
        new RegExp(pattern, 'g');
        return true;
    } catch {
        return false;
    }
}

/**
 * HTML出力の永続設定がないときに使う既定値。
 */
export const DEFAULT_HTML_EXPORT_SETTINGS: HtmlExportSettings = {
    embedImages: false,
    convertLinkedMarkdown: false,
    showOutlineSidebar: false,
    saveWithoutDialog: true
};

/**
 * HTML出力設定が未指定のときに使う既定値。
 */
export const DEFAULT_HTML_EXPORT_OPTIONS: HtmlExportOptions = {
    ...DEFAULT_HTML_EXPORT_SETTINGS
};

/**
 * HTML出力設定を許可値へ正規化し、未指定項目へ既定値を補う。
 * @param value - HTML出力用の見出し、画像、表などの設定候補。
 * @returns 不正値を除き、既定値を補ったHTML出力設定。
 */
export function normalizeHtmlExportSettings(value: unknown): HtmlExportSettings {
    const candidate = value && typeof value === 'object'
        ? value as Partial<HtmlExportSettings>
        : {};
    return {
        embedImages: typeof candidate.embedImages === 'boolean'
            ? candidate.embedImages
            : DEFAULT_HTML_EXPORT_SETTINGS.embedImages,
        convertLinkedMarkdown: typeof candidate.convertLinkedMarkdown === 'boolean'
            ? candidate.convertLinkedMarkdown
            : DEFAULT_HTML_EXPORT_SETTINGS.convertLinkedMarkdown,
        showOutlineSidebar: typeof candidate.showOutlineSidebar === 'boolean'
            ? candidate.showOutlineSidebar
            : DEFAULT_HTML_EXPORT_SETTINGS.showOutlineSidebar,
        saveWithoutDialog: typeof candidate.saveWithoutDialog === 'boolean'
            ? candidate.saveWithoutDialog
            : DEFAULT_HTML_EXPORT_SETTINGS.saveWithoutDialog
    };
}

/**
 * 現在のHTML出力設定へ指定値を重ね、未指定項目は既定値に正規化する。
 * @param current - 更新後も保持する現在のHTML出力設定。
 * @param next 現在のHTML出力設定へマージする新しい設定値。
 * @returns すべての出力項目が補完されたHTML出力設定。
 */
export function mergeHtmlExportOptions(
    current: HtmlExportOptions,
    next: HtmlExportSettings | HtmlExportOptions
): HtmlExportOptions {
    return {
        ...current,
        ...normalizeHtmlExportSettings(next)
    };
}

/**
 * 図中の文字・リンク領域と正規化座標を表すデータ。
 */
export interface MermaidInteraction {

    /**
     * 操作対象を示し、'text'なら文字列選択、'link'ならリンク領域です。
     */
    type: 'text' | 'link';

    /**
     * 図の操作対象に表示する文字列。
     */
    text: string;

    /**
     * リンク領域の遷移先。
     */
    href?: string;

    /** Peleがノート名リンクとして分類したリンクであることを示す。 */
    internal?: boolean;

    /**
     * 親領域の左端を基準にした相対位置または比較値。
     */
    left: number;

    /**
     * 親領域の上端を基準にした相対位置または比較値。
     */
    top: number;

    /**
     * 表示領域または列の幅。
     */
    width: number;

    /**
     * 表示領域または行の高さ。
     */
    height: number;
}
