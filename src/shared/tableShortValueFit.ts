/**
 * @fileoverview HTML/PDF表で折り返しを調整する短文セル属性を、内容と見出し状態から決める。
 * 純粋な文字列処理のみを行い、列数・描画幅・ブラウザー状態には依存しない。
 */

/**
 * 表セルへ付ける折り返し候補・短見出し属性の判定結果。
 */
export interface ShortValueTableCellMarker {
    /** 日本語語句または短い英字tokenとして折り返し規則を調整する場合はtrue。 */
    candidate: boolean;
    /** 空白を含む短い見出し語句を通常幅で一組にする場合はtrue。 */
    label: boolean;
}

/** 見出しセルで短いラベルとして扱うUnicode code point上限。 */
const shortHeaderCandidateCodePointLimit = 8;

/** 本文セルで短い値として扱うUnicode code point上限。 */
const shortBodyCandidateCodePointLimit = 7;

/**
 * 短文の文字種と内容だけを使って出力CSS属性を決める。
 * @param sourceText - Markdown表セルの元テキスト。
 * @param isHeader - 見出しセルならtrue。本文セルではより短い上限を使う。
 * @returns 折り返し候補属性と短い見出し語句属性。条件外の入力は両方false。
 */
export function classifyShortValueTableCell(sourceText: string, isHeader: boolean): ShortValueTableCellMarker {
    const normalizedText = sourceText.replace(/\s+/g, ' ').trim();
    const codepoints = Array.from(normalizedText);
    const candidateCodePointLimit = isHeader
        ? shortHeaderCandidateCodePointLimit
        : shortBodyCandidateCodePointLimit;
    const isCjkWord = codepoints.length > 1
        && codepoints.every((character) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ー]/u.test(character));
    const isShortToken = codepoints.length > 1 && /^\p{L}+$/u.test(normalizedText);
    const isShortCompoundHeader = isHeader
        && normalizedText.includes(' ')
        && normalizedText.split(' ').every((part) => Array.from(part).length <= 3);
    const candidate = codepoints.length <= candidateCodePointLimit
        && (isCjkWord || isShortToken || isShortCompoundHeader);
    return { candidate, label: candidate && isShortCompoundHeader };
}
