/**
 * @fileoverview ローカルリソースをWebviewから参照できるURIへ変換し、ワークスペース外の参照を拒否する。
 */
/**
 * Webviewからローカルリソースを参照するためのURIホスト。
 */
const WEBVIEW_RESOURCE_HOST = 'file+.vscode-resource.vscode-cdn.net';

/**
 * resourcelinkで扱う値の種類と境界を表す型。
 */
export type ResourceLinkTarget =
    | {
        /**
         * メッセージ、項目、または処理の種類を識別する値。
         */
        kind: 'localWebview';
        /**
         * 読み書きするファイルまたはリソースの場所。
         */
        path: string
    }
    | {
        /**
         * メッセージ、項目、または処理の種類を識別する値。
         */
        kind: 'invalidLocalWebview'
    }
    | {
        /**
         * メッセージ、項目、または処理の種類を識別する値。
         */
        kind: 'external';
        /**
         * リンク操作領域の遷移先URI。
         */
        href: string
    }
    | {
        /**
         * メッセージ、項目、または処理の種類を識別する値。
         */
        kind: 'absoluteFile';
        /**
         * リンク操作領域の遷移先URI。
         */
        href: string
    }
    | {
        /**
         * メッセージ、項目、または処理の種類を識別する値。
         */
        kind: 'relative';
        /**
         * リンク操作領域の遷移先URI。
         */
        href: string
    };

/**
 * リンクをローカルファイル、Webview内資源、外部URL、未対応形式へ分類する。
 * @param href - Markdown内のリンク先文字列。相対参照、ファイルパス、file URI、Webview URL、外部URLを受け取る。
 * @returns リンク種別と、開く先を決める情報。
 */
export function classifyResourceLink(href: string): ResourceLinkTarget {
    const localWebviewPath = resolveWebviewResourcePath(href);
    if (localWebviewPath) return { kind: 'localWebview', path: localWebviewPath };
    if (isWebviewResourceUrl(href)) return { kind: 'invalidLocalWebview' };
    if (/^(?:https?|mailto|tel):/i.test(href)) return { kind: 'external', href };
    if (/^file:/i.test(href) || /^[A-Za-z]:[\\/]/.test(href) || /^\\\\/.test(href)) {
        return { kind: 'absoluteFile', href };
    }
    return { kind: 'relative', href };
}

/**
 * ワークスペースルート相対パスを安全な各パス要素へ分解する。ルート外へ出る `..` は拒否する。
 * @param source 先頭が単一スラッシュのワークスペース相対パス。
 * @returns ルートからの各パス要素。形式が不正、またはルートを越える場合はundefined。
 */
export function workspaceRootPathSegments(source: string): string[] | undefined {
    if (!source.startsWith('/') || source.startsWith('//') || /^\/[A-Za-z]:[\\/]/.test(source)) {
        return undefined;
    }

    const segments: string[] = [];
    for (const segment of source.slice(1).replace(/\\/g, '/').split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (!segments.length) return undefined;
            segments.pop();
            continue;
        }
        segments.push(segment);
    }

    return segments.length ? segments : undefined;
}

/**
 * URIスキームや絶対パスを持たない文書相対参照か判定する。
 * @param source - 復号済みのローカルリソース参照。
 * @returns 文書の親フォルダーから解決できる参照ならtrue。
 */
export function isDocumentRelativeResourcePath(source: string): boolean {
    return Boolean(source) && !/^(?:[A-Za-z][A-Za-z0-9+.-]*:|[\\/])/u.test(source);
}

/**
 * resourcelinkの条件を判定する。
 * @param href - 検査するリンク先文字列。
 * @returns 条件が成立したかを示す真偽値。
 */
function isWebviewResourceUrl(href: string): boolean {
    try {
        const url = new URL(href);
        return url.protocol === 'https:' && url.hostname === WEBVIEW_RESOURCE_HOST;
    } catch {
        return false;
    }
}

/**
 * URI参照をWebview内で解決し、拡張機能のルート相対パスを返す。
 * @param href - WebviewリソースURLかを調べる文字列。
 * @returns Webview内で参照できる相対パス。無効なURLや対象外リソースはundefined。
 */
export function resolveWebviewResourcePath(href: string): string | undefined {
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        return undefined;
    }

    if (url.protocol !== 'https:' || url.hostname !== WEBVIEW_RESOURCE_HOST) {
        return undefined;
    }

    let pathname: string;
    try {
        pathname = decodeURIComponent(url.pathname);
    } catch {
        return undefined;
    }

    if (!pathname) return undefined;

    // Windows のドライブレターを URL の先頭スラッシュから戻す。
    return pathname.replace(/^\/([A-Za-z]:[\\/])/, '$1');
}
