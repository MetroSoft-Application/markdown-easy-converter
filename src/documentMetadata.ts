/**
 * @fileoverview CLI（Node.js側）で、入力文書の描画形式、YAML front matter、出力タイトルを決定する。
 * 入力はメモリ上の文書文字列とパスだけで、ファイルやブラウザーには触れない純粋な処理に留める。
 * 不変条件: YAMLのオブジェクトと確定できない先頭ブロックは本文として残し、利用者の文章を消さない。
 */
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getFrontMatterRange } from './shared/marpFrontMatter';

/**
 * ヘッダー・フッターの展開値に含まれる`{`を表す私用領域の文字。
 * PDFテンプレートの生成時に`{`へ戻す。文書の本文には現れない前提で、ヘッダー・フッターの中だけで使う。
 */
export const LITERAL_BRACE = '\uE000';

/** 文書本文の解釈に使う描画形式。 */
export type DocumentRenderFormat = 'markdown' | 'mixed' | 'textile';

/**
 * YAML front matterの扱い。
 * `auto`（既定）は本文から除く。`render`は0.1.2以前と同じく本文として描画し、Marp設定だけを除く。
 */
export type FrontMatterMode = 'auto' | 'render';

/** front matterの解析結果。 */
export interface DocumentMetadata {
    /** 描画対象の本文。front matterと確定できない場合や`render`指定では入力のまま。 */
    body: string;
    /** front matterの`title`を空白正規化した値。未指定または空の場合はundefined。 */
    frontMatterTitle?: string;
}

/**
 * 設定の指定と拡張子から、文書の描画形式を決める。
 * @param sourcePath - 拡張子を判定する文書パス。
 * @param override - 設定ファイルで明示された描画形式。指定があれば拡張子より優先する。
 * @returns `.textile`はtextile、それ以外はMarkdown優先のmixed。
 */
export function resolveRenderFormat(sourcePath: string, override?: DocumentRenderFormat): DocumentRenderFormat {
    return override ?? (/\.textile$/i.test(sourcePath) ? 'textile' : 'mixed');
}

/**
 * 文書先頭のYAML front matterを本文から分離し、タイトルを取り出す。
 * 先頭と末尾の`---`は水平線としても有効な構文のため、YAMLのオブジェクトと解釈できる場合だけ除去する。
 * Textileにはfront matterの慣習がないため、`.textile`では既存のMarp設定（`marp: true`）だけを扱う。
 * @param markdown - BOMを除去済みの文書本文。
 * @param renderFormat - 文書の描画形式。
 * @param mode - front matterの扱い。省略時は`auto`。
 * @returns 本文とタイトル。YAMLの構文エラーやオブジェクト以外の値では入力を本文としてそのまま返す。
 */
export function extractDocumentMetadata(
    markdown: string, renderFormat: DocumentRenderFormat, mode: FrontMatterMode = 'auto'
): DocumentMetadata {
    const range = getFrontMatterRange(markdown);
    if (!range) return { body: markdown };
    let parsed: unknown;
    try {
        // 'error'は構文エラーの例外を維持したまま、未知のタグなどの警告だけをstderrへ出さない。
        parsed = parseYaml(range.yaml, { logLevel: 'error' });
    } catch {
        return { body: markdown };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { body: markdown };
    const fields = parsed as Record<string, unknown>;
    const marp = fields.marp === true;
    if (renderFormat === 'textile' && !marp) return { body: markdown };
    return {
        body: marp || mode === 'auto' ? range.source.slice(range.bodyStart) : markdown,
        frontMatterTitle: normalizeTitle(fields.title)
    };
}

/**
 * HTMLの`<title>`とPDFの文書タイトルに使う文字列を決める。
 * 明示された指定（`--title`またはfront matter）、本文の最初のH1、拡張子を除いたファイル名の順に採用する。
 * @param explicitTitle - 明示されたタイトル。
 * @param firstHeading - 描画済み本文の最初のH1の文字列。
 * @param sourcePath - 最後の手段として使う文書パス。
 * @returns 空でないタイトル。出力置換を適用する前の値であり、エスケープもしていない。
 */
export function chooseDocumentTitle(
    explicitTitle: string | undefined, firstHeading: string | undefined, sourcePath: string
): string {
    return explicitTitle
        ?? normalizeTitle(firstHeading)
        ?? path.basename(sourcePath, path.extname(sourcePath));
}

/**
 * タイトル候補の連続空白を1つへまとめる。YAMLの複数行文字列や見出し内の改行を1行にするため。
 * @param value - 文字列または数値（`title: 2024`）のタイトル候補。それ以外の型は採用しない。
 * @returns 正規化したタイトル。空または採用しない型の場合はundefined。
 */
export function normalizeTitle(value: unknown): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    return String(value).replace(/\s+/g, ' ').trim() || undefined;
}

/**
 * PDFのヘッダー・フッターの`{title}`、`{file}`、`{date}`を展開する。
 * `{page}`と`{pages}`はChromiumが印刷時に埋めるため、ここでは展開しない。
 * 出力置換より前に呼び出し、展開した文字列にも置換が適用されるようにする。
 * タイトルに含まれる`{page}`がページ番号へ置き換わらないよう、値の`{`は`LITERAL_BRACE`へ置き換えて保護する。
 * @param value - ヘッダーまたはフッターの文字列。
 * @param fields - 展開する値。`$`などを特殊文字として解釈しないよう関数で置換する。
 * @returns 展開後の文字列。
 */
export function expandHeaderFooterPlaceholders(
    value: string, fields: { title: string; file: string; date: string }
): string {
    return value.replace(/\{(title|file|date)\}/g,
        (_, name: keyof typeof fields) => fields[name].replace(/\{/g, LITERAL_BRACE));
}

/**
 * ヘッダー・フッターに使う日付を、実行環境の地域時刻で`YYYY-MM-DD`にする。
 * @param now - 対象の時刻。
 * @returns ゼロ埋めした日付文字列。
 */
export function formatLocalDate(now: Date): string {
    /** 月と日を2桁へゼロ埋めする。 */
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
