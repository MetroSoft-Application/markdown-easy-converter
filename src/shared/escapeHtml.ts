/**
 * @fileoverview HTMLへ埋め込む文字列をエスケープし、属性値と本文での意図しない解釈を防ぐ。
 */
/**
 * HTML予約文字を文字参照へ置換する。
 * @param value - HTML本文または属性値へ挿入する前にエスケープする文字列。
 * @returns HTML予約文字を文字参照へ置換した文字列。
 */
export function escapeHtml(value: string): string {
    return value.replace(
        /[&<>"']/g,

        /**
         * HTML予約文字を対応する文字参照へ置き換える。
         * @param character - HTMLエスケープ表でエンティティへ置換する1文字。
         * @returns 1文字をエスケープしたHTML文字列。
         */
        (character) =>
            ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
            })[character]!,
    );
}
