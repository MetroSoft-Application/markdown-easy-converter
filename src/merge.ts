/**
 * @fileoverview `--merge`で複数の文書を1つのPDF/DOCXへまとめるための、描画済みHTMLの結合処理。
 * 実行境界: Node（CLI）と、Node から`page.evaluate`で渡すブラウザー内の関数（`collectMergedDocumentLinks`・
 * `mergeRenderedDocuments`）。ブラウザー内の関数は文字列化して実行されるため、モジュールの変数や import を参照しない。
 *
 * 入力: 文書ごとに描画・画像埋め込み済みの本文HTMLと、文書間リンクの解決結果。
 * 出力: 文書の間に改ページを挟み、文書をまたいで一意な ID・文書内リンク・文書間リンク・目次を持つ1つの本文HTML。
 * 不変条件:
 * - 先に現れた文書の ID は変えない。1文書だけの結合と通常の変換で、見出し ID（PDF の飛び先・DOCX のしおり）が一致する。
 * - Mermaid の SVG 内の ID は書き換えない（SVG 内の CSS と `url(#...)` が参照するため）。描画時に文書ごとの名前空間で一意にする。
 * - 結合後のPDF/DOCX生成は先頭の文書のパスで画像を解決するため、ローカル画像は文書ごとに埋め込み済みであること。
 *   埋め込めなかった画像を別の文書の場所から解決し直さないよう、`data-original-src`を`#`にして再解決を止める。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLocalFileUri } from './html';
import { decodeLocalResourceSource } from './shared/resourceCheck';

/** 文書間リンクの飛び先。`collectMergedDocumentLinks`が返すキーごとに Node 側で解決する。 */
export interface MergedLinkTarget {
    /** 結合する文書の並びでの位置（0始まり）。 */
    document: number;
    /** `#`より後ろの部分をデコードした値。空文字列なら飛び先の文書の最初の見出しへリンクする。 */
    fragment: string;
}

/** 結合する1文書分の入力。 */
export interface MergedDocumentInput {
    /** 描画・出力用整形・ローカル画像の埋め込みを済ませた本文HTML。 */
    html: string;
    /**
     * `mergedLinkKey`で作ったキーから、結合する文書への飛び先への対応。
     * 結合しない文書や画像などへのリンクは含めず、元のリンクのまま残す。
     */
    links: Record<string, MergedLinkTarget>;
}

/** `mergeRenderedDocuments`への要求。`page.evaluate`で渡すため、JSONで表せる値だけを持つ。 */
export interface MergeRenderedDocumentsRequest {
    /** 結合する順に並べた文書。 */
    documents: MergedDocumentInput[];
    /** 文書の間に挟む改ページ要素の`aria-label`。描画器の`<!-- pagebreak -->`と同じ文言にする。 */
    pageBreakLabel: string;
}

/** 描画器がローカルの文書リンクに付ける、本来のリンク先を持つ属性の値と、ワークスペース基準かどうか。 */
export interface DocumentLinkReference {
    /** `data-mve-link`の値（描画器が書いた原文のリンク先）。 */
    href: string;
    /** `data-mve-workspace-rooted="true"`のとき true。`/`で始まるリンクをワークスペースルートから解決する。 */
    workspaceRooted: boolean;
}

/**
 * 文書間リンクの対応表のキーを作る。ブラウザー内の関数と同じ規則で作る必要がある。
 * ワークスペース基準かどうかで解決先が変わるため、キーに含める。
 * @param reference - リンク先とワークスペース基準の指定。
 * @returns 対応表のキー。
 */
export function mergedLinkKey(reference: DocumentLinkReference): string {
    return (reference.workspaceRooted ? 'r:' : 'p:') + reference.href;
}

/**
 * 描画済みHTMLから、ローカルの文書リンク（描画器が`href="#"`と`data-mve-link`へ置き換えたもの）を集める。
 * ブラウザー内で実行する。`template`へ読み込むのは、画像の読み込み（リモート画像への要求）を始めないため。
 * @param markup - 描画済みの本文HTML。
 * @returns 重複を除いたリンクの一覧。
 */
export function collectMergedDocumentLinks(markup: string): DocumentLinkReference[] {
    const template = document.createElement('template');
    template.innerHTML = markup;
    const seen = new Set<string>();
    const references: DocumentLinkReference[] = [];
    template.content.querySelectorAll('a[data-mve-link]').forEach((anchor) => {
        const href = anchor.getAttribute('data-mve-link') ?? '';
        const workspaceRooted = anchor.getAttribute('data-mve-workspace-rooted') === 'true';
        const key = (workspaceRooted ? 'r:' : 'p:') + href;
        if (!href || seen.has(key)) return;
        seen.add(key);
        references.push({ href, workspaceRooted });
    });
    return references;
}

