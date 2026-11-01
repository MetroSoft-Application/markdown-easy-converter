/**
 * @fileoverview Webviewが要求したローカルリソースをワークスペースの許可範囲と照合する。
 */
/**
 * ローカルリソース参照からフラグメントとクエリを除き、URIエスケープを復号する。
 * @param source - デコードするローカルリソースのURIまたはパス参照。
 * @returns 復号したローカルリソース参照。
 */
export function decodeLocalResourceSource(source: string): string {
    const withoutAnchor = source.split('#', 1)[0].trim();
    const queryStart = withoutAnchor.indexOf('?');
    const withoutQuery = queryStart >= 0 ? withoutAnchor.slice(0, queryStart) : withoutAnchor;
    try {
        return decodeURIComponent(withoutQuery);
    } catch {
        return withoutQuery;
    }
}

/**
 * resourcecheckの条件を判定する。
 * @param error - 処理に失敗した理由または例外。
 * @returns 条件が成立したかを示す真偽値。
 */
export function isMissingResourceError(error: unknown): boolean {
    const errorCode = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : '';
    return errorCode === 'FileNotFound'
        || errorCode === 'ENOENT'
        || (error instanceof Error && /not found|enoent/i.test(error.message));
}
