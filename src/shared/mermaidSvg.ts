/**
 * @fileoverview Mermaidが生成したSVGを検証し、画像領域・リンク領域・アクセシビリティ情報を抽出する。
 */
/**
 * Mermaid SVG内のIDと参照先へ固有の接頭辞を付け、同一文書内のID重複を防ぐ。
 * @param svg - Mermaidが生成したSVG本文。
 * @param namespace - 生成するSVG IDへ付ける固有の接頭辞。
 * @returns ID参照とARIA参照も接頭辞に合わせて更新したSVG。
 */
export function namespaceMermaidSvg(svg: string, namespace: string): string {
    const safeNamespace = namespace.replace(/[^a-zA-Z0-9_-]/g, '-');
    const ids = [...svg.matchAll(/\bid=(['"])([^'"]+)\1/g)].map(
        /**
         * 各matchを変換して一覧化する。
         * @param match - SVGのid属性に一致した正規表現結果。match[2]がid値。

         */
        (match) => match[2]);
    let result = svg;
    for (const id of [...new Set(ids)].sort(
        /**
         * 2つの値を比較して並び順を決める。
         * @param left - 比較対象の左側の値。
         * @param right - 比較対象の右側の値。
         * @returns 2つの要素の順序を示す数値。
         */
        (left, right) => right.length - left.length)) {
        const escaped = escapeRegExp(id);
        const replacement = `${safeNamespace}-${id}`;
        result = result.replace(new RegExp(`(\\bid=(['"]))${escaped}\\2`, 'g'), `$1${replacement}$2`);
        result = result.replace(new RegExp(`#${escaped}(?![\\w:.-])`, 'g'), `#${replacement}`);
        result = result.replace(
            new RegExp(`((?:aria-labelledby|aria-describedby)=(['"])[^'"]*)\\b${escaped}\\b`, 'g'),
            `$1${replacement}`
        );
    }
    return result;
}

/**
 * 正規表現のメタ文字をリテラルとして扱えるようにエスケープする。
 * @param value - 正規表現へ埋め込むためにエスケープする文字列。

 */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