/**
 * パスを比較用に正規化する。Windowsは大文字と小文字を区別しない（既存の出力先の比較規則と同じ）。
 * @param value - 絶対パス。
 * @returns 比較用のキー。
 */
function comparablePath(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * リンク先（`data-mve-link`の値）をファイルの絶対パスへ解決する。`#`以降と`?`以降は無視する。
 * `%`エスケープは1回だけ戻す。`%23`（`#`）や`%3F`（`?`）を含むファイル名を、戻した後に断片や問い合わせと誤認しないため。
 * ワークスペース基準のリンク（`/`で始まり、描画器が`data-mve-workspace-rooted`を付けたもの）は HTML 出力と同じ関数で解決する。
 * @param sourcePath - リンクを含む文書の絶対パス。
 * @param reference - リンク先とワークスペース基準の指定。
 * @param workspaceRoot - ワークスペース基準のリンクの基準ディレクトリ。
 * @returns 絶対パス。空のリンク、リモートのURI、`mailto:`など、ファイルを指さないリンクではundefined。
 */
function resolveDocumentLinkPath(
    sourcePath: string, reference: DocumentLinkReference, workspaceRoot: string
): string | undefined {
    if (reference.workspaceRooted) return resolveLocalFileUri(sourcePath, reference.href, true, workspaceRoot);
    // file: の URL は、デコード前に`#`と`?`以降を切り落とし、デコードは fileURLToPath の1回に任せる。
    // 先にデコードすると、ファイル名の`%23`が`#`に戻り、URL として解釈するときに断片と誤認されるため。
    if (/^\s*file:/i.test(reference.href)) {
        try {
            return path.normalize(fileURLToPath(reference.href.trim().split('#', 1)[0].split('?', 1)[0]));
        } catch {
            return undefined;
        }
    }
    const clean = decodeLocalResourceSource(reference.href);
    if (!clean) return undefined;
    // ドライブ文字（C:）は1文字のスキームに見えるため、2文字以上のスキーム（https:、mailto:など）だけを除く。
    if (/^[a-z][a-z0-9+.-]+:/i.test(clean) || clean.startsWith('//')) return undefined;
    const normalized = clean.replace(/\\/g, path.sep);
    if (/^[A-Za-z]:[\\/]/.test(normalized) || path.isAbsolute(normalized)) return path.normalize(normalized);
    return path.resolve(path.dirname(sourcePath), normalized);
}

/**
 * 1文書のローカルリンクのうち、結合する文書を指すものだけを飛び先へ解決する。
 * 文書の場所からの相対パス、絶対パス、`file:` URI、ワークスペース基準のリンクを解決する（`resolveDocumentLinkPath`）。
 * @param references - `collectMergedDocumentLinks`が返したリンク。
 * @param sourcePath - リンクを含む文書の絶対パス。
 * @param inputs - 結合する文書の絶対パス（結合する順）。
 * @param workspaceRoot - ワークスペース基準のリンクの基準ディレクトリ。
 * @returns `mergedLinkKey`のキーから飛び先への対応。結合しない文書へのリンクは含めない。
 */
export function resolveMergedLinks(
    references: readonly DocumentLinkReference[], sourcePath: string, inputs: readonly string[], workspaceRoot: string
): Record<string, MergedLinkTarget> {
    const indexes = new Map(inputs.map((input, index) => [comparablePath(input), index]));
    const links: Record<string, MergedLinkTarget> = {};
    for (const reference of references) {
        const resolved = resolveDocumentLinkPath(sourcePath, reference, workspaceRoot);
        if (!resolved) continue;
        const document = indexes.get(comparablePath(resolved));
        if (document === undefined) continue;
        const hash = reference.href.indexOf('#');
        const rawFragment = hash < 0 ? '' : reference.href.slice(hash + 1);
        let fragment = rawFragment;
        try {
            fragment = decodeURIComponent(rawFragment);
        } catch {
            // 不正な%エスケープは原文のまま ID と照合する。
        }
        links[mergedLinkKey(reference)] = { document, fragment };
    }
    return links;
}

/**
 * 文書ごとの本文HTMLを1つにまとめる。ブラウザー内で実行する（`page.evaluate`へ関数として渡す）。
 * 処理:
 * 1. 先に現れた文書と重なる ID（同じ見出し名、脚注`fn-1`など）を`<id>-<n>`へ改名し、その文書内の
 *    `href="#..."`・`aria-labelledby`・`aria-describedby`・`for`・`headers`を書き換える。SVG内の ID は対象外。
 * 2. 結合する文書へのリンクを、改名後の見出し ID への文書内リンクへ書き換える。断片のないリンクは飛び先の文書の
 *    最初の見出しへ向ける。見出しのない文書へのリンクと、飛び先の文書にない断片へのリンクは元のまま残す
 *    （通常の PDF/DOCX 出力と同じ）。
 * 3. `[toc]`の目次を、全文書の見出し（Markdown・Textile の見出し記法から作ったもの。引用の中の見出しは除く）の
 *    一覧に作り直す。
 * 4. ローカル画像の再解決を止める（埋め込み済みは`data-original-src`を外し、失敗した画像は`#`にする）。
 * 5. 文書の間に描画器と同じ改ページ要素を挟む。中身のない文書（空白以外の文字も、画像・罫線・表などの見える要素もない）は
 *    出力に含めない。
 * @param request - 結合する文書と改ページの文言。
 * @returns 結合した本文HTML。
 */
export function mergeRenderedDocuments(request: MergeRenderedDocumentsRequest): string {
    const roots = request.documents.map((item) => {
        const template = document.createElement('template');
        template.innerHTML = item.html;
        return template;
    });
    /** SVG（Mermaid の図など）の中の要素かを判定する。SVG 内の ID は図の中から参照されるため改名しない。 */
    const insideSvg = (element: Element): boolean => element.closest('svg') !== null;
    /** 改名の対象になる、ID を持つ要素の一覧。 */
    const elementsWithId = (template: HTMLTemplateElement): Element[] =>
        [...template.content.querySelectorAll('[id]')].filter((element) => !insideSvg(element));
    /** 断片を ID と照合できる形へ戻す。不正な%エスケープは原文のまま使う。 */
    const decodeFragment = (value: string): string => {
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    };

    // 1. ID の改名。先の文書が使った ID と重なるものだけを、その文書内でも未使用の名前へ変える。
    const used = new Set<string>();
    /** 文書ごとの改名前の ID。文書間リンクの断片が、飛び先の文書に本当にある ID かを確かめるために使う。 */
    const originalIds: Set<string>[] = [];
    const renames = roots.map((template) => {
        const elements = elementsWithId(template);
        const own = new Set(elements.map((element) => element.getAttribute('id') ?? ''));
        originalIds.push(own);
        const map = new Map<string, string>();
        const assigned = new Set<string>();
        for (const element of elements) {
            const id = element.getAttribute('id') ?? '';
            if (!id || !used.has(id)) continue;
            // 同じ文書内の重複 ID は、単独の変換と同じく重複のまま残す（同じ新しい名前へそろえる）。
            const known = map.get(id);
            if (known !== undefined) {
                element.setAttribute('id', known);
                continue;
            }
            let suffix = 1;
            let candidate = `${id}-${suffix}`;
            while (used.has(candidate) || own.has(candidate) || assigned.has(candidate)) {
                suffix += 1;
                candidate = `${id}-${suffix}`;
            }
            map.set(id, candidate);
            assigned.add(candidate);
            element.setAttribute('id', candidate);
        }
        for (const element of elements) used.add(element.getAttribute('id') ?? '');
        return map;
    });

    // 描画器が Markdown・Textile の見出し記法から作った見出し（data-mve-heading）だけを対象にする。
    // 通常の`[toc]`と同じく、生HTMLの見出しは目次と「文書の最初の見出し」に含めない。
    const headingSelector = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((tag) => `${tag}[id][data-mve-heading]`).join(', ');
    /** 目次・SVG・脚注・引用の中を除いた、本文の見出し（通常の`[toc]`も引用の中の見出しを含めない）。 */
    const headingsOf = (template: HTMLTemplateElement): HTMLElement[] =>
        [...template.content.querySelectorAll<HTMLElement>(headingSelector)].filter((heading) =>
            !insideSvg(heading) && !heading.closest('.table-of-contents, .footnotes, blockquote'));
    const firstHeadingIds = roots.map((template) => headingsOf(template)[0]?.getAttribute('id') ?? undefined);

    roots.forEach((template, index) => {
        const map = renames[index];
        // 文書内リンク（目次・脚注・見出しへのリンク）を、この文書で改名した ID へ向け直す。
        if (map.size) {
            template.content.querySelectorAll('a[href^="#"]').forEach((anchor) => {
                if (anchor.hasAttribute('data-mve-link')) return;
                const raw = (anchor.getAttribute('href') ?? '').slice(1);
                const renamed = map.get(raw) ?? map.get(decodeFragment(raw));
                if (renamed !== undefined) anchor.setAttribute('href', `#${renamed}`);
            });
            for (const attribute of ['aria-labelledby', 'aria-describedby', 'for', 'headers']) {
                template.content.querySelectorAll(`[${attribute}]`).forEach((element) => {
                    if (insideSvg(element)) return;
                    const value = element.getAttribute(attribute) ?? '';
                    const next = value.split(/\s+/).map((token) => map.get(token) ?? token).join(' ');
                    if (next !== value) element.setAttribute(attribute, next);
                });
            }
        }
        // 2. 結合する文書へのリンクを文書内リンクへ書き換える。
        template.content.querySelectorAll('a[data-mve-link]').forEach((anchor) => {
            const workspaceRooted = anchor.getAttribute('data-mve-workspace-rooted') === 'true';
            const key = (workspaceRooted ? 'r:' : 'p:') + (anchor.getAttribute('data-mve-link') ?? '');
            const target = Object.prototype.hasOwnProperty.call(request.documents[index].links, key)
                ? request.documents[index].links[key] : undefined;
            if (!target) return;
            // 断片が飛び先の文書にない ID なら書き換えない。書き換えると、同じ ID を持つ別の文書の見出しへ飛んでしまうため。
            if (target.fragment && !originalIds[target.document]?.has(target.fragment)) return;
            const id = target.fragment
                ? renames[target.document]?.get(target.fragment) ?? target.fragment
                : firstHeadingIds[target.document];
            if (!id) return;
            anchor.setAttribute('href', `#${id}`);
            anchor.removeAttribute('data-mve-link');
            anchor.removeAttribute('data-mve-workspace-rooted');
        });
        // 4. ローカル画像の再解決を止める。判定は PDF の埋め込み処理が読み飛ばす参照の規則と同じにする。
        template.content.querySelectorAll('img').forEach((image) => {
            const source = image.getAttribute('src') ?? '';
            const original = image.getAttribute('data-original-src') ?? source;
            if (/^data:/i.test(source)) {
                image.removeAttribute('data-original-src');
                return;
            }
            if (!original || /^(?:https?:|data:|blob:|#|\/\/)/i.test(original)) return;
            // 読み込めなかった画像は、単独の変換と同じく元の参照を src に残して壊れた画像として扱う。
            image.setAttribute('data-original-src', '#');
        });
    });

    // 3. 目次を全文書の見出しで作り直す。文字列は表示上の文字にし、KaTeX の MathML 側（同じ数式の重複）と
    //    脚注参照の番号（見出しの語と連結して「Note1」になる）を除く。
    const tocItems = roots.flatMap((template) => headingsOf(template).map((heading) => {
        const clone = heading.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.katex-mathml, .footnote-ref').forEach((node) => node.remove());
        return {
            level: Number(heading.tagName.slice(1)),
            id: heading.getAttribute('id') ?? '',
            text: (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
        };
    })).filter((item) => item.id && item.text);
    if (tocItems.length) {
        for (const template of roots) {
            template.content.querySelectorAll('nav.table-of-contents').forEach((nav) => {
                const list = nav.querySelector('ul');
                if (!list) return;
                list.replaceChildren(...tocItems.map((item) => {
                    const entry = document.createElement('li');
                    entry.className = `toc-level-${item.level}`;
                    const link = document.createElement('a');
                    link.setAttribute('href', `#${item.id}`);
                    link.textContent = item.text;
                    entry.append(link);
                    return entry;
                }));
            });
        }
    }

    // 5. 文書の間に改ページを挟む。描画器の`<!-- pagebreak -->`と同じ要素にし、PDF と DOCX の既存の改ページ処理に任せる。
    //    中身のない文書（空のファイル、front matter だけの文書）は改ページを挟まず、白紙のページを作らない。
    //    挟むと、空の文書が1件なら白紙が1ページ入り、連続すると改ページがまとまって白紙の数が文書の数と合わなくなるため。
    const separator = document.createElement('div');
    separator.className = 'page-break';
    separator.setAttribute('aria-label', request.pageBreakLabel);
    // 描画器は HTML コメントだけの文書にも空の囲み（div）を出すため、要素の有無ではなく、文字か見える要素の有無で判定する。
    const visibleElements = 'img, svg, hr, table, video, audio, iframe, object, embed, canvas, picture, input, math, .page-break';
    return roots
        .filter((template) => (template.content.textContent ?? '').trim() !== ''
            || template.content.querySelector(visibleElements) !== null)
        .map((template) => template.innerHTML)
        .join(separator.outerHTML);
}
