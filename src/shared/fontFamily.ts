/**
 * @fileoverview エディター、プレビュー、HTML、PDFで共有するフォント設定を正規化し、空値・不正値を既定のフォントへ戻す。
 */
/**
 * fontfamilyへ渡す設定項目と既定値のデータ形状。
 */

export interface FontFamilySettings {

    /**
     * fontfamilyで共有するフォント設定または移行状態。
     */
    editorFontFamily: string;

    /**
     * fontfamilyで共有するフォント設定または移行状態。
     */
    previewFontFamily: string;
}

/**
 * CSSへ渡す既定のフォントフォールバック列。
 */
export const DEFAULT_FONT_FAMILY_STACK = '"Noto Sans JP", "Yu Gothic UI", sans-serif';


/**
 * フォント設定が未指定のときに使う既定の入力値。
 */
export const DEFAULT_FONT_FAMILY_SETTINGS: FontFamilySettings = {
    editorFontFamily: '',
    previewFontFamily: ''
};

/**
 * フォント入力をCSSで扱える形式へ整え、空値・不正値を既定スタックへ戻す。
 * @param value - CSSへ設定する候補フォント名またはフォントスタック。
 * @returns 空白を正規化したフォントスタック。不正値なら空文字。
 */
export function normalizeFontFamily(value: unknown): string {
    if (typeof value !== 'string') return '';
    if (/[\u0000-\u001f\u007f{};<>\x60]/.test(value)) return '';
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= 512 ? normalized : '';
}

/**
 * 要求されたフォントと予備フォントをCSSのfont-family値に整える。
 * @param value - CSSフォント指定からフォールバック込みで抽出した候補名。
 * @param fallback - valueをCSS用に正規化できない場合に使う予備フォント指定。
 * @returns 不正な値を除き、必要な場合は予備フォントを加えたCSS値。
 */
export function fontFamilyForCss(value: unknown, fallback: string): string {
    const normalizedValue = normalizeFontFamily(value);
    const normalizedFallback = normalizeFontFamily(fallback);
    if (!normalizedValue) return normalizedFallback;
    if (!normalizedFallback) return normalizedValue;

    const valueKey = normalizedValue.toLocaleLowerCase();
    const fallbackKey = normalizedFallback.toLocaleLowerCase();
    if (valueKey === fallbackKey || valueKey.endsWith(`, ${fallbackKey}`)) {
        return normalizedValue;
    }
    return `${normalizedValue}, ${normalizedFallback}`;
}

/**
 * 永続化値から有効なエディター用とプレビュー用フォント設定を復元する。
 * @param value - 永続化済みフォント設定の候補オブジェクト。
 * @returns 少なくとも一方の設定キーが存在すれば正規化済み設定、設定オブジェクトでなければundefined。
 */
export function normalizeFontFamilySettings(value: unknown): FontFamilySettings | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Partial<FontFamilySettings>;
    if (!Object.prototype.hasOwnProperty.call(candidate, 'editorFontFamily') &&
        !Object.prototype.hasOwnProperty.call(candidate, 'previewFontFamily')) {
        return undefined;
    }
    return {
        editorFontFamily: normalizeFontFamily(candidate.editorFontFamily),
        previewFontFamily: normalizeFontFamily(candidate.previewFontFamily)
    };
}
