/**
 * @fileoverview Peleの内部例外からMermaidソースや依存関係の詳細を取り除く。
 */

/**
 * @param _error - 詳細を応答へ含めず破棄する描画エラー。
 * @returns ソース本文や依存関係の例外情報を含まないメッセージ。
 */
export function sanitizePeleRenderError(_error: unknown): string {
    return 'Mermaid diagram could not be rendered.';
}
