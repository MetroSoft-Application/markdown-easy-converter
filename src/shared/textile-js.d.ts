/**
 * @fileoverview Textile.jsのCommonJS APIをHostとWebview双方のTypeScriptコンパイルへ公開する。
 */
declare module 'textile-js' {
    /** Textile.jsが単一改行の扱いなどを制御するときに受け付けるオプション。 */
    interface TextileOptions {
        /** trueの場合、段落内の単一改行をHTMLのbrへ変換する。 */
        breaks?: boolean;
    }

    /**
     * Textile本文をHTMLへ変換する関数。
     * @param source - Textile記法を含む原文。
     * @param options - Textile変換時の改行処理など。
     * @returns サニタイズ前のHTML。
     */
    function textile(source: string, options?: TextileOptions): string;

    export default textile;
}
