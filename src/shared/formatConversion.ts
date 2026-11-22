/**
 * @fileoverview 文書全体をTextileからMarkdownへ、またはMarkdownからTextileへ書き換える共有変換器。
 * 実行境界: shared（Webviewのリボン操作と、CLIの`--format md|textile`（Node.js側）から呼び出す。DOMやファイルには依存しない）。
 * CLIの複製は拡張機能 markdown-easy-visual-editor の同名ファイルと同じ規則を保つ。規則を直すときは両方を揃える。
 * 入力は未変更の原文、出力は同じ内容を変換先の記法で表した原文である。
 * 守る不変条件:
 * - 行ごとの改行コードと末尾改行の有無を変えない。新しく挿入する行だけ文書の主要な改行コードを使う。
 * - コードブロック・インラインコード・生HTML・notextile範囲の中身は書き換えない。
 * - HTMLへは変換しない。原文にないHTMLのタグを書き出さず、変換先に描画の記法がない要素は、意味を表す変換先の記法
 *   （図・数式は言語名付きのコードブロック、タスクリストの印・目次の指定は原文の文字、front matterはコメント）か、
 *   Markdown文書のプレビューも描画するTextileの記法のまま書く。原文の生HTMLは原文のHTMLのまま残す。
 * - 変換先に同じ意味の記法がない構造（入れ子の引用、リスト項目の中のブロックなど）は黙って削除せず、最も近い書き方で
 *   変換したうえで「プレビューが変わる行」として報告する。呼び出し側（変換タブ）は変換を止めずに適用し、行を通知する。
 * - 逆変換モード（{@link DocumentConversionOptions.restore}）は、順変換の規則の逆をたどって元の書き方へ戻す。原文の記録は使わない。
 * - この変換器はtextile-jsとMarkedの解釈を規則として再現したもので、描画器との細かな違いを取りこぼし得る。
 *   そのため呼び出し側は変換前後を実際の描画器で描画して比べ（webview/markdown/previewEquivalence）、変換の誤りを見つける。
 * - 変換後の文書をTextile（またはMarkdown）として描画した結果が、変換前の描画と同じ構造になることを優先する。
 *   そのためTextile→Markdownでは段落内の単一改行を強制改行（行末のバックスラッシュ）に写し、
 *   Markdown→Textileでは段落内のソフト改行を空白で連結する。
 */

/**
 * 文書全体の変換先となる記法。
 * - `markdown`: Markdown（GFMと本拡張の拡張記法）。
 * - `textile`: Textile（textile-jsが解釈する記法）。
 */
export type DocumentSyntax = 'markdown' | 'textile';

/**
 * 文書変換の指定。
 */
export interface DocumentConversionOptions {
    /**
     * 逆変換モード。逆向きの順変換が平文に付けた退避（Markdownのバックスラッシュ、Textileの文字参照）を外し、
     * Textileの文字置換で生まれた記号を置換前の書き方へ戻す。順変換の規則を逆にたどるだけで、原文の記録は使わない。
     * 素の文字に戻すと記法として描画される箇所はプレビューが変わり得るため、呼び出し側は描画を比べ、
     * 一致しなければ通常の変換を使う。既定はfalse。
     */
    restore?: boolean;
    /**
     * 文書全体の脚注ID（Markdownは`[^id]:`の定義の順、Textileは`fnN.`の番号）。文書の一部だけを変換するときに渡すと、
     * 参照と定義の対応（Textileの番号）を文書全体と揃える。省略時は変換する文字列の中の定義だけを使う。
     */
    footnotes?: readonly string[];
    /**
     * Markdown文書全体の参照リンクの定義（{@link collectLinkReferences}）。文書の一部だけを変換するときに渡すと、
     * 定義が別の部分にある参照リンク（`[表示][名前]`）もTextileのリンクへ変換できる。省略時は変換する文字列の中の定義だけを使う。
     * Textile→Markdownでは使わない。
     */
    references?: readonly LinkReference[];
    /**
     * Markdown→Textileで、原文をMarkdownだけの文書として扱う指定。既定はfalse。
     * Markdown文書のプレビュー（混在形式）は、Textileの書き方の候補を含む文書だけでTextileの記法も描画し、含まない文書は
     * Markdownだけとして描画する（webview/markdown/markdownRendererCoreのhasMixedTextileSyntaxCandidate）。
     * trueのときは、Textileに見える書き方（署名付きの段落・表の行・Textileのリンクなど）をそのまま残さず、Markdownの文字として変換する。
     */
    markdownOnly?: boolean;
}

/**
 * Markdownの参照リンクの定義1件（`[名前]: URL "title"`）。
 * 本拡張のTextileは`[名前]URL`を表示されるリンクとして描画するため、Textileのリンク別名は使えない。参照リンクは、
 * 同じ意味のTextileのリンク（`"表示(title)":URL`）へ写し、定義の行は書かない（逆変換ではインラインのリンクになる）。
 */
export interface LinkReference {
    /** 定義の名前（原文の書き方のまま）。 */
    label: string;
    /** リンク先。 */
    url: string;
    /** title。指定がなければundefined。 */
    title?: string;
}

/**
 * 文書全体の変換結果。
 */
export interface DocumentConversionResult {
    /** 変換後の原文。`unsupportedLines`が空でない場合も、変換できた部分を書き換えた原文が入る。 */
    text: string;
    /**
     * 変換するとプレビューの見た目が変わる記法を含む行（1始まり、昇順、重複なし）。
     * 呼び出し側（変換タブ）は、報告のない変換を候補として優先し、報告のある変換も最後の候補として適用できる（変換を止めない）。
     * 例: 入れ子の引用、リスト項目の中のブロック、Markdownのプレビューが本文の記法を解釈しない脚注、
     * Markdownに記法のないTextileのclass・配置・表の属性、front matter（Markdownのプレビューでは水平線と見出しになる）。
     */
    unsupportedLines: number[];
}

/**
 * 変換中に「プレビューが変わる記法」を見つけた行を集める。
 * 変換は同期処理で入れ子にならないため、実行中の1件だけをモジュール変数で保持し、
 * 深いインライン変換関数へ引数を通さずに報告できるようにする。変換の終了時に必ず解除する。
 */
class UnsupportedCollector {
    /** 現在変換している行の0始まり番号。ブロック処理が行を進めるたびに更新する。 */
    line = 0;
    /** 報告された行（1始まり）。 */
    readonly lines = new Set<number>();

    /**
     * 現在の行、または指定した範囲の行を報告する。
     * @param from - 0始まりの開始行。省略時は現在の行。
     * @param to - 0始まりの終了行（この行を含まない）。省略時は開始行の1行だけ。
     */
    report(from: number = this.line, to: number = from + 1): void {
        for (let line = from; line < to; line += 1) this.lines.add(line + 1);
    }
}

/** 実行中の変換の報告先。変換関数の外では常にundefined。 */
let activeCollector: UnsupportedCollector | undefined;

/**
 * 実行中の変換が逆変換モード（{@link DocumentConversionOptions.restore}）ならtrue。
 * 報告先と同じく、深いインライン変換関数へ引数を通さずに参照するためモジュール変数で持ち、変換の終了時に必ず戻す。
 */
let restoreMode = false;

/**
 * 実行中の変換に渡された、文書全体の脚注ID（{@link DocumentConversionOptions.footnotes}）。
 * 文書の一部だけを変換するときに、参照と定義の対応（番号）を文書全体と揃えるために使う。変換の終了時に必ず戻す。
 */
let documentFootnotes: readonly string[] | undefined;

/**
 * 実行中の変換に渡された、Markdown文書全体の参照リンクの定義（{@link DocumentConversionOptions.references}）。
 * 脚注IDと同じく、深いインライン変換関数から参照するためモジュール変数で持ち、変換の終了時に必ず戻す。
 */
let documentReferences: readonly LinkReference[] | undefined;

/**
 * 実行中の変換が、原文をMarkdownだけの文書として扱う指定（{@link DocumentConversionOptions.markdownOnly}）ならtrue。
 * 他の指定と同じくモジュール変数で持ち、変換の終了時に必ず戻す。
 */
let markdownOnlyMode = false;

/** Markdownの参照リンクの定義行（`[名前]: URL "title"`）。名前が`^`で始まる行は脚注の定義なので除く。 */
const MARKDOWN_REFERENCE_DEFINITION = /^ {0,3}\[([^\]^][^\]]*)\]:\s*(<[^<>\s]*>|\S+)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^()]*)\)))?\s*$/;

/**
 * Markdownのコメントとして使う参照定義（`[//]: # "本文"`）。表示されない行で、Textileのコメント（`###.`）と同じ意味として相互に写す。
 */
const MARKDOWN_COMMENT_DEFINITION = /^ {0,3}\[\/\/\]:\s*#\s+(?:"([^"]*)"|'([^']*)'|\(([^()]*)\))\s*$/;

/**
 * 参照リンクの名前を、Markdownの照合規則（大文字小文字と連続する空白を区別しない）で比べられる形にする。
 * @param label - 名前。
 * @returns 照合用の名前。
 */
function normalizeReferenceLabel(label: string): string {
    return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Markdown文書全体の参照リンクの定義（`[名前]: URL "title"`の行）を集める。コメント用の`[//]: #`は除く。
 * @param source - Markdownの原文。
 * @returns 定義の一覧（文書内の順）。同じ名前（大文字小文字と連続する空白を区別しない）の定義は最初のものだけ。
 */
export function collectLinkReferences(source: string): LinkReference[] {
    const references: LinkReference[] = [];
    const seen = new Set<string>();
    for (const line of source.split(/\r\n|\r|\n/)) {
        const match = MARKDOWN_REFERENCE_DEFINITION.exec(line);
        if (!match || match[1] === '//' || seen.has(normalizeReferenceLabel(match[1]))) continue;
        seen.add(normalizeReferenceLabel(match[1]));
        references.push({ label: match[1], url: match[2].replace(/^<(.*)>$/, '$1'), title: match[3] ?? match[4] ?? match[5] });
    }
    return references;
}

/**
 * 実行中のMarkdown→Textileの変換で使う参照リンクの定義を、照合用の名前から引ける表。{@link convertMarkdownToTextile}が
 * 開始時に、文書全体の定義（{@link documentReferences}）、なければ変換する文字列の中の定義から作り直す。
 * 変換は同期処理で入れ子にならないため、前の値は残っても使われない。
 */
let currentReferences = new Map<string, LinkReference>();

/**
 * 実行中の変換へ「プレビューが変わる記法」を報告する。変換の外から呼ばれた場合は何もしない。
 * @param from - 0始まりの開始行。省略時は現在の行。
 * @param to - 0始まりの終了行（この行を含まない）。
 */
function reportUnsupported(from?: number, to?: number): void {
    activeCollector?.report(from, to);
}

/**
 * 報告先を有効にして変換を実行し、結果と報告された行をまとめて返す。
 * @param convert - 変換本体。
 * @param restore - 逆変換モードで実行する場合はtrue。
 * @param footnotes - 文書全体の脚注ID（定義の順）。省略時は変換する文字列の中の定義だけを使う。
 * @param references - 文書全体の参照リンクの定義。省略時は変換する文字列の中の定義だけを使う。
 * @param markdownOnly - 原文をMarkdownだけの文書として扱う場合はtrue。
 * @returns 変換結果。
 */
function collectUnsupported(
    convert: () => string,
    restore = false,
    footnotes?: readonly string[],
    references?: readonly LinkReference[],
    markdownOnly = false
): DocumentConversionResult {
    const previous = activeCollector;
    const previousRestore = restoreMode;
    const previousFootnotes = documentFootnotes;
    const previousReferences = documentReferences;
    const previousMarkdownOnly = markdownOnlyMode;
    const collector = new UnsupportedCollector();
    activeCollector = collector;
    restoreMode = restore;
    documentFootnotes = footnotes;
    documentReferences = references;
    markdownOnlyMode = markdownOnly;
    try {
        const text = convert();
        return { text, unsupportedLines: [...collector.lines].sort((a, b) => a - b) };
    } finally {
        activeCollector = previous;
        restoreMode = previousRestore;
        documentFootnotes = previousFootnotes;
        documentReferences = previousReferences;
        markdownOnlyMode = previousMarkdownOnly;
    }
}

/**
 * 改行コードを行ごとに保持した文書の分解結果。
 */
interface SplitDocument {
    /** 改行コードを除いた各行の本文。 */
    lines: string[];
    /** 各行に続く改行コード。末尾に改行がない最終行は空文字。 */
    eols: string[];
    /** 文書内で最も多く使われた改行コード。改行がない文書は`\n`。 */
    dominantEol: string;
}

/**
 * 原文を改行コードごと分解し、再結合時に改行コードを復元できる形にする。
 * CRLF・LF・CRが混在する文書でも各行の改行コードを保つ。
 * @param source - 変換対象の原文。
 * @returns 行本文、各行の改行コード、主要な改行コード。
 */
function splitDocument(source: string): SplitDocument {
    const lines: string[] = [];
    const eols: string[] = [];
    const counts = new Map<string, number>();
    const pattern = /\r\n|\r|\n/g;
    let cursor = 0;
    for (const match of source.matchAll(pattern)) {
        lines.push(source.slice(cursor, match.index));
        eols.push(match[0]);
        counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
        cursor = match.index + match[0].length;
    }
    if (cursor < source.length || lines.length === 0) {
        lines.push(source.slice(cursor));
        eols.push('');
    }
    let dominantEol = '\n';
    let dominantCount = 0;
    for (const [eol, count] of counts) {
        if (count > dominantCount) {
            dominantEol = eol;
            dominantCount = count;
        }
    }
    return { lines, eols, dominantEol };
}

/**
 * 変換結果の行を集め、元の行の改行コードを引き継いで結合する出力バッファ。
 * 1行から複数行を生成する場合、途中の行には主要な改行コードを使い、
 * ブロック最後の行には元の最終行の改行コードを使う。
 */
class LineWriter {
    /** 出力済みの行本文と改行コードの組。 */
    private readonly output: Array<{ text: string; eol: string }> = [];

    /**
     * @param dominantEol - 新しく作る行に使う改行コード。
     */
    constructor(private readonly dominantEol: string) { }

    /**
     * 1行を出力する。
     * @param text - 行本文。
     * @param eol - 行に続く改行コード。省略時は主要な改行コード。
     */
    push(text: string, eol: string = this.dominantEol): void {
        this.output.push({ text, eol });
    }

    /**
     * 複数行を出力し、最後の行だけ指定した改行コードを使う。
     * @param lines - 出力する行本文の一覧。空配列なら何も出力しない。
     * @param lastEol - 最後の行に続く改行コード。
     */
    pushBlock(lines: readonly string[], lastEol: string): void {
        lines.forEach((text, index) => this.push(text, index === lines.length - 1 ? lastEol : this.dominantEol));
    }

    /**
     * 直前に出力した行の本文を書き換える。段落内の強制改行付与などに使う。
     * @param update - 直前行の本文から新しい本文を作る関数。
     */
    amendLast(update: (text: string) => string): void {
        const last = this.output[this.output.length - 1];
        if (last) last.text = update(last.text);
    }

    /**
     * 直前に出力した行本文を返す。
     * @returns 直前行の本文。未出力ならundefined。
     */
    last(): string | undefined {
        return this.output[this.output.length - 1]?.text;
    }

    /**
     * 行を結合して原文形式へ戻す。
     * @returns 改行コードを含む変換後の原文。
     */
    toString(): string {
        return this.output.map((line) => line.text + line.eol).join('');
    }
}

/**
 * Textileブロック署名（p. h1. bq. bc. pre. notextile. div.）の属性部分。
 * 配置記号、クラス・ID、スタイル、言語をこの順で任意に受け付ける。
 */
const TEXTILE_ATTRIBUTES = String.raw`(?:[<>=()]*)(?:\([^)]*\))?(?:\{[^}]*\})?(?:\[[^\]]*\])?`;

/**
 * Textileブロック署名を解析する正規表現。
 * グループ: 1=種別、2=属性、3=`.`または`..`、4=本文（空の場合あり）。
 */
const TEXTILE_SIGNATURE = new RegExp(String.raw`^(p|div|bq|bc|pre|notextile|h[1-6])(${TEXTILE_ATTRIBUTES})(\.\.?)(?:\s+(.*))?$`, 'i');

/**
 * bq.署名の直後に引用元URLが続くNotePM形式（`bq.https://… 本文`、`bq.(https://…) 本文`、`bq.:https://… 本文`）。
 */
const TEXTILE_CITED_QUOTE = /^bq\.(?::|\(?)(https?:\/\/[^\s)]+)\)?\s+(.*)$/i;

/**
 * Textileの表の行の先頭に付く属性（`{background:#f00}. |…|`・`(cls). |…|`・`<. |…|`など）。グループ: 1=行頭の空白。
 */
const TEXTILE_TABLE_ROW_ATTRIBUTES = /^(\s*)(?:\{[^}]*\}|\([^)]*\)|\[[^\]]*\]|[<>=~^-])+\.\s*(?=\|.*\|\s*$)/;

/**
 * Textileのリスト項目行。グループ: 1=マーカー列（`*`と`#`の組み合わせ）、2=番号付きリストの開始番号（`#3 項目`の`3`。
 * textile-jsは`<ol start="3">`として描画する）、3=本文。
 */
const TEXTILE_LIST_ITEM = new RegExp(String.raw`^([*#]+)(\d+)?${TEXTILE_ATTRIBUTES}\s+(.*)$`);

/**
 * Textileの表行。先頭と末尾がパイプで、間に1セル以上ある行。
 */
const TEXTILE_TABLE_ROW = /^\s*\|.*\|\s*$/;

/**
 * Textile脚注定義行。グループ: 1=番号、2=本文。
 */
const TEXTILE_FOOTNOTE_DEFINITION = /^fn(\d+)\.\s+(.*)$/i;

/**
 * Textileブロック署名を分解した結果。
 */
interface TextileSignature {
    /** 署名種別（小文字）。 */
    kind: string;
    /** 属性文字列。 */
    attributes: string;
    /** `..`で始まる複数段落ブロックならtrue。 */
    extended: boolean;
    /** 署名に続く本文。 */
    body: string;
}

/**
 * 行頭のTextileブロック署名を解析する。
 * @param line - 判定する行本文。
 * @returns 署名の構成要素。署名で始まらない行はundefined。
 */
function parseTextileSignature(line: string): TextileSignature | undefined {
    const match = TEXTILE_SIGNATURE.exec(line);
    if (match) {
        return {
            kind: match[1].toLowerCase(),
            attributes: match[2],
            extended: match[3] === '..',
            body: match[4] ?? ''
        };
    }
    const cited = TEXTILE_CITED_QUOTE.exec(line);
    if (cited) return { kind: 'bq', attributes: '', extended: false, body: cited[2] };
    return undefined;
}

/**
 * Textile属性文字列から最初のクラス名を取り出す。コードブロックの言語名として使う。
 * @param attributes - `(lang)`形式などを含む属性文字列。
 * @returns 最初のクラス名。クラス指定がなければundefined。
 */
function readTextileClass(attributes: string): string | undefined {
    const value = /\(([^)#]*)/.exec(attributes)?.[1]?.trim();
    return value ? value.split(/\s+/)[0] : undefined;
}

/**
 * 原文の生HTMLの`<pre>`の本文を、Markdownでも文字どおり表示されるようエスケープする（{@link escapeRawPreBlock}）。
 * @param text - コード本文。
 * @returns `&`、`<`、`>`を実体参照にした文字列。
 */
function escapeHtmlText(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * コード内のHTML文字参照を文字へ戻す。Textileプレビュー（textileAdapter）がraw pre本文へ適用する復号と同じ規則。
 * textile-jsを束ねるアダプターを取り込まず、Webview本体のバンドルを軽く保つために同じ規則をここに持つ。
 * @param source - raw HTML pre/code要素内の本文。
 * @returns 標準文字参照と数値文字参照を復号した文字列。
 */
function decodeCodeEntities(source: string): string {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return source.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, reference: string) => {
        const normalized = reference.toLowerCase();
        if (normalized in named) return named[normalized];
        const codePoint = normalized.startsWith('#x')
            ? Number.parseInt(normalized.slice(2), 16)
            : Number.parseInt(normalized.slice(1), 10);
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : entity;
    });
}

/**
 * 生HTMLの`<pre>`ブロックの本文を、Markdownでも文字どおり表示されるHTMLテキストへ退避する。
 * 開始タグ（任意の`<code>`を含む）と閉じタグは保ち、本文だけ文字参照を復号してから再エスケープする。
 * 行数と改行位置は変えない。
 * @param block - `<pre>`開始行から`</pre>`を含む行までの本文行。
 * @returns 本文を退避した行。閉じタグが見つからない場合は原文のまま。
 */
function escapeRawPreBlock(block: readonly string[]): string[] {
    const joined = block.join('\n');
    const match = /^([\s\S]*?<pre\b[^>]*>(?:\s*<code\b[^>]*>)?)([\s\S]*?)((?:<\/code\s*>)?\s*<\/pre\s*>[\s\S]*)$/i.exec(joined);
    if (!match) return [...block];
    // Textileプレビューはタグ直後と閉じタグ直前の整形用改行を1つずつ取り除く（textileAdapterのtrimCodeWrapperNewlines）。
    // Markdownは<code>直後の改行を空行として表示するため、同じ規則で取り除いておく。
    const body = decodeCodeEntities(match[2]).replace(/^\n/, '').replace(/\n$/, '');
    const escaped = `${match[1]}${escapeHtmlText(body)}${match[3]}`;
    return escaped.split('\n');
}

/**
 * Markdownで意味を持つ記号を表示文字として残すためにバックスラッシュで退避する。
 * Textileのnotextile範囲など、記法を適用しない本文に使う。
 * @param text - 表示文字として残す本文。
 * @returns Markdownとして解釈されない本文。
 */
function escapeMarkdownLiteral(text: string): string {
    return text.replace(/[\\`*_[\]<>~^=+\-@!%"]/g, (character) => `\\${character}`);
}

/**
 * 文字がUnicodeの単語構成文字（文字・数字・下線）か判定する。記法の境界判定に使う。
 * @param character - 判定する1文字。空文字は非単語文字として扱う。
 * @returns 単語構成文字ならtrue。
 */
function isWordCharacter(character: string): boolean {
    return /[\p{L}\p{N}_]/u.test(character);
}

/**
 * textile-js（2.1.1）がフレーズ・インラインコード・リンクの開始記号の直前に許す文字。
 * これ以外（英数字、日本語、`-`、`/`、`、`、`「`など）の直後では記号は文字のまま表示される。
 */
const TEXTILE_PHRASE_BEFORE = /[\s<>.,"'?!;:()[\]%{}]/;

/**
 * textile-js（2.1.1）がフレーズ・インラインコードの閉じ記号の直後に許す文字。
 * 日本語の句読点（`、`・`」`など）は含まれないため、その直前の閉じ記号は記法にならない。
 */
const TEXTILE_PHRASE_AFTER = /[\s.,"'!?;:()«»„“”‚‘’<>]/;

/**
 * 記号の直前の文字がtextile-jsの開始境界を満たすか判定する。
 * @param text - 対象行。
 * @param start - 開始記号の位置。
 * @returns 行頭、または許可された文字の直後ならtrue。
 */
function hasTextileStartBoundary(text: string, start: number): boolean {
    return start === 0 || TEXTILE_PHRASE_BEFORE.test(text[start - 1]);
}

/**
 * 指定位置のTextileフレーズ記号がtextile-jsと同じ境界条件を満たすか判定する。
 * @param text - 対象行。
 * @param start - 開始記号の位置。
 * @param end - 閉じ記号の直後の位置。
 * @returns 開始・終了の両方の境界条件を満たせばtrue。
 */
function hasPhraseBoundary(text: string, start: number, end: number): boolean {
    return hasTextileStartBoundary(text, start) && (end >= text.length || TEXTILE_PHRASE_AFTER.test(text[end]));
}

/**
 * インライン変換で本文を分割した断片。
 */
interface InlineSegment {
    /** `text`は変換対象、`verbatim`はコードやHTMLタグなど無変換で残す断片。 */
    kind: 'text' | 'verbatim';
    /** 断片の本文。 */
    value: string;
    /** 行内での断片の開始位置。前後の文字による境界判定に使う。 */
    start: number;
}

/**
 * 本文を無変換断片と変換対象断片に分割する。
 * @param text - 1行の本文。
 * @param matchers - 無変換断片を先頭から認識する正規表現の一覧（sticky指定不要）。
 * @returns 断片の一覧。
 */
function segmentInline(text: string, matchers: readonly RegExp[]): InlineSegment[] {
    const segments: InlineSegment[] = [];
    // 1文字ごとに正規表現を作り直すと長い行で遅くなるため、sticky版を1回だけ作る。
    const stickyMatchers = matchers.map((matcher) => new RegExp(matcher.source, matcher.flags.includes('y') ? matcher.flags : `${matcher.flags}y`));
    let textStart = 0;
    let cursor = 0;
    while (cursor < text.length) {
        let matched: string | undefined;
        for (const sticky of stickyMatchers) {
            sticky.lastIndex = cursor;
            const match = sticky.exec(text);
            if (match && match[0].length > 0) {
                matched = match[0];
                break;
            }
        }
        if (matched === undefined) {
            cursor += 1;
            continue;
        }
        if (cursor > textStart) segments.push({ kind: 'text', value: text.slice(textStart, cursor), start: textStart });
        segments.push({ kind: 'verbatim', value: matched, start: cursor });
        cursor += matched.length;
        textStart = cursor;
    }
    if (textStart < text.length) segments.push({ kind: 'text', value: text.slice(textStart), start: textStart });
    return segments;
}

/** HTMLの開始・終了タグ、またはコメント。属性値内の`>`は考慮しない。 */
const HTML_TAG = /<(?:!--[\s\S]*?--|\/?[A-Za-z][\w-]*(?:\s+[^<>]*?)?\/?)>/;

/**
 * Textileのインラインコード。`@…@`はtextile-jsと同じく前後の文字が境界条件を満たす場合だけコードになる。
 * 角括弧の書き方`[@…@]`は境界条件を持たず、最初の`@]`までを本文にする。
 */
const TEXTILE_INLINE_CODE = /\[@.+?@\]|(?<=^|[\s<>.,"'?!;:()[\]%{}])@(?:\S+|\S+.*?\S)@(?=$|[\s.,"'!?;:()«»„“”‚‘’<>])/;

/** Textileのインラインnotextile `==…==`。textile-jsと同じく、開始の`==`から最初の`==`までを本文にする（本文は`=`を含められる）。 */
const TEXTILE_INLINE_NOTEXTILE = /==[^\r\n]+?==/;

/** Markdownのインラインコード。開始と同じ長さのバッククォート列で閉じる。バックスラッシュで退避したバッククォートは開始にしない。 */
const MARKDOWN_INLINE_CODE = /(?<!\\)(`+)(?!`)[\s\S]*?[^`]\1(?!`)|(?<!\\)``/;

/** Markdownのインライン数式 `$…$`。Textileには相当記法がないため無変換で残す。 */
const MARKDOWN_INLINE_MATH = /\$(?!\s)[^$\r\n]+?(?<!\s)\$/;

/** Markdownの自動リンク `<https://…>`。 */
const MARKDOWN_AUTOLINK = /<https?:\/\/[^\s<>]+>/;

/**
 * Markdownの画像をTextileの画像記法`!src(alt)!`へ写す。HTMLは使わない。
 * Textileは代替文字列をtitle（ツールチップ）にも使うため、Markdownの別のtitleは書けない（代替文字列を優先する）。
 * 記法と衝突する文字は、参照先はURLの百分率符号化、代替文字列は文字参照にする。
 * @param alt - 代替文字列。
 * @param src - 画像の参照先。
 * @param title - titleの指定（Textileでは代替文字列と同じになるため使わない）。
 * @returns Textileの画像記法。
 */
function renderTextileImage(alt: string, src: string, title: string | undefined): string {
    void title;
    const safeSrc = src.replace(/[\s!()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
    const safeAlt = alt.replace(/[()!]/g, (character) => `&#${character.charCodeAt(0)};`);
    return safeAlt ? `!${safeSrc}(${safeAlt})!` : `!${safeSrc}!`;
}

/**
 * Markdown文書に混在するTextileのインライン記法が指定位置から始まるか調べ、その終端を返す。
 * 対象はTextileのリンク（`"text":url`、`["text":url]`）、画像（`!src(alt)!`とリンク付き画像）、
 * 参照リンク（`[name]https://…`）、class付きspan（`%(class)text%`）。Markdownの画像`![`は対象外。
 * @param text - Markdown本文の1行。
 * @param start - 判定する位置。
 * @returns 記法の終端位置。記法でなければundefined。
 */
function readMixedTextileInline(text: string, start: number): number | undefined {
    const character = text[start];
    if (character === '"') return readTextileLink(text, start)?.end;
    if (character === '[' && text[start + 1] === '"') {
        const link = readTextileLink(text, start + 1, ']');
        return link && text[link.end] === ']' ? link.end + 1 : undefined;
    }
    if (character === '[') {
        const reference = /^\[[a-z][\w-]*\]https?:\/\/[^\s\]]+/i.exec(text.slice(start, start + PHRASE_SEARCH_LIMIT));
        return reference ? start + reference[0].length : undefined;
    }
    if (character === '!' && text[start + 1] !== '[') {
        const image = readTextileImage(text, start);
        if (!image) return undefined;
        const linked = text[image.end] === ':' ? readTextileUrl(text, image.end + 1)
            : /^https?:\/\//.test(text.slice(image.end, image.end + 8)) ? readTextileUrl(text, image.end) : undefined;
        return linked ? linked.end : image.end;
    }
    if (character === '%') {
        const span = /^%\([a-z][\w-]*\)[^%\r\n]+%/i.exec(text.slice(start, start + PHRASE_SEARCH_LIMIT));
        return span ? start + span[0].length : undefined;
    }
    return undefined;
}

/**
 * GFMの自動リンク（素のURL）を、GFMと同じ終端規則で切り出す。
 * 空白と`<`の直前で終わり、末尾の`?!.,:*_~`と、対応する開き括弧のない閉じ括弧をURLから除く。
 * @param text - 対象行。
 * @param start - `http`の位置。
 * @returns URLと終端位置。URLでなければundefined。
 */
function readGfmAutolink(text: string, start: number): { url: string; end: number } | undefined {
    let end = start;
    while (end < text.length && !/[\s<]/.test(text[end])) end += 1;
    while (end > start) {
        const last = text[end - 1];
        if (/[?!.,:*_~]/.test(last)) {
            end -= 1;
            continue;
        }
        const url = text.slice(start, end);
        if (last === ')' && (url.match(/\)/g) ?? []).length > (url.match(/\(/g) ?? []).length) {
            end -= 1;
            continue;
        }
        break;
    }
    return end > start ? { url: text.slice(start, end), end } : undefined;
}

/**
 * 指定位置から始まるURLをtextile-js（2.1.1）のリンク終端規則で切り出す。
 * 通常形式は空白の直前、または「末尾句読点の連続＋空白・行末」の直前で終わる（最短一致）。
 * `(…)`は1つの単位として読み、`Textile_(markup_language)`のような括弧入りURLを保つ。
 * 角括弧形式（`stopCharacter`指定）は閉じ括弧の直前まで空白を含めて読む。
 * @param text - 対象行。
 * @param start - URLの開始位置。
 * @param stopCharacter - 角括弧形式のリンクで、URLをこの文字の直前で終える場合に指定する。
 * @returns URL文字列と終端位置。URLが空なら undefined。
 */
function readTextileUrl(text: string, start: number, stopCharacter?: string): { url: string; end: number } | undefined {
    let end = start;
    while (end < text.length) {
        const character = text[end];
        if (stopCharacter !== undefined) {
            if (character === stopCharacter || /[\r\n]/.test(character)) break;
            end += 1;
            continue;
        }
        if (/\s/.test(character)) break;
        if (end > start && endsTextileUrlAt(text, end)) break;
        const group = character === '(' ? /^\([^\s()]+\)/.exec(text.slice(end, end + PHRASE_SEARCH_LIMIT)) : null;
        end += group ? group[0].length : 1;
    }
    if (end === start) return undefined;
    return { url: text.slice(start, end), end };
}

/**
 * textile-jsがURLの直後に置かれたとみなす句読点（ASCII記号のうち`/`を除く）。
 */
const TEXTILE_URL_TRAILING = /[!-.:-@[\\\]-`{-~]/;

/**
 * 指定位置から句読点が連続し、その後が空白または行末なら、URLがその直前で終わると判定する。
 * @param text - 対象行。
 * @param position - URL内の候補位置。
 * @returns URLがこの位置で終わる場合はtrue。
 */
function endsTextileUrlAt(text: string, position: number): boolean {
    let cursor = position;
    while (cursor < text.length && TEXTILE_URL_TRAILING.test(text[cursor])) cursor += 1;
    return cursor > position && (cursor >= text.length || /\s/.test(text[cursor]));
}

/**
 * Textile画像記法を解析する。
 * @param text - 対象行。
 * @param start - `!`の位置。
 * @returns 画像の参照先、代替文字列、終端位置。画像でなければundefined。
 */
function readTextileImage(text: string, start: number): { src: string; alt: string; end: number } | undefined {
    const match = /^!(?:[<>=])?([^\s!()]+)(?:\(([^)]*)\))?!/.exec(text.slice(start, start + PHRASE_SEARCH_LIMIT));
    if (!match) return undefined;
    return { src: match[1], alt: match[2] ?? '', end: start + match[0].length };
}

/**
 * Textile→Markdownのインライン変換。コード・HTMLタグ・notextile範囲は無変換で残す。
 * @param text - Textile本文の1行（またはセル本文）。
 * @param footnoteIds - 文書内に定義がある脚注番号。参照 `[n]` を `[^n]` に変換する判定に使う。
 * @returns Markdownのインライン記法に書き換えた本文。
 */
function convertTextileInline(text: string, footnoteIds: ReadonlySet<string>): string {
    const converted = segmentInline(text, [TEXTILE_INLINE_CODE, TEXTILE_INLINE_NOTEXTILE, HTML_TAG]).map((segment) => {
        if (segment.kind === 'verbatim') {
            if (segment.value.startsWith('@') || segment.value.startsWith('[@')) {
                // textile-jsはコード内の文字参照をそのまま出力するためブラウザーでは文字として表示されるが、
                // Markdownのコードスパンは参照を文字列として表示する。表示される文字へ復号して書く（表のセルでは`|`が後で退避される）。
                const marker = segment.value.startsWith('[@') ? 2 : 1;
                const code = decodeCodeEntities(segment.value.slice(marker, -marker));
                const fence = code.includes('`') ? '``' : '`';
                const padding = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
                return `${fence}${padding}${code}${padding}${fence}`;
            }
            if (segment.value.startsWith('==')) {
                const literal = segment.value.slice(2, -2);
                // 逆変換モード: Markdown→Textileの順変換はインライン数式を記法として解釈されない範囲（`==$…$==`、`^`・`~`は文字参照）に
                // 書くため、その逆。
                const math = literal.replace(/&#94;/g, '^').replace(/&#126;/g, '~');
                if (restoreMode && /^\$(?!\s)[^$\r\n]+?(?<!\s)\$$/.test(math)) return math;
                return escapeMarkdownLiteral(literal);
            }
            // <notextile>タグはTextileでは取り除かれて中身だけが文字のまま表示されるが、Markdownではタグが残る。
            if (/^<\/?notextile\b/i.test(segment.value)) reportUnsupported();
            return segment.value;
        }
        return convertTextilePhrases(segment.value, footnoteIds);
    }).join('');
    return converted;
}

/**
 * Textileのリンク1つをMarkdownへ写す。HTMLは使わない。
 * - class付き（`"(class). 表示":URL`）は、Markdownのリンクにclassを付けられないため、Markdown文書のプレビュー（混在Textile）が
 *   class付きリンクとして描画する`"(class). 表示":URL`の形で、Textileの記法のまま書く。
 * - 逆変換モードで、表示文字とリンク先が同じURLのリンクは、Markdown→Textileの順変換が自動リンク（`<URL>`）から作る形なので`<URL>`へ戻す。
 * - それ以外はインラインのリンク`[表示](URL "title")`にする。
 * @param raw - リンクの原文。
 * @param link - 解析したリンク（{@link readTextileLink}）。
 * @param footnoteIds - 文書内に定義がある脚注番号。
 * @returns Markdownのリンク。
 */
function renderTextileLinkAsMarkdown(
    raw: string,
    link: { label: string; url: string; title?: string; hasClass: boolean },
    footnoteIds: ReadonlySet<string>
): string {
    if (link.hasClass) return raw.replace(/^(\[?"\([^()]*\))(?!\.\s)/, '$1. ');
    const label = convertTextilePhrases(link.label, footnoteIds);
    if (restoreMode && !link.title && link.label === link.url && /^https?:\/\/[^\s<>]+$/i.test(link.url)) return `<${link.url}>`;
    return `[${label}](${link.url}${link.title ? ` "${link.title}"` : ''})`;
}

/**
 * Textileのリンク・画像・フレーズ記号・略語・脚注参照をMarkdownへ書き換える。
 * 1文字ずつ走査し、記法として成立しない記号はMarkdownで意味を持たないよう退避する。
 * @param text - コードやHTMLタグを含まない本文。
 * @param footnoteIds - 文書内に定義がある脚注番号。
 * @returns Markdownへ書き換えた本文。
 */
function convertTextilePhrases(text: string, footnoteIds: ReadonlySet<string>): string {
    let output = '';
    let pending = '';
    let cursor = 0;

    /**
     * 記法にならなかった平文をTextileの文字置換規則で整え、Markdownの記号として解釈されないよう退避して出力へ移す。
     */
    function flush(): void {
        if (!pending) return;
        output += toMarkdownPlainText(pending);
        pending = '';
    }
    while (cursor < text.length) {
        const character = text[cursor];

        // 画像（リンク付き画像を含む）
        if (character === '!') {
            const image = readTextileImage(text, cursor);
            if (image) {
                // 配置付きの画像（`!<a.png!`・`!=a.png!`・`!>a.png!`）は、Markdownの画像記法では寄せ方を表せない。
                if (/^![<>=]/.test(text.slice(cursor, cursor + 2))) reportUnsupported();
                // Textileの`!src(alt)!`は代替文字列と同じtitle（ツールチップ）も付けるが、構文の意味はMarkdownの`![alt](src)`と同じ。
                // ツールチップの有無は表示上の違いだけなので、titleは書かない。
                // 逆変換モード: Markdown→Textileの順変換は代替文字列の`(`・`)`・`!`を文字参照にするため、その逆。
                const alt = restoreMode ? image.alt.replace(/&#(40|41|33);/g, (whole, code: string) => String.fromCharCode(Number(code))) : image.alt;
                const markdownImage = `![${alt}](${image.src})`;
                const linked = /^:(?=\S)/.exec(text.slice(image.end, image.end + 16)) ? readTextileUrl(text, image.end + 1)
                    : /^https?:\/\//.test(text.slice(image.end, image.end + 16)) ? readTextileUrl(text, image.end) : undefined;
                if (linked) {
                    flush();
                    output += `[${markdownImage}](${linked.url})`;
                    cursor = linked.end;
                } else {
                    flush();
                    output += markdownImage;
                    cursor = image.end;
                }
                continue;
            }
        }

        // 括弧付きリンク ["text":url] と通常リンク "text":url
        const bracketed = character === '[' && text[cursor + 1] === '"';
        if (bracketed || character === '"') {
            const link = bracketed ? readTextileLink(text, cursor + 1, ']') : readTextileLink(text, cursor);
            if (link && (!bracketed || text[link.end] === ']')) {
                const end = bracketed ? link.end + 1 : link.end;
                flush();
                output += renderTextileLinkAsMarkdown(text.slice(cursor, end), link, footnoteIds);
                cursor = end;
                continue;
            }
        }

        // 参照リンクの短縮形 [label]https://…（本拡張のTextileは表示名付きのリンクとして描画する）と脚注参照 [n]
        if (character === '[') {
            const reference = /^\[([a-z][\w-]*)\](https?:\/\/[^\s\]]+)/i.exec(text.slice(cursor, cursor + PHRASE_SEARCH_LIMIT));
            if (reference) {
                flush();
                output += `[${reference[1]}](${reference[2]})`;
                cursor += reference[0].length;
                continue;
            }
            const footnote = /^\[(\d+)!?\]/.exec(text.slice(cursor, cursor + 32));
            // textile-jsは直前が空白でない`[数字]`を、脚注の定義がなくても上付きの脚注参照として描画する（例: `arr[1]`）。
            if (footnote && cursor > 0 && /\S/.test(text[cursor - 1]) && !footnoteIds.has(footnote[1])) reportUnsupported();
            if (footnote && footnoteIds.has(footnote[1])) {
                // 定義のある脚注参照は、構文の意味が同じMarkdownの`[^n]`へ写す（番号の表示位置の違いは表示上の違いだけ）。
                flush();
                output += `[^${footnote[1]}]`;
                cursor += footnote[0].length;
                continue;
            }
        }

        // 略語 ABC(説明)
        if (/[A-Z]/.test(character) && (cursor === 0 || !isWordCharacter(text[cursor - 1]))) {
            const acronym = /^([A-Z]{3,})\(([^)]+)\)/.exec(text.slice(cursor, cursor + PHRASE_SEARCH_LIMIT));
            if (acronym) {
                // Markdownに略語の記法はないため、Textileの略語の書き方（`ABC(説明)`）のまま書く（逆変換で同じ書き方へ戻る）。
                flush();
                output += `${acronym[1]}(${escapeMarkdownLiteral(acronym[2])})`;
                cursor += acronym[0].length;
                continue;
            }
        }

        // フレーズ記号
        const phrase = readTextilePhrase(text, cursor);
        if (phrase) {
            const inner = convertTextilePhrases(phrase.inner, footnoteIds);
            flush();
            output += renderMarkdownPhrase(phrase.marker, inner, phrase.className);
            cursor = phrase.end;
            continue;
        }

        // 記法として成立しなかった文字は平文としてまとめ、出力時にTextileの文字置換と退避を適用する。
        pending += character;
        cursor += 1;
    }
    flush();
    return output;
}

/**
 * textile-js（2.1.1）が本文の文字列へ適用する文字置換（引用符・ダッシュ・省略記号・×・©・®・™・分数）を同じ順序で適用する。
 * Textileのプレビューはこの置換後の文字を表示するため、Markdownへ写すときは置換後の文字そのものを書く。
 * @param text - 記法を含まない本文の断片。
 * @returns 置換後の文字列。
 */
function applyTextileGlyphs(text: string): string {
    const punct = String.raw`[!-/:-@[\\\]-\`{-~]`;
    return text
        .replace(/([^-]|^)->/, '$1→')
        .replace(/([\d.,]+['"]? ?)x( ?)(?=[\d.,]['"]?)/g, '$1×$2')
        .replace(/([^.]?)\.{3}/g, '$1…')
        .replace(/(^|[\s\w])--([\s\w]|$)/g, '$1—$2')
        .replace(/ - /g, ' – ')
        .replace(/(\b ?|\s|^)(?:\((?:TM|tm)\)|\[(?:TM|tm)\])/g, '$1™')
        .replace(/(\b ?|\s|^)(?:\(R\)|\[R\])/gi, '$1®')
        .replace(/(\b ?|\s|^)(?:\(C\)|\[C\])/gi, '$1©')
        .replace(new RegExp(String.raw`(\d*[.,]?\d+)"(?=\s|$|${punct})`, 'g'), '$1″')
        .replace(new RegExp(String.raw`([^\s[(])"(?=$|\s|${punct})`, 'g'), '$1”')
        .replace(/"/g, '“')
        .replace(new RegExp(String.raw`(\d*[.,]?\d+)'(?=\s|$|${punct})`, 'g'), '$1′')
        .replace(/(\w)'(\w)/g, '$1’$2')
        .replace(new RegExp(String.raw`([^\s[(])'(?=$|\s|${punct})`, 'g'), '$1’')
        .replace(/'/g, '‘')
        .replace(/[([]1\/4[\])]/, '¼')
        .replace(/[([]1\/2[\])]/, '½')
        .replace(/[([]3\/4[\])]/, '¾')
        .replace(/[([]o[\])]/, '°')
        .replace(/[([]\+\/-[\])]/, '±');
}

/**
 * Textileの平文をMarkdownの平文へ写す。文字置換を適用した後、Markdownで記法になる記号と、
 * Markdown文書のプレビューが混在Textile記法・自動リンクとして描画する箇所を退避する。
 * @param text - 記法にならなかったTextileの平文。
 * @returns Markdownで同じ文字として表示される本文。
 */
function toMarkdownPlainText(text: string): string {
    if (restoreMode) return restoreMarkdownPlainText(text);
    const glyphs = applyTextileGlyphs(text);
    let output = '';
    let cursor = 0;
    while (cursor < glyphs.length) {
        const character = glyphs[cursor];
        // `[`・`~`・`^`・`+`・`$`もTextileでは文字のままだが、Markdownではリンク・取り消し線・上付き・挿入・数式の記号になる。
        if ('`*\\[~^+$'.includes(character)) {
            output += `\\${character}`;
            cursor += 1;
            continue;
        }
        const literal = escapeMixedTextileLiteral(glyphs, cursor);
        if (literal) {
            output += literal.output;
            cursor += literal.length;
            continue;
        }
        output += character;
        cursor += 1;
    }
    return output;
}

/**
 * Textile→Markdownの順変換が平文に付けるバックスラッシュ退避の対象（{@link toMarkdownPlainText}と
 * {@link escapeMixedTextileLiteral}）。逆変換モードでは、この文字の退避だけを順変換の退避とみなして外す。
 */
const TEXTILE_TO_MARKDOWN_ESCAPES = '`*\\[~^+$"@-?%:.';

/**
 * Markdown→Textileの順変換が平文の記号に付けた文字参照（{@link protectTextileGlyphs}・{@link protectTextileCharacter}）を、
 * 元のMarkdownの書き方へ戻す（逆変換モードの{@link toMarkdownPlainText}）。
 * 文字置換を避けるために参照にした記号（`"` `'` `-` `.` `x` `(`）は元が素の文字なので素の文字へ、
 * バックスラッシュ退避から参照にした記号はバックスラッシュ付きへ戻す。それ以外の平文は退避せずにそのまま書く。
 * 素の文字のままではMarkdownの記号として描画される場合は、呼び出し側の描画比較で検出され、通常の変換へ切り替わる。
 * @param text - 記法にならなかったTextileの平文。
 * @returns 順変換前のMarkdownの書き方に戻した本文。
 */
function restoreMarkdownPlainText(text: string): string {
    return applyTextileGlyphs(text).replace(/&#(\d+);/g, (entity: string, code: string) => {
        const character = String.fromCodePoint(Number(code));
        if ('"\'-.x('.includes(character)) return character;
        return '*_+@^~%?!#)[]{}|<>'.includes(character) ? `\\${character}` : entity;
    });
}

/**
 * textile-jsの文字置換で生まれる記号と、その元になるTextileの書き方（{@link applyTextileGlyphs}の逆）。
 * 逆変換モードで、Textile由来の記号を元の書き方へ戻すために使う。
 * 対象は、Textileの文書でキーボードから打つ書き方が普通の記号（引用符・アポストロフィ・省略記号・ダッシュ）に限る。
 * ©・™・×・分数などは記号そのものを書く文書も多く、どちらが元か決められないため、記号のまま残す（表示は同じ）。
 */
const TEXTILE_GLYPH_SOURCES: ReadonlyArray<[RegExp, string]> = [
    [/[“”″]/g, '"'], [/[‘’′]/g, "'"], [/…/g, '...'], [/—/g, '--'], [/ – /g, ' - '],
];

/**
 * Markdownの平文にある、Textileの文字置換で生まれた記号を、置換前のTextileの書き方へ戻す（逆変換モード）。
 * 戻した文字列へ文字置換を適用して元の平文と一致する場合だけ採用し、一致しなければ記号を文字参照で保護する通常の写し方にする。
 * @param text - 記法を含まないMarkdownの平文。
 * @returns Textileで同じ文字として表示される本文。
 */
function restoreTextileGlyphs(text: string): string {
    let restored = text;
    for (const [pattern, source] of TEXTILE_GLYPH_SOURCES) restored = restored.replace(pattern, source);
    return restored !== text && applyTextileGlyphs(restored) === text ? restored : protectTextileGlyphs(text);
}

/**
 * 表示された文字列（描画HTMLの本文など）を、Textileで同じ文字として表示される本文にする。
 * 文字置換で生まれた記号は置換前の書き方へ戻し（{@link restoreTextileGlyphs}）、戻せなければ文字置換の対象を文字参照で保護する。
 * 記法の記号（`*`・`_`など）は退避しない。記法として描画される場合は、呼び出し側の描画比較で検出される。
 * @param text - 表示される文字列。
 * @returns Textileの本文。
 */
export function toTextilePlainText(text: string): string {
    return restoreTextileGlyphs(text);
}

/**
 * Markdownの平文をTextileへ写すとき、textile-jsの文字置換（{@link applyTextileGlyphs}）が働かないよう対象の記号を文字参照にする。
 * 文字参照はTextileでもそのまま出力され、ブラウザーでは元の記号として表示される。
 * @param text - 記法を含まないMarkdownの平文。
 * @returns Textileで同じ文字として表示される本文。
 */
function protectTextileGlyphs(text: string): string {
    return text
        .replace(/(\d['"]? ?)x(?= ?[\d.,])/g, '$1&#120;')
        .replace(/([([])(?=(?:c|r|tm|1\/4|1\/2|3\/4|o|\+\/-)[)\]])/gi, (bracket: string) => (bracket === '(' ? '&#40;' : '&#91;'))
        .replace(/"/g, '&#34;')
        .replace(/'/g, '&#39;')
        // 直前が空白でない`[数字]`（`arr[0]`など）はTextileで脚注参照の上付きになる。
        .replace(/(?<=\S)\[(?=\d+!?\])/g, '&#91;')
        .replace(/-(?=>)/g, '&#45;')
        .replace(/-(?=-)/g, '&#45;')
        .replace(/ - /g, ' &#45; ')
        .replace(/\.(?=\.\.)/g, '&#46;');
}

/**
 * Textileでは文字のまま表示されるが、Markdown文書のプレビューでは記法として描画される文字列を退避する。
 * 対象: 境界条件を満たさない`"text":url`・`@code@`・`-del-`・`??cite??`・`%(class)span%`（混在描画は境界を見ない）、
 * GFMが自動リンクにする素のURL（`https://`・`www.`）。
 * @param text - Textile本文の1行（コード・HTMLタグを除いた断片）。
 * @param cursor - 判定する位置。
 * @returns 退避後の文字列と、元の文字列で消費した長さ。退避不要ならundefined。
 */
function escapeMixedTextileLiteral(text: string, cursor: number): { output: string; length: number } | undefined {
    const rest = text.slice(cursor, cursor + PHRASE_SEARCH_LIMIT);
    const character = text[cursor];
    if (character === '"' && /^"[^"\r\n]+":\S/.test(rest)) return { output: '\\"', length: 1 };
    if (character === '@' && /^@[^@\r\n]+@/.test(rest)) return { output: '\\@', length: 1 };
    // GFMはメールアドレスも自動リンクにするが、Textileでは文字のまま表示される。
    if (character === '@' && /[\w.+-]$/.test(text.slice(Math.max(0, cursor - 1), cursor)) && /^@[\w-]+(?:\.[\w-]+)+/.test(rest)) {
        return { output: '\\@', length: 1 };
    }
    if (character === '-' && text[cursor - 1] !== '-' && /^-(?!-)[^-\s](?:[^-\r\n]*[^-\s])?-(?!-)/.test(rest)) return { output: '\\-', length: 1 };
    if (character === '?' && text[cursor - 1] !== '?' && /^\?\?(?!\?)[^?\s](?:[^?\r\n]*[^?\s])?\?\?/.test(rest)) return { output: '\\?', length: 1 };
    if (character === '%' && /^%\([a-z][\w-]*\)[^%\r\n]+%/i.test(rest)) return { output: '\\%', length: 1 };
    if (!isWordCharacter(text[cursor - 1] ?? '')) {
        const url = /^(https?):\/\//i.exec(rest);
        if (url) return { output: `${url[1]}\\://`, length: url[0].length };
        if (/^www\./i.test(rest)) return { output: 'www\\.', length: 4 };
    }
    return undefined;
}

/**
 * Textileリンク `"label(title)":url` を解析する。
 * @param text - 対象行。
 * @param start - 開始引用符の位置。
 * @param stopCharacter - 角括弧形式でURLを終える文字。
 * @returns ラベル、URL、任意のタイトル、終端位置、`"(class). text":url`のclass指定の有無。リンクでなければundefined。
 */
function readTextileLink(text: string, start: number, stopCharacter?: string): { label: string; url: string; title?: string; end: number; hasClass: boolean } | undefined {
    // 行末まで探すと、閉じない引用符が多い行で二次の計算量になるため、探索範囲を区切る。
    const relativeClose = text.slice(start, start + PHRASE_SEARCH_LIMIT).indexOf('":', 1);
    const close = relativeClose < 0 ? -1 : start + relativeClose;
    if (close <= start + 1 || close - start > PHRASE_SEARCH_LIMIT) return undefined;
    const rawLabel = text.slice(start + 1, close);
    if (/[\r\n]/.test(rawLabel) || !rawLabel.trim() || /^\s/.test(rawLabel)) return undefined;
    // 通常形式はフレーズと同じく、開始の引用符の直前が行頭・空白・一部の記号でなければリンクにならない（例: 「サーバに"x":url」）。
    if (stopCharacter === undefined && !hasTextileStartBoundary(text, start)) return undefined;
    const target = readTextileUrl(text, close + 2, stopCharacter);
    if (!target) return undefined;
    // textile-jsはリンク文字列の先頭の`(class)`を、後ろの`. `の有無によらずclassとして読む（`"(btn)表示":url`）。
    // 文字列が`(…)`だけの場合はclassにせず、そのまま表示する。
    const stripped = rawLabel.replace(/^\([^()]*\)(?:\.\s*)?/, '');
    const label = stripped.trim() ? stripped : rawLabel;
    const titled = /^(.*?)\(([^()]*)\)$/.exec(label);
    return {
        hasClass: label !== rawLabel,
        label: titled ? titled[1].trim() : label,
        title: titled ? titled[2] : undefined,
        url: target.url,
        end: target.end
    };
}

/**
 * Textileフレーズ記法の解析結果。
 */
interface TextilePhrase {
    /** 記号（`**`、`__`、`*`、`_`、`-`、`+`、`??`、`%`、`^`、`~`）。 */
    marker: string;
    /** 記号に囲まれた本文。 */
    inner: string;
    /** `%(class)…%` のクラス名。 */
    className?: string;
    /** 閉じ記号の直後の位置。 */
    end: number;
}

/** Textileフレーズ記号を長いものから順に並べた一覧。 */
const TEXTILE_PHRASE_MARKERS = ['**', '__', '??', '*', '_', '-', '+', '%', '^', '~'] as const;

/**
 * 指定位置から始まるTextileフレーズ記法を解析する。
 * textile-jsと同様に、開始記号の直前と閉じ記号の直後が単語文字でなく、本文が空白で始まらず終わらないことを求める。
 * @param text - 対象行。
 * @param start - 記号候補の位置。
 * @returns 解析結果。記法として成立しなければundefined。
 */
function readTextilePhrase(text: string, start: number): TextilePhrase | undefined {
    // 上付き・下付きはtextileAdapterが単語の内側でも`^…^`・`~…~`をタグへ置き換えるため、同じ規則で読む。
    // Markdownの上付き・下付き拡張は本文の前後に空白を許さないため、その形だけを記法として扱う。
    if (text[start] === '^' || text[start] === '~') {
        const marker = text[start];
        // textileAdapterと同じく最初の閉じ記号で閉じる（最短一致）。本文はタグ記号を含まず、前後が空白でないこと。
        const close = text.indexOf(marker, start + 1);
        if (close <= start + 1 || close - start > PHRASE_SEARCH_LIMIT) return undefined;
        const inner = text.slice(start + 1, close);
        if (/[<>]/.test(inner) || (marker === '^' ? inner.includes('~') : inner.includes('^'))) return undefined;
        if (/\s/.test(inner[0]) || /\s/.test(inner[inner.length - 1])) return undefined;
        return { marker, inner, end: close + 1 };
    }
    // 角括弧の書き方（`[*太字*]`・`[%(mark)x%]`）は前後の文字の境界条件を持たない。textile-jsと同じく、
    // 開始記号の後ろで最初に現れる「終了記号と`]`」までを本文にする。
    if (text[start] === '[') {
        for (const marker of TEXTILE_PHRASE_MARKERS) {
            if (!text.startsWith(marker, start + 1)) continue;
            let contentStart = start + 1 + marker.length;
            let className: string | undefined;
            if (marker === '%') {
                const classMatch = /^\(([^)]+)\)/.exec(text.slice(contentStart, contentStart + PHRASE_SEARCH_LIMIT));
                if (classMatch) {
                    className = classMatch[1];
                    contentStart += classMatch[0].length;
                }
            }
            const close = text.slice(contentStart, contentStart + PHRASE_SEARCH_LIMIT).indexOf(`${marker}]`);
            if (close <= 0) continue;
            return { marker, inner: text.slice(contentStart, contentStart + close), className, end: contentStart + close + marker.length + 1 };
        }
    }
    for (const marker of TEXTILE_PHRASE_MARKERS) {
        if (!text.startsWith(marker, start)) continue;
        const before = start === 0 ? '' : text[start - 1];
        if (!hasTextileStartBoundary(text, start) || before === marker[0]) continue;
        let contentStart = start + marker.length;
        let className: string | undefined;
        if (marker === '%') {
            const classMatch = /^\(([^)]+)\)/.exec(text.slice(contentStart, contentStart + PHRASE_SEARCH_LIMIT));
            if (classMatch) {
                className = classMatch[1];
                contentStart += classMatch[0].length;
            }
        }
        if (contentStart >= text.length || /\s/.test(text[contentStart]) || text.startsWith(marker, contentStart)) continue;
        const close = findPhraseClose(text, marker, contentStart, (closeIndex, end) =>
            !/\s/.test(text[closeIndex - 1]) && !text.startsWith(marker[0], end) && hasPhraseBoundary(text, start, end));
        if (close) return { marker, inner: close.inner, className, end: close.end };
    }
    return undefined;
}

/**
 * フレーズ記法の閉じ記号を探す探索範囲（UTF-16単位）。
 * 閉じない記号が多数並ぶ長い行で、開始候補ごとに行末まで探して二次の計算量になるのを防ぐ。
 * 実文書のフレーズはこれより十分短いため、この範囲を超える記法は記法として扱わない。
 * まれにこれより長い強調などがあった場合、変換結果は見た目が変わるが、アプリは適用前の描画比較で検出して変換しない。
 */
const PHRASE_SEARCH_LIMIT = 500;

/**
 * フレーズ記法の閉じ記号を、探索範囲内で条件を満たす最初の位置から探す。
 * @param text - 対象行。
 * @param marker - 閉じ記号。
 * @param contentStart - 本文の開始位置。
 * @param accept - 閉じ記号の位置と閉じ記号直後の位置を受け取り、記法として成立するか判定する関数。
 *   候補ごとに本文を切り出すと探索範囲の長さ分の複製が候補数だけ発生するため、位置だけで判定させ、成立した候補だけ切り出す。
 * @returns 本文と終端位置。見つからなければundefined。
 */
function findPhraseClose(
    text: string,
    marker: string,
    contentStart: number,
    accept: (close: number, end: number) => boolean
): { inner: string; end: number } | undefined {
    const limit = contentStart + PHRASE_SEARCH_LIMIT;
    // 探索範囲の外まで indexOf が走ると、閉じ記号のない長い段落で二次の計算量になるため、範囲内の文字列だけを探す。
    // 窓は探索開始位置から切り出す（先頭から切り出すと位置に比例した複製になる）。窓内の位置に開始位置を足して元の位置へ戻す。
    const searchWindow = text.slice(contentStart, limit + marker.length);
    let relative = searchWindow.indexOf(marker, 1);
    while (relative >= 0 && contentStart + relative <= limit) {
        const close = contentStart + relative;
        const end = close + marker.length;
        if (accept(close, end)) return { inner: text.slice(contentStart, close), end };
        relative = searchWindow.indexOf(marker, relative + 1);
    }
    return undefined;
}

/**
 * Textileフレーズ記号に対応するMarkdown記法を組み立てる。
 * @param marker - Textileの記号。
 * @param inner - 変換済みの本文。
 * @param className - `%`記法のクラス名。
 * @returns Markdownの記法。Markdownに記法のない引用元（`??`）と範囲（`%`）は、Markdown文書のプレビュー（混在Textile）が
 *   同じ要素として描画するTextileの記法のまま返す。HTMLは使わない。
 */
function renderMarkdownPhrase(marker: string, inner: string, className?: string): string {
    // Textileの強調は2通り（`*strong*`と`**b**`、`_em_`と`__i__`）、Markdownも2通り（`**`と`__`、`*`と`_`）ある。
    // 表示はどちらも太字・斜体で同じなので、対応する書き方へ1対1で写し、往復で元の書き方へ戻せるようにする。
    switch (marker) {
        case '*':
            return `**${inner}**`;
        case '**':
            return `__${inner}__`;
        case '_':
            return `*${inner}*`;
        case '__':
            return `_${inner}_`;
        case '-':
            return `~~${inner}~~`;
        case '+':
            return `++${inner}++`;
        case '??':
            return `??${inner}??`;
        case '%':
            // 逆変換モード: Markdown→Textileの順変換は強調表示（`==…==`）を意味のclass（mark）付きの範囲にするため、その逆。
            if (restoreMode && className === 'mark') return `==${inner}==`;
            return className ? `%(${className})${inner}%` : `%${inner}%`;
        default:
            return `${marker}${inner}${marker}`;
    }
}

/**
 * Markdownで段落行の先頭にあるとブロック記法と誤解される文字を退避する。
 * @param line - 変換済みの段落行。
 * @returns 行頭の記号を退避した行。
 */
function escapeMarkdownLineStart(line: string): string {
    return line.replace(/^(\s{0,3})(>|[-+]\s|\d+[.)]\s|#{1,6}(?:\s|$)|```|~~~|\|)/, (whole, indent: string, marker: string) => {
        // 番号付きリストは区切り記号だけを退避する。数字の前に置くと`\`が表示されてしまう。
        const ordered = /^(\d+)([.)])(\s)$/.exec(marker);
        if (ordered) return `${indent}${ordered[1]}\\${ordered[2]}${ordered[3]}`;
        return `${indent}\\${marker}`;
    });
}

/**
 * インライン要素（画像・リンク・装飾・スクリプトなど）のタグで始まる行。段落に包まれるかどうかは表示上の余白の違いだけで、
 * 本文としての意味は変わらないため、TextileとMarkdownで段落の内外が違っても報告しない。
 */
const INLINE_HTML_LINE = /^ {0,3}<(?:img|span|a|b|i|em|strong|code|kbd|sub|sup|mark|ins|del|s|u|small|abbr|cite|script|input|label|font)(?:\s|\/?>)/i;

/**
 * Textileの段落先頭にあるとMarkdownで段落にならない生HTMLか判定する。
 * Textileはインライン要素（img、script、spanなど）で始まる行を段落で包むが、Markdownは行頭のタグをHTMLブロックとして
 * 段落の外へ出すため、プレビューの構造が変わる。ブロック要素で始まる行は両方で段落の外に置かれるため対象外。
 * @param line - 段落の1行目（Textile署名を除いた本文）。
 * @param forcedParagraph - `p.`署名付きで、Textileがブロック要素でも段落で包む場合にtrue。
 * @returns 構造が変わる場合はtrue。
 */
function startsWithParagraphBreakingHtml(line: string, forcedParagraph: boolean): boolean {
    if (!MARKDOWN_HTML_BLOCK_START.test(line)) return false;
    // インライン要素で始まる行は、段落の内側でも外側でも本文としての意味は同じ（表示上の余白の違いだけ）。
    if (INLINE_HTML_LINE.test(line)) return false;
    if (forcedParagraph) return true;
    return !/^\s*<\/?(?:p|div|table|pre|ul|ol|dl|blockquote|h[1-6]|hr|section|article|figure|details|notextile)\b/i.test(line);
}

/**
 * Textile表の1行を解析する。
 * @param line - 表行。
 * @returns セル一覧（ヘッダー種別・配置・本文）。結合セルなど変換できない行はundefined。
 */
function parseTextileTableRow(line: string): Array<{ header: boolean; align?: 'left' | 'center' | 'right'; text: string }> | undefined {
    const trimmed = line.trim();
    const cells = trimmed.slice(1, -1).split('|');
    const parsed: Array<{ header: boolean; align?: 'left' | 'center' | 'right'; text: string }> = [];
    for (const rawCell of cells) {
        let cell = rawCell;
        let header = false;
        let align: 'left' | 'center' | 'right' | undefined;
        const modifiers = /^\s*((?:[_<>=^~]|\\\d+|\/\d+|\([^)]*\)|\{[^}]*\})+)\.\s/.exec(cell);
        if (modifiers) {
            if (/[\\/]\d+/.test(modifiers[1])) return undefined;
            header = modifiers[1].includes('_');
            if (modifiers[1].includes('<')) align = 'left';
            else if (modifiers[1].includes('>')) align = 'right';
            else if (modifiers[1].includes('=')) align = 'center';
            cell = cell.slice(modifiers[0].length);
        }
        parsed.push({ header, align, text: cell.trim() });
    }
    return parsed;
}

/**
 * Textile→Markdownの行変換で保持する状態。
 */
interface TextileConversionState {
    /** 進行中のリスト階層。各要素は深さごとのマーカー種別と番号、Markdownでの字下げ幅。 */
    listLevels: Array<{ ordered: boolean; count: number; indent: number; width: number }>;
    /** 直前の出力行が段落・リスト項目・引用の本文で、次の本文行が同じブロックに続く場合にtrue。 */
    inParagraph: boolean;
    /** 直前の本文行がリスト項目またはその継続行だった場合、継続行に使う字下げ。 */
    listContinuationIndent?: string;
    /** `bq..`で始まり次の署名まで続く引用の中にいる場合にtrue。 */
    extendedQuote: boolean;
    /** 引用段落（`bq.`または`bq..`）の本文行を出力している場合にtrue。 */
    inQuote: boolean;
    /**
     * 新しいリストを始めるたびに切り替える記号の組。Textileでは空行で区切ったリストは別のリストになるが、
     * Markdownは同じ記号のリストを空行越しに1つのリストへまとめるため、隣り合うリストで記号（`-`と`*`、`.`と`)`）を変える。
     */
    alternateListMarkers: boolean;
    /**
     * Textileの書き方のまま残した複数段落ブロック（`pre..`）の後ろならtrue。Markdown文書のプレビューも次の署名まで続けるため、
     * 次の段落は`p.`を付けたまま書き、段落以外のブロックの前には空の段落`p. `を置いて閉じる。
     */
    rawExtendedOpen?: boolean;
}

/**
 * Textile文書をMarkdownへ変換する。HTMLへは変換しない。
 * 見出し・段落・引用・コード・リスト・表・脚注・インライン記法・文字置換（引用符・ダッシュなど）・コメント（`###.`）を
 * Markdownへ写す。Markdownに記法のない書き方（ヘッダー行のない表・結合セル・`pre.`・定義リスト・略語・引用元・class付きの範囲や
 * リンク）は、Markdown文書のプレビューもTextileとして描画するため、Textileの書き方のまま残す。
 * `notextile`・`div.`・配置や装飾の属性・表の属性行・段落を崩す生HTML・本文に記法を含む脚注は、変換したうえで
 * 実行中の変換（{@link convertDocumentSyntax}）へ「プレビューが変わる行」として報告する。
 * @param source - Textile原文。改行コードと末尾改行は保持される。
 * @returns Markdown原文。
 */
export function convertTextileToMarkdown(source: string): string {
    const document = splitDocument(source);
    const writer = new LineWriter(document.dominantEol);
    const footnoteIds = new Set<string>(documentFootnotes ?? []);
    for (const line of document.lines) {
        const definition = TEXTILE_FOOTNOTE_DEFINITION.exec(line);
        if (definition) footnoteIds.add(definition[1]);
    }
    const state: TextileConversionState = {
        listLevels: [],
        inParagraph: false,
        extendedQuote: false,
        inQuote: false,
        alternateListMarkers: true
    };
    const { lines, eols } = document;
    let index = 0;

    /**
     * 段落・リスト・引用の継続状態を終わらせる。
     */
    function endBlock(): void {
        state.listLevels = [];
        state.inParagraph = false;
        state.listContinuationIndent = undefined;
        state.inQuote = false;
    }

    /**
     * `bq..`の引用の中の空行のあとに、引用の続き（次の段落）があるかを調べる。
     * 次の空でない行がブロックの先頭で署名（`p.`・`h2.`・`bq.`など）または脚注の定義になる場合と、文書の終わりの場合は、
     * 引用はこの空行の前で終わっている（Textileの`bq..`は次の署名まで続く）。
     * @param blankIndex - 空行の行番号。
     * @returns 引用の段落が続く場合はtrue。
     */
    function continuesExtendedQuote(blankIndex: number): boolean {
        let next = blankIndex + 1;
        while (next < lines.length && !lines[next].trim()) next += 1;
        if (next >= lines.length) return false;
        return !parseTextileSignature(lines[next]) && !TEXTILE_FOOTNOTE_DEFINITION.test(lines[next]);
    }

    /**
     * 同じブロック内の前の行にMarkdownの強制改行を付ける。Textileの単一改行は`<br>`になるため。
     * 逆変換モードも同じく行末のバックスラッシュで書く。行末の空白2つは見えず、エディターの末尾空白の削除で失われるため使わない
     * （Markdown→Textileの順変換はどちらの書き方も同じ改行にするため、元の文書が空白2つでも描画は変わらない）。
     * どちらのモードも、原文の行末の空白2つ以上は削ってから`\`を付ける。ただし削ると奇数個の`\`で終わる行は、
     * 付けた`\`とでエスケープになり改行が消えるため、空白を残す。
     */
    function markHardBreak(): void {
        if (!state.inParagraph) return;
        writer.amendLast((text) => {
            if (/\\$/.test(text) || /^\s*>?\s*$/.test(text)) return text;
            // 生HTMLの行（`<div …>`など）の改行は強制改行ではないため、逆変換モードでは印を付けない。
            // 行末の空白2つ以上はMarkdownで強制改行の印になるため削る（Textileでは意味を持たない）。
            if (restoreMode && /^\s*<.*>\s*$/.test(text)) return / {2}$/.test(text) ? text.trimEnd() : text;
            // Textileの行末の空白は意味を持たないが、Markdownでは空白2つ以上が強制改行の印になるため、通常の変換でも
            // 空白2つ以上は削って`\`だけにする（空白1つは描画に影響しないため、順変換は原文のまま残す）。
            if (!restoreMode && !/ {2}$/.test(text)) return `${text}\\`;
            const trimmed = text.trimEnd();
            // 空白を削ると奇数個の`\`で終わる行（`foo\ `）は、付けた`\`と合わせてエスケープ済みの`\`になり改行が消えるため、空白を残す。
            return /(?:^|[^\\])(?:\\\\)*\\$/.test(trimmed) ? `${text}\\` : `${trimmed}\\`;
        });
    }

    /**
     * 指定行から始まるTextile表を読み、Markdown表として出力できれば出力する。
     * @param start - 表の最初の行番号。
     * @returns 表として処理した行数。変換できない表（ヘッダーなし・結合セル・属性行）は0。
     */
    function convertTable(start: number): number {
        let end = start;
        // 行の属性（style・class・配置）はMarkdownの表に書けないため、外して報告し、表の構造は残す。
        while (end < lines.length && (TEXTILE_TABLE_ROW.test(lines[end]) || TEXTILE_TABLE_ROW_ATTRIBUTES.test(lines[end]))) {
            if (TEXTILE_TABLE_ROW_ATTRIBUTES.test(lines[end])) {
                reportUnsupported(end);
                lines[end] = lines[end].replace(TEXTILE_TABLE_ROW_ATTRIBUTES, '$1');
            }
            end += 1;
        }
        const rows = lines.slice(start, end).map(parseTextileTableRow);
        if (rows.some((row) => row === undefined)) return 0;
        const parsedRows = rows as NonNullable<(typeof rows)[number]>[];
        const header = parsedRows[0];
        if (!header.every((cell) => cell.header)) return 0;
        const columnCount = Math.max(...parsedRows.map((row) => row.length));
        const aligns: Array<'left' | 'center' | 'right' | undefined> = [];
        for (let column = 0; column < columnCount; column += 1) {
            aligns.push(parsedRows.map((row) => row[column]?.align).find((align) => align !== undefined));
        }
        const output: string[] = [];
        const renderRow = (row: NonNullable<(typeof rows)[number]>): string =>
            `| ${Array.from({ length: columnCount }, (_, column) => convertTextileInline(row[column]?.text ?? '', footnoteIds).replace(/\|/g, '\\|')).join(' | ')} |`;
        output.push(renderRow(header));
        output.push(`| ${aligns.map((align) => align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---').join(' | ')} |`);
        for (const row of parsedRows.slice(1)) output.push(renderRow(row));
        writer.pushBlock(output, eols[end - 1]);
        return end - start;
    }

    /**
     * コードブロックの本文を集めてMarkdownフェンスとして出力する。
     * @param start - 署名行の番号。
     * @param signature - 解析済みの署名。
     * @returns 消費した行数。
     */
    function convertCodeBlock(start: number, signature: TextileSignature): number {
        const body: string[] = [];
        let end = start + 1;
        if (signature.body) body.push(signature.body);
        if (signature.extended) {
            while (end < lines.length && !parseTextileSignature(lines[end])) {
                body.push(lines[end]);
                end += 1;
            }
            while (body.length > 0 && !body[body.length - 1].trim()) body.pop();
        } else {
            while (end < lines.length && lines[end].trim()) {
                body.push(lines[end]);
                end += 1;
            }
        }
        const lastEol = eols[end - 1];
        if (signature.kind === 'pre') {
            // `pre.`は<code>を含まない整形済みテキストで、Markdownに同じ記法はない。Markdown文書のプレビュー（混在Textile）は
            // Textileの`pre.`を同じ整形済みテキストとして描画するため、Textileの記法のまま書く（HTMLは使わない）。
            let last = end;
            while (last > start + 1 && !lines[last - 1].trim()) last -= 1;
            writer.pushBlock(lines.slice(start, last), eols[last - 1]);
            if (signature.extended && end < lines.length) {
                writer.push('');
                state.rawExtendedOpen = true;
                return end - start;
            }
        } else {
            // Textileの`bc.`はMarkdownのフェンスと構文の意味が同じなので、フェンスへ写す（Markdownのプレビューでは
            // 言語名とコピーボタンの見出し帯が付くが、表示上の装飾の違いだけ）。本文の行頭にあるバッククォートの並びより長いフェンスにする。
            const language = readTextileClass(signature.attributes) ?? '';
            const longest = Math.max(2, ...body.map((text) => /^ {0,3}(`{3,})/.exec(text)?.[1].length ?? 0));
            const fence = '`'.repeat(longest + 1);
            // textile-jsはコード内の文字参照を復号せずに出力するため、表示される文字へ戻してからフェンスの本文にする。
            // 逆変換モード: Markdown→Textileの順変換はブロック数式を言語名mathのコードブロックにするため、その逆として`$$`で囲む。
            const decoded = body.map(decodeCodeEntities);
            if (restoreMode && language === 'math' && !decoded.some((text) => text.includes('$$'))) {
                writer.pushBlock(['$$', ...decoded, '$$'], lastEol);
            } else {
                writer.pushBlock([`${fence}${language}`, ...decoded, fence], lastEol);
            }
        }
        // 複数段落ブロックは後続の署名まで空行を含めて消費しているため、区切りの空行を補う。
        if (signature.extended && end < lines.length) writer.push('');
        return end - start;
    }

    while (index < lines.length) {
        const line = lines[index];
        const eol = eols[index];
        if (activeCollector) activeCollector.line = index;

        // 生HTMLの<pre>は閉じタグまで本文をHTMLテキストとして退避し、<notextile>は閉じタグまで無変換。
        // Textileプレビューはraw pre内を文字どおりのコードとして表示するが、Markdownはそのまま HTML として解釈するため、
        // 実体参照へ退避しないと `<` や `&` を含むコードの表示が変わる。
        // インラインコード（`@<pre>@`など）の中のタグは生HTMLではないため、取り除いてから判定する。
        const rawOpen = /<(pre|notextile)\b[^>]*>/i.exec(line.replace(new RegExp(TEXTILE_INLINE_CODE.source, 'g'), ''));
        if (rawOpen && !new RegExp(`</${rawOpen[1]}\\s*>`, 'i').test(line)) {
            endBlock();
            const closing = new RegExp(`</${rawOpen[1]}\\s*>`, 'i');
            const start = index;
            let closedBlock = false;
            while (index < lines.length) {
                const closed = closing.test(lines[index]);
                index += 1;
                if (closed) {
                    closedBlock = true;
                    break;
                }
            }
            // 閉じない<pre>はTextileでは閉じて描画されるがMarkdownでは後続を巻き込む。<notextile>タグはMarkdownでは消えない。
            if (!closedBlock || rawOpen[1].toLowerCase() === 'notextile') reportUnsupported(start, index);
            const block = lines.slice(start, index);
            const output = rawOpen[1].toLowerCase() === 'pre' ? escapeRawPreBlock(block) : block;
            if (output.length === block.length) output.forEach((text, offset) => writer.push(text, eols[start + offset]));
            else writer.pushBlock(output, eols[index - 1]);
            continue;
        }

        if (!line.trim()) {
            if (state.extendedQuote && continuesExtendedQuote(index)) {
                writer.push('>', eol);
                index += 1;
                continue;
            }
            // 次の本文がブロックの署名（`p.`・`h2.`など）か文書の終わりなら、`bq..`の引用はこの空行の前で終わっている。
            // 引用の中の空行（`>`）にすると、Markdownでは引用の末尾に空の行が残るため、通常の空行として書く。
            state.extendedQuote = false;
            endBlock();
            writer.push(line, eol);
            index += 1;
            continue;
        }

        // Textileのブロック署名（`h2.`・`p.`・`fn1.`など）はブロックの先頭（文書先頭か空行の直後）でだけ認識され、
        // 段落の途中の行では本文の一部になる。
        const atBlockStart = index === 0 || !lines[index - 1].trim();
        if (state.rawExtendedOpen && atBlockStart) {
            state.rawExtendedOpen = false;
            const next = parseTextileSignature(line);
            if (next?.kind === 'p' && !next.extended) {
                // 署名の付いた段落はTextileの書き方のまま残す（Markdown文書のプレビューもTextileの段落として描画する）。
                writer.push(line, eol);
                index += 1;
                continue;
            }
            // 次のブロックはMarkdownの記法へ書き換えるため（Textileの署名のある見出しなども`#`になる）、空の段落を置いて閉じる。
            writer.push('p. ', eol);
            writer.push('', eol);
        }

        // 逆変換モード: Markdown→Textileの順変換は空白だけの段落を文字参照にするため、その逆として空白の文字へ戻す。
        if (restoreMode && atBlockStart && /^(?:&#\d+;)+$/.test(line) && !lines[index + 1]?.trim()) {
            const decoded = line.replace(/&#(\d+);/g, (whole, code: string) => String.fromCodePoint(Number(code)));
            if (!decoded.trim()) {
                endBlock();
                writer.push(decoded, eol);
                index += 1;
                continue;
            }
        }

        // 逆変換モード: Markdown→Textileの順変換は目次の指定（`[TOC]`）をTextileに記法がないため原文のまま書くため、その逆として
        // 退避せずに目次の指定へ戻す。
        if (restoreMode && atBlockStart && /^\[toc\]\s*$/i.test(line) && !lines[index + 1]?.trim()) {
            endBlock();
            writer.push(line, eol);
            index += 1;
            continue;
        }

        // コメント（`###.`は空行まで、`###..`は次の署名まで）。表示されないMarkdownのコメント（`[//]: # "本文"`）へ写す。
        // 文書先頭のコメントがYAML front matterの形（`---`の行で囲む）なら、Markdown→Textileの順変換がfront matterを
        // コメントにした形なので、front matterへ戻す。
        const comment = atBlockStart ? /^###(\.\.?)(?:\s+(.*))?$/.exec(line) : null;
        if (comment) {
            endBlock();
            const body = [comment[2] ?? ''];
            let end = index + 1;
            while (end < lines.length && (comment[1] === '..'
                ? !(parseTextileSignature(lines[end]) || /^(?:###|fn\d+)[^\s.]*\.\.?(?:\s|$)/.test(lines[end]) || TEXTILE_LIST_ITEM.test(lines[end]))
                : lines[end].trim())) {
                body.push(lines[end]);
                end += 1;
            }
            let last = end;
            while (last > index + 1 && !body[last - index - 1].trim()) last -= 1;
            const content = body.slice(0, last - index);
            const startsDocument = lines.slice(0, index).every((text) => !text.trim());
            if (startsDocument && /^---[ \t]*$/.test(content[0]) && content.length >= 2 && /^---[ \t]*$/.test(content[content.length - 1])) {
                content.forEach((text, offset) => writer.push(text, eols[index + offset]));
            } else {
                const paragraphs: string[][] = [[]];
                for (const text of content) {
                    if (!text.trim()) paragraphs.push([]);
                    else paragraphs[paragraphs.length - 1].push(text);
                }
                const output: string[] = [];
                for (const paragraph of paragraphs.filter((item) => item.length > 0)) {
                    const joined = paragraph.join('\n');
                    const quoted = !joined.includes('"') ? `"${joined}"` : !joined.includes("'") ? `'${joined}'` : !/[()]/.test(joined) ? `(${joined})` : undefined;
                    if (quoted === undefined) reportUnsupported(index, end);
                    if (output.length) output.push('');
                    output.push(...`[//]: # ${quoted ?? `"${joined.replace(/"/g, '\\"')}"`}`.split('\n'));
                }
                writer.pushBlock(output, eols[last - 1]);
            }
            // 複数段落のコメントは後続の署名まで空行を含めて消費しているため、区切りの空行を補う。
            if (comment[1] === '..' && end < lines.length) writer.push('');
            index = end;
            continue;
        }

        const signature = atBlockStart ? parseTextileSignature(line) : undefined;
        if (signature) {
            // `div.`と、配置・余白・インラインスタイルの属性（`p<.`、`p(.`、`p{color:red}.`など）はTextileでだけ見た目に反映される。
            // class（`p(cls).`）はスタイルの対象になり得るため同じく報告する。IDだけ（`h2(#id).`）と言語指定（`p[ja].`）は見た目を変えないため対象外。
            if (signature.kind === 'div'
                || /[<>=(){}]/.test(signature.attributes.replace(/\([^()]*[A-Za-z#][^()]*\)|\[[^\]]*\]/g, ''))
                || (signature.kind !== 'bc' && signature.kind !== 'pre' && /\(\s*[^#)\s][^)]*\)/.test(signature.attributes))
                // 見出し以外のID（`p(#id).`）はページ内リンクの移動先になり、言語指定（`p[zh].`）は字形を変え得るが、Markdownでは付けられない。
                // 見出しのIDはプレビューが本文から決め直すため対象外。
                || (!/^h[1-6]$/.test(signature.kind) && /\([^)]*#[^)]*\)/.test(signature.attributes))
                || /\[[^\]]+\]/.test(signature.attributes)) {
                reportUnsupported();
            }
            endBlock();
            state.extendedQuote = false;
            switch (signature.kind) {
                case 'bc':
                case 'pre':
                    index += convertCodeBlock(index, signature);
                    continue;
                case 'notextile': {
                    // 逆変換モード: Markdown→Textileの順変換は、textile-jsが通さないブロック要素（`<details>`・`<table>`など）で
                    // 始まる原文の生HTMLブロックを`notextile.`（空行をまたぐ場合は`notextile..`）に入れるため、その逆として
                    // 本文（原文のHTMLと文字）をそのまま戻す。
                    if (restoreMode && ((isRawHtmlBlockStart(signature.body) && !TEXTILE_BLOCK_HTML.test(signature.body) && /^<[A-Za-z]/.test(signature.body))
                        || (signature.extended && signature.body.startsWith('<!--')))) {
                        let end = index + 1;
                        while (end < lines.length && (signature.extended ? !parseTextileSignature(lines[end]) : lines[end].trim())) end += 1;
                        let last = end;
                        while (last > index + 1 && !lines[last - 1].trim()) last -= 1;
                        writer.pushBlock([signature.body, ...lines.slice(index + 1, last)], eols[last - 1]);
                        if (end < lines.length) writer.push('');
                        index = end;
                        continue;
                    }
                    // notextile本文の生HTMLはTextileでは要素として描画されるが、Markdownへ退避すると文字として表示される。
                    reportUnsupported();
                    if (signature.extended) {
                        writer.push(escapeMarkdownLiteral(signature.body), eol);
                        index += 1;
                        while (index < lines.length && !parseTextileSignature(lines[index])) {
                            reportUnsupported(index);
                            writer.push(escapeMarkdownLiteral(lines[index]), eols[index]);
                            index += 1;
                        }
                        continue;
                    }
                    writer.push(escapeMarkdownLiteral(signature.body), eol);
                    index += 1;
                    while (index < lines.length && lines[index].trim()) {
                        reportUnsupported(index);
                        writer.push(escapeMarkdownLiteral(lines[index]), eols[index]);
                        index += 1;
                    }
                    continue;
                }
                case 'bq': {
                    // 逆変換モード: Markdown→Textileの順変換は注記の引用（`> [!NOTE]`の次の行に本文）の行を空白でつなぐため、
                    // その逆として注記の印を1行目へ戻す（Markdownでは行の連結は空白と同じ表示になる）。
                    const alert = restoreMode && !signature.extended ? /^(\[![A-Za-z]+\])\s+(\S.*)$/.exec(signature.body) : null;
                    if (alert) writer.push(`> ${alert[1]}`, eol);
                    const body = convertTextileInline(alert ? alert[2] : signature.body, footnoteIds);
                    writer.push(`> ${body}`, eol);
                    state.inParagraph = true;
                    state.inQuote = true;
                    state.extendedQuote = signature.extended;
                    index += 1;
                    continue;
                }
                case 'p':
                case 'div': {
                    // 中身のない段落（`p. `）は表示されない。Markdown→Textileの順変換が複数段落ブロックを閉じるために置くため、何も書かない。
                    if (signature.kind === 'p' && !signature.body.trim() && !signature.attributes && !lines[index + 1]?.trim()) {
                        index += 1;
                        continue;
                    }
                    if (startsWithParagraphBreakingHtml(signature.body, true)) reportUnsupported();
                    const body = convertTextileInline(signature.body, footnoteIds);
                    writer.push(escapeMarkdownLineStart(body), eol);
                    state.inParagraph = true;
                    index += 1;
                    continue;
                }
                default: {
                    // IDだけの見出し属性（`h1(#id).`）は、同じ意味のMarkdownの明示ID（`# 見出し {#id}`）へ写す。
                    // それ以外の属性（クラス・配置）は報告済み。
                    // 見出しも空行（またはリスト行）まで続き、続く行は見出しの中の改行になる。Markdownの見出しは1行で改行を書けないため、
                    // 空白でつないで変換できない記法として報告する（HTMLは使わない）。
                    const level = Number(signature.kind.slice(1));
                    const explicitId = /^\(#([^()\s]+)\)$/.exec(signature.attributes)?.[1];
                    let body = convertTextileInline(signature.body, footnoteIds);
                    let end = index + 1;
                    while (end < lines.length && lines[end].trim() && !TEXTILE_LIST_ITEM.test(lines[end])) {
                        if (activeCollector) activeCollector.line = end;
                        reportUnsupported(end);
                        body += ` ${convertTextileInline(lines[end], footnoteIds)}`;
                        end += 1;
                    }
                    writer.pushBlock([`${'#'.repeat(level)} ${body}${explicitId ? ` {#${explicitId}}` : ''}`], eols[end - 1]);
                    index = end;
                    continue;
                }
            }
        }

        // 表・行の属性（`table(cls).`、`{background:#f00}. |…|`など）は表の見た目（style・class）を決めるが、Markdownの表には
        // 書けない。表の構造は同じ意味のMarkdownの表（ヘッダーのない表はTextileの表のまま）へ写し、属性だけを外して報告する。
        const tableSignature = /^\s*table(?:\{[^}]*\}|\([^)]*\)|\[[^\]]*\]|[<>=_^~-])*\.(?:\s|$)/i.test(line);
        if (tableSignature || TEXTILE_TABLE_ROW_ATTRIBUTES.test(line)) {
            endBlock();
            for (let row = tableSignature ? index + 1 : index; row < lines.length && lines[row].trim(); row += 1) {
                const stripped = lines[row].replace(TEXTILE_TABLE_ROW_ATTRIBUTES, '$1');
                if (stripped === lines[row]) continue;
                reportUnsupported(row);
                lines[row] = stripped;
            }
            if (tableSignature) {
                reportUnsupported();
                index += 1;
            }
            continue;
        }

        const footnote = atBlockStart ? TEXTILE_FOOTNOTE_DEFINITION.exec(line) : null;
        if (footnote) {
            // 脚注はTextileとMarkdownで描画様式（番号の位置・戻りリンク・区切り線）が異なるが、構文の意味は同じなので報告しない。
            // ただしMarkdown文書のプレビューは脚注の本文の記法を解釈せず文字のまま表示するため、本文が記法を含む場合は報告する。
            endBlock();
            state.extendedQuote = false;
            const footnoteBody = convertTextileInline(footnote[2], footnoteIds);
            if (!isPlainFootnoteBody(footnoteBody)) reportUnsupported();
            writer.push(`[^${footnote[1]}]: ${footnoteBody}`, eol);
            state.inParagraph = true;
            index += 1;
            continue;
        }

        if (state.extendedQuote) {
            // 逆変換モード: Markdown→Textileの順変換は、引用の中のリストの項目を1行ずつ`bq..`の段落の行にする
            // （Textileは引用の中にリストを書けない）。その逆として、リストの印で始まる行の前には強制改行を付けず、
            // Markdownのリストの項目へ戻す（項目の末尾に強制改行の`\`を付けると、リストの最後の項目では文字として表示されるため付けない）。
            if (!(restoreMode && MARKDOWN_LIST_ITEM_START.test(line))) markHardBreak();
            writer.push(`> ${convertTextileInline(line, footnoteIds)}`, eol);
            state.inParagraph = true;
            index += 1;
            continue;
        }

        if (line.trim() === '---' && !state.inParagraph) {
            endBlock();
            writer.push(line, eol);
            index += 1;
            continue;
        }

        // 定義リスト `- 用語 := 説明`（`*`で始まる表記もtextileAdapterが定義リストへ正規化する）はMarkdownに相当記法がないため
        // 原文のまま残す。Markdown文書のプレビューでは箇条書きとして描画され、定義リストにならない。
        if (/^\s*[-*]\s+.+?\s+:=\s+/.test(line)) {
            reportUnsupported();
            endBlock();
            writer.push(line, eol);
            index += 1;
            continue;
        }

        const listItem = TEXTILE_LIST_ITEM.exec(line);
        if (listItem) {
            const markers = listItem[1];
            // 項目の属性（`#[fr] b`、`*(cls) a`など）はMarkdownのリスト項目に付けられない。開始番号（`#3 a`）は写せるため除く。
            if (/^\s*[*#]+(?:\d+)?(?![*#\s\d])/.test(line)) reportUnsupported();
            const depth = markers.length;
            const ordered = markers[depth - 1] === '#';
            state.inQuote = false;
            if (state.listLevels.length === 0) state.alternateListMarkers = !state.alternateListMarkers;
            while (state.listLevels.length > depth) state.listLevels.pop();
            while (state.listLevels.length < depth - 1) {
                const parent = state.listLevels[state.listLevels.length - 1];
                state.listLevels.push({ ordered: false, count: 0, indent: parent ? parent.indent + parent.width : 0, width: 2 });
            }
            const parent = state.listLevels[depth - 2];
            const indent = parent ? parent.indent + parent.width : 0;
            let level = state.listLevels[depth - 1];
            if (!level || level.ordered !== ordered) {
                level = { ordered, count: 0, indent, width: 2 };
                state.listLevels[depth - 1] = level;
            }
            // 開始番号（`#3 項目`）は、同じ意味のMarkdownの番号（`3.`）へ写す。新しいリストの最初の項目でだけ有効。
            if (ordered && listItem[2] !== undefined && level.count === 0) level.count = Number(listItem[2]) - 1;
            level.count += 1;
            const marker = ordered
                ? `${level.count}${state.alternateListMarkers ? ')' : '.'}`
                : state.alternateListMarkers ? '*' : '-';
            level.width = marker.length + 1;
            const body = convertTextileInline(listItem[3], footnoteIds);
            writer.push(`${' '.repeat(level.indent)}${marker} ${body}`, eol);
            state.inParagraph = true;
            state.listContinuationIndent = ' '.repeat(level.indent + level.width);
            index += 1;
            continue;
        }

        if (TEXTILE_TABLE_ROW.test(line) && !state.inParagraph) {
            endBlock();
            const consumed = convertTable(index);
            if (consumed > 0) {
                index += consumed;
                continue;
            }
            // 変換できない表はTextile行のまま残す（Markdown文書内でもTextile表として描画される）。
            while (index < lines.length && TEXTILE_TABLE_ROW.test(lines[index])) {
                writer.push(lines[index], eols[index]);
                index += 1;
            }
            continue;
        }

        // 通常の段落行（または段落・リスト項目・引用の継続行）
        // 段落の途中にある署名風の行（`h2. x`）と下線風の行（`---`・`===`）はTextileでは本文の一部だが、
        // Markdownのプレビューでは見出し・下線見出しになるため、記号を退避する。
        const body = convertTextileInline(line, footnoteIds)
            .replace(/^((?:p|div|bq|bc|pre|notextile|h[1-6]|fn\d+)[^.\s]*)\./i, '$1\\.')
            .replace(/^( {0,3})([-=])(?=\2*\s*$)/, '$1\\$2');
        if (state.inParagraph) {
            markHardBreak();
            if (state.listContinuationIndent !== undefined) {
                writer.push(`${state.listContinuationIndent}${body}`, eol);
            } else if (state.inQuote) {
                writer.push(`> ${body}`, eol);
            } else {
                writer.push(escapeMarkdownLineStart(body), eol);
            }
        } else {
            if (startsWithParagraphBreakingHtml(line, false)) reportUnsupported();
            writer.push(escapeMarkdownLineStart(body), eol);
            state.inParagraph = true;
        }
        index += 1;
    }
    return writer.toString();
}

/** Markdownのフェンス開始行。グループ: 1=字下げ、2=フェンス、3=情報文字列。 */
const MARKDOWN_FENCE = /^( {0,3})(`{3,}|~{3,})\s*(\S*)?.*$/;

/** MarkdownのATX見出し。グループ: 1=`#`列、2=本文。 */
const MARKDOWN_ATX_HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*(?:(?<=\s)#+\s*)?$/;

/** Markdownのリスト項目。グループ: 1=字下げ、2=マーカー、3=本文。 */
const MARKDOWN_LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*)|\s*$)/;

/**
 * 本文のあるMarkdownのリスト項目の行の始まり（`- 項目`・`1. 項目`）。Textile→Markdownの逆変換で、`bq..`の段落の行が
 * 順変換で引用の中のリストの項目から書かれたものかを見分けるのに使う（空の項目の`-`だけの行は含めない）。
 */
const MARKDOWN_LIST_ITEM_START = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/;

/** Markdownの水平線。 */
const MARKDOWN_THEMATIC_BREAK = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;

/** Markdownの表区切り行。 */
const MARKDOWN_TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** GFMの表の区切り行（各セルのハイフンは1個以上。`|`を含む行だけ）。 */
const GFM_TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * GFMの表の区切り行か判定する。Markdown文書のプレビュー（混在形式）は、Textileの書き方を含む文書ではハイフンが3個以上の区切り行
 * だけをMarkdownの表とし（それ以外はTextileの表）、Markdownだけの文書（{@link markdownOnlyMode}）ではGFMと同じく1個以上で表とする。
 * @param line - 行。
 * @returns 区切り行ならtrue。
 */
function isMarkdownTableSeparator(line: string): boolean {
    return markdownOnlyMode ? line.includes('|') && GFM_TABLE_SEPARATOR.test(line) : MARKDOWN_TABLE_SEPARATOR.test(line);
}

/**
 * 引用の中身（`>`を外した行）のうち、Textileの引用で表せない構造を、原文にない文字を足さない形の行へ整える。
 * - 入れ子の引用（`> > 本文`）: `>`を外し、前後を空行で区切った別の段落にする。
 * - フェンスのコード: フェンスの行を除き、コードの各行を、改行で区切ったインラインのコードにする。
 * - リストの項目: 項目ごとに改行で区切った行にする（項目の記号は本文の文字として残る）。
 * @param inner - 引用の中身の行。
 * @returns 段落（空行で区切る）と、Markdownの強制改行（行末の空白2つ）で区切った行。
 */
function flattenQuoteContent(inner: readonly string[]): string[] {
    const output: string[] = [];
    let fence: string | undefined;
    let nested = false;
    /** 直前の行の末尾に強制改行の印を付け、次の行と連結されないようにする。 */
    const breakPrevious = (): void => {
        const last = output.length - 1;
        if (last >= 0 && output[last].trim() && !/ {2}$/.test(output[last])) output[last] = `${output[last]}  `;
    };
    for (const text of inner) {
        const fenceLine = /^\s*(`{3,}|~{3,})/.exec(text);
        if (fence !== undefined) {
            if (fenceLine && fenceLine[1][0] === fence[0] && fenceLine[1].length >= fence.length) {
                fence = undefined;
                continue;
            }
            breakPrevious();
            // Markdown\u306e\u30a4\u30f3\u30e9\u30a4\u30f3\u306e\u30b3\u30fc\u30c9\u3068\u3057\u3066\u66f8\u304d\u3001\u30a4\u30f3\u30e9\u30a4\u30f3\u306e\u5909\u63db\u3067Textile\u306e\u30b3\u30fc\u30c9\u306b\u3059\u308b\uff08\u7a7a\u306e\u884c\u306f\u66f8\u304b\u306a\u3044\uff09\u3002
            if (text.trim()) output.push(text.includes('`') ? `\`\` ${text.trim()} \`\`` : `\`${text.trim()}\``);
            continue;
        }
        if (fenceLine) {
            fence = fenceLine[1];
            continue;
        }
        const quoted = /^\s*>/.test(text);
        if (quoted !== nested && output.length && output[output.length - 1].trim()) output.push('');
        nested = quoted;
        const body = quoted ? text.replace(/^(?:\s*>\s?)+/, '') : text;
        if (/^\s*(?:[*+-]|\d+[.)])\s/.test(body)) breakPrevious();
        output.push(body);
    }
    return output;
}

/**
 * Markdownのフェンスのコードの1行を、Textileのインラインのコード（`[@…@]`。`@`は文字参照）にする。
 * @param text - コードの行。
 * @returns Textileのコード。
 */
function renderTextileCodeLine(text: string): string {
    return text ? `[@${text.replace(/@/g, '&#64;')}@]` : '';
}

/**
 * GFM表の1行のセルの数を数える。行頭・行末の`|`は区切りに数えず、退避した`\|`はセルの区切りにしない。
 * @param row - 表の行。
 * @returns セルの数。
 */
function countMarkdownTableCells(row: string): number {
    return row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).length;
}

/** Markdownの脚注定義。グループ: 1=ID、2=本文。 */
const MARKDOWN_FOOTNOTE_DEFINITION = /^\[\^([^\]\s]+)\]:\s*(.*)$/;

/** MarkdownのHTMLブロック開始行。 */
const MARKDOWN_HTML_BLOCK_START = /^ {0,3}<(?:[A-Za-z][\w-]*(?:\s|\/?>|$)|!--|\/[A-Za-z])/;

/** Markdownの引用行。グループ: 1=引用記号を除いた本文。 */
const MARKDOWN_QUOTE_LINE = /^ {0,3}>\s?(.*)$/;

/**
 * 行がMarkdownのブロック開始（見出し・フェンス・リスト・引用・水平線・表・HTML）か判定する。
 * 段落の継続行とブロックの境界を決めるために使う。
 * @param line - 判定する行。
 * @returns ブロック開始ならtrue。
 */
function isMarkdownBlockStart(line: string): boolean {
    return MARKDOWN_FENCE.test(line)
        || MARKDOWN_ATX_HEADING.test(line)
        || MARKDOWN_LIST_ITEM.test(line)
        || MARKDOWN_QUOTE_LINE.test(line)
        || MARKDOWN_THEMATIC_BREAK.test(line)
        || MARKDOWN_HTML_INTERRUPT.test(line)
        || MARKDOWN_FOOTNOTE_DEFINITION.test(line);
}

/**
 * 段落を途中で打ち切れるHTMLブロックの開始行（CommonMarkのHTMLブロック種別1〜6）。
 * `<br>`や`<span>`などそれ以外のタグ（種別7）は段落を打ち切れず、段落の続きになる。
 */
const MARKDOWN_HTML_INTERRUPT = /^ {0,3}(?:<(?:script|pre|style|textarea)(?:\s|>|$)|<!--|<\?|<![A-Za-z]|<!\[CDATA\[|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$))/i;

/**
 * Markdownの生HTMLブロックの開始行か判定する。CommonMarkの種別1〜6（ブロック要素のタグなど）と、
 * 種別7（開始タグだけの行。`<svg …>`など。段落の途中では始まらない）を対象にする。
 * @param line - 行。
 * @returns 生HTMLブロックの開始行ならtrue。
 */
function isRawHtmlBlockStart(line: string): boolean {
    return MARKDOWN_HTML_INTERRUPT.test(line) || /^ {0,3}<[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>\s*$/.test(line);
}

/**
 * Textileが段落で包まずにそのまま置くブロック要素（textile-jsの判定に合わせる）。
 * これ以外のタグで始まるMarkdownのHTMLブロックは、Textileでは段落で包まれ余白が変わる。
 */
const TEXTILE_BLOCK_HTML = /^ {0,3}<\/?(?:p|hr|ul|ol|li|div|pre|object|script|noscript|blockquote|notextile)(?:\s|\/?>|$)/i;

/**
 * 段落の行列を、ソフト改行は空白で連結し、強制改行（行末の`\`または2つ以上の空白）は改行として残した行列に整える。
 * @param lines - Markdown段落の本文行。
 * @returns Textileで同じ`<br>`構造になる行列。
 */
function joinSoftBreaks(lines: readonly string[]): string[] {
    const output: string[] = [];
    let current = '';
    let hardBreak = false;
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (current && !hardBreak) current = `${current} ${line}`;
        else if (current) {
            output.push(current);
            current = line;
        } else current = line;
        hardBreak = false;
        // 連結済みの段落全体へ末尾一致の正規表現をかけると行数に比例した走査が毎回走るため、今回の行だけを調べる。
        if (/(?<!\\)\\$/.test(line)) {
            current = current.slice(0, -1);
            hardBreak = true;
        } else if (/ {2,}$/.test(rawLine)) {
            hardBreak = true;
        }
    }
    if (current) output.push(current);
    return output;
}

/**
 * Markdownのリンク先。CommonMarkと同じく、1段の対応する括弧（例: `https://…/A_(b)`）を含められる。
 */
const LINK_DESTINATION = String.raw`(?:[^\s()]|\([^\s()]*\))+`;

/**
 * Markdown→Textileのインライン変換。コード・HTMLタグ・数式は無変換で残す。
 * インライン数式はTextileで描画されないため、変換できない記法として報告する。
 * @param text - Markdown本文の1行。
 * @returns Textileのインライン記法に書き換えた本文。
 */
function convertMarkdownInline(text: string): string {
    return segmentInline(text, [MARKDOWN_INLINE_CODE, MARKDOWN_AUTOLINK, MARKDOWN_INLINE_MATH, HTML_TAG]).map((segment) => {
        if (segment.kind === 'verbatim') {
            // インライン数式はTextileに記法がないため、記法として解釈されない範囲（`==$…$==`）に原文のまま書く。
            // 数式が`==`を含むと範囲がそこで終わるため、変換できない記法として報告する。
            if (segment.value.startsWith('$')) {
                if (segment.value.includes('==')) reportUnsupported();
                // Textileのプレビューは`==…==`の中でも`^…^`・`~…~`を上付き・下付きにするため、`^`と`~`は文字参照にする。
                return `==${segment.value.replace(/\^/g, '&#94;').replace(/~/g, '&#126;')}==`;
            }
            if (segment.value.startsWith('`')) {
                const fenceLength = /^`+/.exec(segment.value)?.[0].length ?? 1;
                let code = segment.value.slice(fenceLength, -fenceLength);
                if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
                // `@code@`はtextile-jsの境界条件（前後の文字）を満たす位置でだけコードになる。満たさない位置（日本語の直後など）は
                // 角括弧の書き方（`[@code@]`）にする。コード内の`@`は文字参照にする（Textileのコードは文字参照を文字として表示する）。
                const body = code.replace(/[\r\n]+/g, ' ').replace(/@/g, '&#64;');
                const bounded = hasPhraseBoundary(text, segment.start, segment.start + segment.value.length);
                // 前後に空白があるコードも、境界のある書き方（`@…@`）では閉じられないため角括弧の書き方にする。
                return bounded && body.length > 0 && !/^\s|\s$/.test(body) ? `@${body}@` : `[@${body}@]`;
            }
            if (segment.value.startsWith('<http')) {
                const url = segment.value.slice(1, -1);
                return `"${url}":${url}`;
            }
            return segment.value;
        }
        return convertMarkdownPhrases(segment.value);
    }).join('');
}

/**
 * TextileのリンクをURLの終端が曖昧にならない形で組み立てる。
 * 通常形式`"text":url`が成立する位置（直前の境界、直後の空白・行末、末尾が句読点でないURL）だけ通常形式を使い、
 * それ以外は境界条件のない角括弧形式`["text":url]`にする。角括弧形式で書けないURLの`]`と空白は百分率符号化する。HTMLは使わない。
 * @param label - リンク文字列（Textile記法へ変換済み）。
 * @param url - リンク先。
 * @param title - 任意のタイトル。
 * @param source - 元の行。直前・直後の文字の判定に使う。
 * @param start - 元の行でのリンク記法の開始位置。
 * @param end - 元の行でのリンク記法の終端位置。
 * @returns Textileリンク。
 */
function renderTextileLink(label: string, url: string, title: string | undefined, source: string, start: number, end: number): string {
    const text = title ? `${label}(${title})` : label;
    // 通常形式は直前の境界と、URL末尾の句読点が落とされないこと、直後が空白か行末であることが必要。
    // textile-jsは、URLの後ろが空白・行末か、ASCIIの記号の並びと空白・行末の位置でリンクを終える（`"x":url.`の`.`はURLに含めない）。
    const plain = hasTextileStartBoundary(source, start)
        && (end >= source.length || /\s/.test(source[end]) || /^[!-/:-@[-`{-~]+(?:\s|$)/.test(source.slice(end, end + 32)))
        && !TEXTILE_URL_TRAILING.test(url[url.length - 1] ?? '')
        && !/\s/.test(url);
    if (plain) return `"${text}":${url}`;
    // 角括弧形式は境界条件を持たないが、URLに`]`や空白を含められないため百分率符号化する（リンク先は同じ）。
    return `["${text}":${url.replace(/[\]\s]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)}]`;
}

/**
 * Markdownのリンク・画像・強調・取り消し線・挿入・ハイライトをTextileへ書き換える。
 * Textileで記法として解釈されてしまう素の記号は`==…==`で退避する。
 * @param text - コードやHTMLタグを含まない本文。
 * @returns Textileへ書き換えた本文。
 */
function convertMarkdownPhrases(text: string): string {
    let output = '';
    let pending = '';
    let cursor = 0;

    /**
     * 記法にならなかった平文を、Textileの文字置換が働かないよう退避して出力へ移す。
     */
    function flush(): void {
        if (!pending) return;
        output += restoreMode ? restoreTextileGlyphs(pending) : protectTextileGlyphs(pending);
        pending = '';
    }
    while (cursor < text.length) {
        const character = text[cursor];
        // 1文字ごとに行末までを複製すると長い段落で二次の計算量になるため、記法の判定に要る範囲だけを切り出す。
        const rest = text.slice(cursor, cursor + PHRASE_SEARCH_LIMIT);

        // バックスラッシュ退避。退避された文字はTextileでも素の文字として残す。
        if (character === '\\' && cursor + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[cursor + 1])) {
            flush();
            // 逆変換モードでは、Textile→Markdownの順変換が付けた退避を外して素の文字へ戻す。
            // ただし外すのは、Textile→Markdownの順変換が付ける退避（{@link TEXTILE_TO_MARKDOWN_ESCAPES}）だけ。
            // それ以外の退避（`\#`など）は原文の書き方なので、文字参照で残して逆変換で戻せるようにする。
            output += restoreMode && TEXTILE_TO_MARKDOWN_ESCAPES.includes(text[cursor + 1]) ? text[cursor + 1] : protectTextileCharacter(text[cursor + 1]);
            cursor += 2;
            continue;
        }

        // Markdown文書に混在するTextileのインライン記法（リンク・画像・参照リンク・class付きspan）は、
        // Markdownのプレビューも既にTextileとして描画しているため、原文のまま残す。
        const textileInline = markdownOnlyMode ? undefined : readMixedTextileInline(text, cursor);
        if (textileInline !== undefined) {
            // 代替文字列付きのTextile画像は、Markdownのプレビューではtitleなし、Textileではtitle付きで描画される。
            if (character === '!' && /^![^\s!()]+\([^)]*\)!/.test(rest)) reportUnsupported();
            flush();
            // 逆変換モード: Textile→Markdownの順変換はclass付きリンクを混在Textileの`"(class). 表示"`の形へ揃えるため、
            // その逆として標準のTextileの`"(class)表示"`へ戻す（Textileではどちらも同じ描画になる）。
            const raw = text.slice(cursor, textileInline);
            // Markdown文書のプレビューは、Textileのリンクの文字列の末尾の`(…)`をtitleとして読まず文字のまま表示する。
            // Textileでも同じ文字列になるよう、末尾の閉じ括弧を文字参照にする（textile-jsはtitleとして読まなくなる）。
            /**
             * Textileのリンクの文字列の末尾の`(…)`を、titleとして読まれない形にする。
             * @param link - Textileのリンクの原文。
             * @returns 末尾の閉じ括弧を文字参照にした原文。
             */
            const literalTitle = (link: string): string => link.replace(/^(\[?"[^"]*?\([^()]*)\)":/, '$1&#41;":');
            output += restoreMode ? literalTitle(raw.replace(/^(\[?"\([^()]*\))\.\s+/, '$1')) : literalTitle(raw);
            cursor = textileInline;
            continue;
        }

        // リンク付き画像 [![alt](src)](url)
        if (rest.startsWith('[![')) {
            const match = new RegExp(String.raw`^\[!\[((?:[^[\]]|\[[^[\]]*\])*)\]\((${LINK_DESTINATION})(?:\s+"([^"]*)")?\)\]\((${LINK_DESTINATION})(?:\s+"[^"]*")?\)`).exec(rest);
            if (match) {
                flush();
                const image = renderTextileImage(match[1], match[2], match[3]);
                // Textileの画像リンク`!src!:url`は、URLの直後が空白か行末で、URLの末尾が句読点でない位置でだけ成立する。
                // それ以外はリンクの文字列に画像を置いた`"!src!":url`（角括弧形式を含む）にする。
                const end = cursor + match[0].length;
                output += (end >= text.length || /\s/.test(text[end])) && !TEXTILE_URL_TRAILING.test(match[4][match[4].length - 1] ?? '') && !/[\s()]/.test(match[4])
                    ? `${image}:${match[4]}`
                    : renderTextileLink(image, match[4], undefined, text, cursor, end);
                cursor += match[0].length;
                continue;
            }
        }

        // 画像 ![alt](src "title")
        if (rest.startsWith('![')) {
            const match = new RegExp(String.raw`^!\[((?:[^[\]]|\[[^[\]]*\])*)\]\((${LINK_DESTINATION})(?:\s+"([^"]*)")?\)`).exec(rest);
            if (match) {
                flush();
                output += renderTextileImage(match[1], match[2], match[3]);
                cursor += match[0].length;
                continue;
            }
            // 参照形式の画像 ![alt][名前]・![alt][]・![名前]。定義の参照先を使ったTextileの画像記法にする。
            const reference = /^!\[((?:[^[\]\r\n]|\[[^[\]\r\n]*\])*)\](?:\[([^[\]\r\n]*)\])?/.exec(rest);
            const after = reference ? rest[reference[0].length] : undefined;
            const definition = reference && (reference[2] !== undefined || (after !== '(' && after !== ':'))
                ? currentReferences.get(normalizeReferenceLabel(reference[2] || reference[1]))
                : undefined;
            if (reference && definition) {
                flush();
                output += renderTextileImage(reference[1], definition.url, definition.title);
                cursor += reference[0].length;
                continue;
            }
        }

        // リンク [text](url "title")
        if (character === '[' && !rest.startsWith('[^')) {
            // 表示文字列は、退避した文字（`\]`など）と1段の入れ子の角括弧を含められる。
            const match = new RegExp(String.raw`^\[((?:\\.|[^[\]\\\r\n]|\[(?:\\.|[^[\]\\\r\n])*\])*)\]\((${LINK_DESTINATION})(?:\s+"([^"]*)")?\)`).exec(rest);
            if (match) {
                const label = match[1];
                // ワークスペース基準のリンク（本拡張が付ける特別なtitle）は、Textileのプレビューも同じtitleで解決するため、titleごと写す。
                flush();
                // Textileのリンク文字列は引用符で囲むため、文字列中の`"`は文字参照にする。空の文字列はTextileのリンクにならないため、
                // リンク先を文字列にして変換できない記法として報告する。
                if (!label.trim()) reportUnsupported();
                const textileLabel = label.trim() ? convertMarkdownPhrases(label).replace(/"/g, '&quot;') : match[2];
                output += renderTextileLink(textileLabel, match[2], match[3], text, cursor, cursor + match[0].length);
                cursor += match[0].length;
                continue;
            }

            // 参照リンク [表示][名前]・[表示][]・[名前]。定義のリンク先とtitleを使ったTextileのリンクにする。
            // 表示文字列は、退避した角括弧（`\]`）と1段の入れ子の角括弧を含められる。
            const reference = /^\[((?:\\.|[^[\]\\\r\n]|\[(?:\\.|[^[\]\\\r\n])*\])+)\](?:\[([^[\]\r\n]*)\])?/.exec(rest);
            const after = reference ? rest[reference[0].length] : undefined;
            const definition = reference && (reference[2] !== undefined || (after !== '(' && after !== ':'))
                ? currentReferences.get(normalizeReferenceLabel(reference[2] || reference[1]))
                : undefined;
            if (reference && definition) {
                flush();
                const textileLabel = convertMarkdownPhrases(reference[1]).replace(/"/g, '&quot;');
                output += renderTextileLink(textileLabel, definition.url, definition.title, text, cursor, cursor + reference[0].length);
                cursor += reference[0].length;
                continue;
            }
        }

        // 素のURL（GFM自動リンク）
        if (/^https?:\/\//.test(rest) && (cursor === 0 || !isWordCharacter(text[cursor - 1]))) {
            const target = readGfmAutolink(text, cursor);
            if (target) {
                flush();
                output += renderTextileLink(target.url, target.url, undefined, text, cursor, target.end);
                cursor = target.end;
                continue;
            }
        }

        // メールアドレス（GFM自動リンク）。Textileは自動リンクしないため、mailto:のリンクとして書く。
        if (/[A-Za-z0-9]/.test(character) && (cursor === 0 || !/[\w.+-]/.test(text[cursor - 1]))) {
            const email = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z0-9]+(?![\w-]|\.\w)/.exec(rest);
            if (email && !/[-_.]$/.test(email[0])) {
                flush();
                output += renderTextileLink(email[0], `mailto:${email[0]}`, undefined, text, cursor, cursor + email[0].length);
                cursor += email[0].length;
                continue;
            }
        }

        // 強調・取り消し線・挿入・ハイライト
        const phrase = readMarkdownPhrase(text, cursor);
        if (phrase) {
            const inner = convertMarkdownPhrases(phrase.inner);
            flush();
            output += renderTextilePhrase(phrase.marker, inner, text, cursor, phrase.end);
            cursor = phrase.end;
            continue;
        }

        pending += character;
        cursor += 1;
    }
    flush();
    return output;
}

/**
 * Markdownフレーズ記法の解析結果。
 */
interface MarkdownPhrase {
    /** 記号（`***`、`**`、`__`、`~~`、`++`、`==`、`*`、`_`、`^`、`~`）。 */
    marker: string;
    /** 記号に囲まれた本文。 */
    inner: string;
    /** 閉じ記号の直後の位置。 */
    end: number;
}

/** Markdownフレーズ記号を長いものから順に並べた一覧。 */
const MARKDOWN_PHRASE_MARKERS = ['***', '___', '**', '__', '~~', '++', '==', '*', '_', '^', '~'] as const;

/**
 * 指定位置から始まるMarkdownフレーズ記法を解析する。
 * CommonMarkの左右フランキング規則を簡略化し、開始記号の直後と閉じ記号の直前が空白でないことを求める。
 * `_`は単語内では記法にしない。
 * @param text - 対象行。
 * @param start - 記号候補の位置。
 * @returns 解析結果。記法として成立しなければundefined。
 */
function readMarkdownPhrase(text: string, start: number): MarkdownPhrase | undefined {
    for (const marker of MARKDOWN_PHRASE_MARKERS) {
        if (!text.startsWith(marker, start)) continue;
        const before = start === 0 ? '' : text[start - 1];
        if (before === marker[0]) continue;
        if (marker[0] === '_' && isWordCharacter(before)) continue;
        const contentStart = start + marker.length;
        if (contentStart >= text.length || /\s/.test(text[contentStart]) || text.startsWith(marker[0], contentStart)) continue;
        const close = findPhraseClose(text, marker, contentStart, (closeIndex, end) =>
            !/\s/.test(text[closeIndex - 1]) && !text.startsWith(marker[0], end) && !(marker[0] === '_' && isWordCharacter(text[end] ?? '')));
        if (close) return { marker, inner: close.inner, end: close.end };
    }
    return undefined;
}

/**
 * Markdownフレーズ記号に対応するTextile記法を組み立てる。
 * Textileの境界条件（記号の前後が単語文字でない）を満たせない位置と、本文が同じ記号の文字で始まるか終わる位置では、
 * Textileの角括弧の書き方（`[*太字*]`）を使う。HTMLは使わない。
 * @param marker - Markdownの記号。
 * @param inner - 変換済みの本文。
 * @param text - 元の行。境界判定に使う。
 * @param start - 記法の開始位置。
 * @param end - 記法の終端位置。
 * @returns Textileのインライン記法。
 */
function renderTextilePhrase(marker: string, inner: string, text: string, start: number, end: number): string {
    // textile-jsは前後の文字が境界条件を満たす位置でだけフレーズを解釈する。満たさない位置（日本語の直後など）では、
    // 境界を明示するTextileの角括弧の書き方（`[*太字*]`）にする。HTMLは使わない。
    const bounded = hasPhraseBoundary(text, start, end);
    /**
     * Textileのフレーズを、境界に応じて角括弧付きで書く。本文が同じ記号の文字で始まるか終わる場合（`_*x*_`の内側が`_x_`になる
     * 場合など）も、記号が続いて区切れなくなる（`___x___`）ため角括弧付きにする（textile-jsは`[`の後の最初の「記号と`]`」で閉じる）。
     * @param open - 開始記号。
     * @param close - 終了記号。
     * @returns フレーズの記法。
     */
    const phrase = (open: string, close: string = open): string => {
        const adjacent = inner.startsWith(open[open.length - 1]) || inner.endsWith(close[0]);
        return bounded && !adjacent ? `${open}${inner}${close}` : `[${open}${inner}${close}]`;
    };
    switch (marker) {
        case '***':
        case '___':
            return phrase('_*', '*_');
        // Markdownの`**`・`*`はTextileの`*`・`_`へ、`__`・`_`はTextileの`**`・`__`（b・i要素。表示は同じ太字・斜体）へ写し、
        // 往復で元の書き方へ戻せるようにする。
        case '**':
            return phrase('*');
        case '__':
            return phrase('**');
        case '*':
            return phrase('_');
        case '_':
            return phrase('__');
        case '~~':
            return phrase('-');
        case '++':
            return phrase('+');
        case '==':
            // Textileに強調表示の記法はないため、意味を表すclass（mark）を付けた範囲（`%(mark)…%`）にする。
            return phrase('%(mark)', '%');
        default:
            return `${marker}${inner}${marker}`;
    }
}

/**
 * Markdownのバックスラッシュ退避で素の文字として書かれた記号を、Textileでも素の文字として残す。
 * Textileでフレーズ・コード・リンク・画像・見出しの記号や文字置換の対象になる文字は文字参照にする。
 * `==…==`（インラインnotextile）は中身にも文字置換が働くため使わない。
 * 退避されていない本文の記号はそのまま残す。Markdown文書のプレビュー（Textile混在描画）も
 * それらをTextile記法として描画するため、保護すると逆にプレビューが変わる。
 * @param character - 退避されていた1文字。
 * @returns Textileで素の文字として表示される文字列。
 */
function protectTextileCharacter(character: string): string {
    return '*_-+@^~%?"\'!#.()[]{}|<>'.includes(character) ? `&#${character.codePointAt(0)};` : character;
}

/**
 * Markdown→Textileの行変換で保持する状態。
 */
interface MarkdownConversionState {
    /** `bq..`などの複数段落ブロックを閉じるため、次の段落に明示的な`p.`署名が必要ならtrue。 */
    needsSignature: boolean;
    /** 脚注IDに割り当てた番号。Textileの脚注は数値IDだけを受け付ける。 */
    footnoteNumbers: Map<string, number>;
}

/**
 * 脚注の本文が、記法を含まない文字だけか判定する。Markdown文書のプレビューは脚注の本文を文字のまま表示し（記法を解釈しない）、
 * Textileは本文の記法と文字置換を解釈するため、記法や文字置換になり得る記号を含む本文は両者で表示の意味が変わる。
 * @param text - 脚注の本文（Markdown側の書き方）。
 * @returns 記号を含まなければtrue。
 */
function isPlainFootnoteBody(text: string): boolean {
    return !/[\\`*_[\]<>~^=+$"'@%!#|{}()&]|--|\.\.\.| - /.test(text);
}

/**
 * Markdown文書をTextileへ変換する。HTMLへは変換しない。
 * 見出し（明示IDを含む）・段落・引用・注記・フェンスコード・字下げコード・リスト・表・水平線・脚注・参照形式リンク・
 * インライン記法・コメント（`[//]: #`）をTextileへ写し、Textileの文字置換が働く記号は文字参照にする。
 * Textileに描画の記法がない図・数式は言語名付きのコードブロック、インライン数式・タスクリストの印・目次の指定は原文の文字、
 * front matterはコメントにする。Markdown文書に混在するTextile記法（Markdownだけの文書として扱う指定がない場合）と
 * 原文の生HTMLはそのまま残す（textile-jsが通さない要素の生HTMLは`notextile.`に入れる）。
 * 入れ子の引用・リスト項目の中のブロック・本文に記法を含む脚注・front matterは、変換したうえで
 * 実行中の変換（{@link convertDocumentSyntax}）へ「プレビューが変わる行」として報告する。
 * @param source - Markdown原文。改行コードと末尾改行は保持される。
 * @returns Textile原文。
 */
export function convertMarkdownToTextile(source: string): string {
    const document = splitDocument(source);
    const writer = new LineWriter(document.dominantEol);
    const { lines, eols } = document;
    const state: MarkdownConversionState = { needsSignature: false, footnoteNumbers: new Map() };
    for (const id of documentFootnotes ?? []) if (!state.footnoteNumbers.has(id)) state.footnoteNumbers.set(id, state.footnoteNumbers.size + 1);
    for (const line of lines) {
        const definition = MARKDOWN_FOOTNOTE_DEFINITION.exec(line);
        if (definition && !state.footnoteNumbers.has(definition[1])) {
            state.footnoteNumbers.set(definition[1], state.footnoteNumbers.size + 1);
        }
    }
    // 参照形式のリンク（`[text][label]`・`[label]`と`[label]: url`）は、同じ意味のTextileのリンク（`"text":url`）へ写す
    // （{@link convertMarkdownPhrases}）。定義の行は表示されないため書かない。
    currentReferences = new Map();
    for (const reference of documentReferences ?? collectLinkReferences(source)) currentReferences.set(normalizeReferenceLabel(reference.label), reference);

    /**
     * 脚注参照 `[^id]` をTextileの `[n]` に置き換える。定義がない参照は原文のまま残す。
     * @param text - 変換済みのインライン本文。
     * @returns 脚注参照を置き換えた本文。
     */
    function replaceFootnoteReferences(text: string): string {
        return text.replace(/\[\^([^\]\s]+)\]/g, (whole, id: string) => {
            const number = state.footnoteNumbers.get(id);
            return number === undefined ? whole : `[${number}]`;
        });
    }

    /**
     * インライン変換と脚注参照の置換をまとめて行う。
     * @param text - Markdown本文。
     * @returns Textile本文。
     */
    function inline(text: string): string {
        return replaceFootnoteReferences(convertMarkdownInline(text));
    }

    /**
     * 段落本文がTextileでブロック記法と誤解される場合、または直前の複数段落ブロックを閉じる必要がある場合に`p.`署名を付ける。
     * @param firstLine - 段落の1行目（変換済み）。
     * @param originalLine - 段落の1行目（変換前のMarkdown原文）。
     * @param originalNext - 段落の2行目（変換前のMarkdown原文）。1行だけの段落はundefined。
     * @returns 署名を付けた1行目。
     */
    function paragraphLead(firstLine: string, originalLine: string, originalNext: string | undefined): string {
        // 空白だけ（全角空白など）の段落は、Markdownでは空白の段落として表示されるが、Textileは表示しない。
        // 空白を文字参照にして同じ段落を表示する（Textile→Markdownの逆変換で文字へ戻す）。
        const visible = originalLine.replace(/^[ \t]+|[ \t]+$/g, '');
        if (!visible.trim() && visible.length > 0 && originalNext === undefined) {
            state.needsSignature = false;
            return [...visible].map((character) => `&#${character.codePointAt(0)};`).join('');
        }
        // Markdown文書のプレビュー（Textile混在描画）は行頭のTextileブロック署名と表行をTextileとして描画する。
        // 同じ見た目を保つため、それらは署名を付けずにTextileのブロックとして残す。ただし2行目がGFMの区切り行の形の場合は、
        // GFMの表として読まれ（セルの数が合わず表にならなければ段落になり）、Textileの表としては描画されない。
        if (!markdownOnlyMode && (parseTextileSignature(originalLine) !== undefined
            || (TEXTILE_TABLE_ROW.test(originalLine) && !(originalNext !== undefined && MARKDOWN_TABLE_SEPARATOR.test(originalNext))))) {
            state.needsSignature = false;
            return firstLine;
        }
        const needs = state.needsSignature
            || parseTextileSignature(firstLine) !== undefined
            || TEXTILE_LIST_ITEM.test(firstLine)
            || TEXTILE_TABLE_ROW.test(firstLine)
            || TEXTILE_FOOTNOTE_DEFINITION.test(firstLine)
            || /^\s*-\s+.+?\s+:=\s+/.test(firstLine)
            || firstLine.trim() === '---';
        state.needsSignature = false;
        return needs ? `p. ${firstLine}` : firstLine;
    }

    let index = 0;
    // 文書先頭のYAML front matter（Marp・メタデータの指定）は、Textileに同じ記法がないため、表示されないTextileのコメント
    // （`###.`、空行を含む場合は`###..`）として原文を書く。Textile→Markdownの変換は、文書先頭のコメントがfront matterの形なら
    // front matterへ戻す。
    if (lines[0]?.trim() === '---') {
        let end = 1;
        while (end < lines.length && lines[end].trim() !== '---') end += 1;
        if (end < lines.length) {
            // Markdown文書のプレビューはfront matterを水平線と見出しとして表示するため、変換器としては表示が変わる行として報告する
            // （変換タブはfront matterを比較の対象から外して扱う。webview/markdown/conversionWithFallback）。
            reportUnsupported(0, end + 1);
            const extended = lines.slice(0, end + 1).some((text) => !text.trim());
            writer.pushBlock([`###${extended ? '..' : '.'} ${lines[0]}`, ...lines.slice(1, end + 1)], eols[end]);
            index = end + 1;
            if (extended) {
                // `###..`は次の署名まで続くため、空の段落`p. `を置いて閉じる。
                writer.push('', eols[end]);
                writer.push('p. ', eols[end]);
            }
        }
    }

    /**
     * コード本文をTextileのコードブロック（`bc.`、空行を含む本文は`bc..`）として出力する。言語は`bc(言語).`で書く。HTMLは使わない。
     * Markdownのコードブロックに付く見出し帯（言語名とコピーボタン）はTextileでは付かないが、構文の意味は同じなので`bc.`へ写す。
     * 図（mermaid）と数式（math）も、Textileに描画の記法がないため、言語名付きのコードブロックとして原文を書く。
     * 言語名がTextileの属性（`(class)`）として書けない文字を含む場合は言語名を付けない。
     * `bc..`は次の署名まで続くため、後ろが段落・見出し以外のブロック（リスト・表など）なら、空の段落`p. `を置いて閉じる。
     * @param body - コード本文の行。
     * @param language - 言語名。空文字なら指定しない。
     * @param lastEol - 最後の行に続く改行コード。
     * @param nextLine - コードブロックの後ろにある最初の空でない行。文書の末尾ならundefined。
     */
    function emitCodeBlock(body: readonly string[], language: string, lastEol: string, nextLine: string | undefined): void {
        const extended = body.some((text) => !text.trim());
        const nextIsSafe = nextLine === undefined || MARKDOWN_ATX_HEADING.test(nextLine) || !isMarkdownBlockStart(nextLine);
        const name = /^[\w+.-]*$/.test(language) ? language : '';
        writer.pushBlock([`bc${name ? `(${name})` : ''}.${extended ? '.' : ''} ${body[0] ?? ''}`, ...body.slice(1)], lastEol);
        if (!extended) return;
        if (nextIsSafe) {
            // 後ろの段落には明示的な`p.`を付けて閉じる。
            state.needsSignature = true;
            return;
        }
        writer.push('', lastEol);
        writer.push('p. ', lastEol);
    }

    /**
     * 指定行以降で最初の空でない行を返す。
     * @param from - 探し始める行。
     * @returns 行。文書の末尾までなければundefined。
     */
    function nextNonBlankLine(from: number): string | undefined {
        for (let cursor = from; cursor < lines.length; cursor += 1) if (lines[cursor].trim()) return lines[cursor];
        return undefined;
    }

    while (index < lines.length) {
        const line = lines[index];
        const eol = eols[index];
        if (activeCollector) activeCollector.line = index;

        // CommonMarkの空行は空白とタブだけの行。全角空白などだけの行は段落になるため、空行として扱わない。
        if (/^[ \t]*$/.test(line)) {
            writer.push(line, eol);
            index += 1;
            continue;
        }

        // Markdownは空行なしで続く見出し・引用・リスト・表などを別のブロックとして扱うが、Textileのブロックは空行まで続き、
        // 次の行が前のブロックへ取り込まれる（例: `## 概要`の次の行が見出しの一部になる）。各反復は1つのブロックを処理するため、
        // 直前の出力が空行でなければ空行を補ってブロックを区切る。
        if (writer.last()?.trim()) writer.push('');

        // フェンスコード
        const fence = MARKDOWN_FENCE.exec(line);
        if (fence) {
            const fenceMarker = fence[2];
            const language = (fence[3] ?? '').trim();
            const body: string[] = [];
            let end = index + 1;
            while (end < lines.length) {
                const candidate = lines[end];
                const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(candidate);
                if (closing && closing[1][0] === fenceMarker[0] && closing[1].length >= fenceMarker.length) break;
                body.push(candidate.startsWith(fence[1]) ? candidate.slice(fence[1].length) : candidate);
                end += 1;
            }
            const closed = end < lines.length;
            const lastEol = eols[closed ? end : end - 1];
            state.needsSignature = false;
            if (!closed) {
                // 閉じられていないフェンスは、Markdownでは文書の末尾までがコードになる。同じ意味のコードブロックにする
                // （逆変換では閉じたフェンスになる）。
                emitCodeBlock(body, language, eols[end - 1], undefined);
                index = end;
                continue;
            }
            emitCodeBlock(body, language, lastEol, nextNonBlankLine(end + 1));
            index = end + 1;
            continue;
        }

        // 字下げコードブロック（4スペースまたはタブ）。段落・リストの継続行はそれぞれの処理が先に消費する。
        if (/^(?: {4}|\t)/.test(line)) {
            const body: string[] = [];
            let end = index;
            let lastCode = index;
            while (end < lines.length && (/^(?: {4}|\t)/.test(lines[end]) || !lines[end].trim())) {
                if (lines[end].trim()) lastCode = end;
                end += 1;
            }
            for (let cursor = index; cursor <= lastCode; cursor += 1) body.push(lines[cursor].replace(/^(?: {4}|\t)/, ''));
            state.needsSignature = false;
            emitCodeBlock(body, '', eols[lastCode], nextNonBlankLine(lastCode + 1));
            index = lastCode + 1;
            continue;
        }

        // コメント（`[//]: # "本文"`。本文は複数行にできる）は、表示されないTextileのコメント（`###.`）へ写す。
        const commentStart = /^ {0,3}\[\/\/\]:\s*#\s+(["'(])/.exec(line);
        if (commentStart) {
            const close = commentStart[1] === '(' ? ')' : commentStart[1];
            let end = index;
            let joined = line;
            while (!MARKDOWN_COMMENT_DEFINITION.test(joined) && end + 1 < lines.length && lines[end + 1].trim() && !joined.trimEnd().endsWith(close)) {
                end += 1;
                joined += `\n${lines[end]}`;
            }
            const comment = MARKDOWN_COMMENT_DEFINITION.exec(joined);
            if (comment) {
                const body = (comment[1] ?? comment[2] ?? comment[3] ?? '').split('\n');
                writer.pushBlock([`###. ${body[0]}`, ...body.slice(1)], eols[end]);
                state.needsSignature = false;
                index = end + 1;
                continue;
            }
        }

        // 参照リンクの定義（`[名前]: URL "title"`）。参照側でリンク先を直接書くため、表示されない定義の行は書かない。
        if (MARKDOWN_REFERENCE_DEFINITION.exec(line)?.[1] !== undefined && !MARKDOWN_COMMENT_DEFINITION.test(line)) {
            while (index < lines.length && MARKDOWN_REFERENCE_DEFINITION.exec(lines[index])?.[1] !== undefined && !MARKDOWN_COMMENT_DEFINITION.test(lines[index])) {
                index += 1;
            }
            state.needsSignature = false;
            continue;
        }

        // 目次マーカーはMarkdownのプレビューでだけ見出し一覧になる。
        if (/^\[toc\]\s*$/i.test(line)) {
            // Textileに目次の記法はないため、目次の指定を原文のまま書く（逆変換で同じ指定へ戻る）。
            writer.push(line, eol);
            index += 1;
            continue;
        }

        // ブロック数式はTextileに描画の記法がないため、数式の原文を言語名mathのコードブロック（`bc(math).`）にする。
        if (/^\s*\$\$/.test(line)) {
            const single = /^\s*\$\$(.*)\$\$\s*$/.exec(line);
            let end = index + 1;
            let body: string[];
            if (single) {
                body = [single[1].trim()];
            } else {
                while (end < lines.length && !/\$\$\s*$/.test(lines[end])) end += 1;
                const closed = end < lines.length;
                body = [line.replace(/^\s*\$\$/, ''), ...lines.slice(index + 1, closed ? end : end)].filter((text, position) => position > 0 || text.trim());
                if (closed) {
                    const lastLine = lines[end].replace(/\$\$\s*$/, '');
                    if (lastLine.trim()) body.push(lastLine);
                }
                end = Math.min(end + 1, lines.length);
            }
            state.needsSignature = false;
            emitCodeBlock(body, 'math', eols[end - 1], nextNonBlankLine(end));
            index = end;
            continue;
        }

        // textile-jsが生HTMLとして通さない要素（`<details>`・`<table>`など）で始まるHTMLブロックは、原文のHTMLのまま
        // `notextile.`に入れる（Textileはそのまま書くと文字として表示する）。空行をまたいで閉じタグまで続く場合は、
        // 中の文字も含めて複数段落の`notextile..`に入れる（Textileでは空行で分けると要素が途中で閉じるため）。
        // 中の文字はTextileでも文字のまま表示される（Markdownの記法は解釈されないため、違いは描画の比較で検出する）。
        // 空行をまたぐHTMLコメントも、Textileでは空行で分かれて本文として表示されるため、同じく`notextile..`に入れる。
        if (/^ {0,3}<!--/.test(line) && !line.includes('-->')) {
            let close = index + 1;
            while (close < lines.length && !lines[close].includes('-->')) close += 1;
            if (close < lines.length && lines.slice(index, close).some((text) => !text.trim())) {
                writer.pushBlock([`notextile.. ${line.trimStart()}`, ...lines.slice(index + 1, close + 1)], eols[close]);
                index = close + 1;
                const next = nextNonBlankLine(index);
                if (next === undefined || MARKDOWN_ATX_HEADING.test(next) || !isMarkdownBlockStart(next)) {
                    state.needsSignature = true;
                } else {
                    writer.push('', eols[close]);
                    writer.push('p. ', eols[close]);
                }
                continue;
            }
        }
        const htmlOpen = /^ {0,3}<([A-Za-z][\w-]*)\b[^<>]*>/.exec(line);
        if (htmlOpen && isRawHtmlBlockStart(line) && !TEXTILE_BLOCK_HTML.test(line)) {
            const name = htmlOpen[1].toLowerCase();
            let depth = 0;
            let close = -1;
            for (let cursor = index; cursor < lines.length && close < 0; cursor += 1) {
                for (const tag of lines[cursor].matchAll(new RegExp(String.raw`<(/?)${name}\b[^<>]*>`, 'gi'))) {
                    depth += tag[1] ? -1 : 1;
                    if (depth === 0) {
                        close = cursor;
                        break;
                    }
                }
            }
            // 空行を含まないブロックは、空行までを1つの`notextile.`に入れる（閉じタグがなくても、Markdownと同じく空行で終わる）。
            if (close < 0 || !lines.slice(index, close).some((text) => !text.trim())) {
                let blockEnd = index;
                while (blockEnd < lines.length && lines[blockEnd].trim()) blockEnd += 1;
                writer.pushBlock([`notextile. ${line.trimStart()}`, ...lines.slice(index + 1, blockEnd)], eols[blockEnd - 1]);
                state.needsSignature = false;
                index = blockEnd;
                continue;
            }
            if (close > index) {
                writer.pushBlock([`notextile.. ${line.trimStart()}`, ...lines.slice(index + 1, close + 1)], eols[close]);
                index = close + 1;
                // `notextile..`は次の署名まで続くため、後ろの段落には`p.`を付け、段落以外のブロックの前には空の段落を置いて閉じる。
                const next = nextNonBlankLine(index);
                if (next === undefined || MARKDOWN_ATX_HEADING.test(next) || !isMarkdownBlockStart(next)) {
                    state.needsSignature = true;
                } else {
                    writer.push('', eols[close]);
                    writer.push('p. ', eols[close]);
                }
                continue;
            }
        }

        // HTMLブロックは空行まで（pre/script/style/textareaは閉じタグまで）無変換。
        if (MARKDOWN_HTML_BLOCK_START.test(line)) {
            // ページ区切りはMarkdownプレビューでだけ区切り表示になる。
            // Textileが段落で包むタグ（<br>・<img>・<table>など）で始まるブロックは、余白と構造が変わる。
            // インライン要素で始まる行は、Textileが段落で包んでも本文としての意味は同じなので報告しない。
            // ページ区切りの指定（`<!-- pagebreak -->`）はTextileでも表示されないコメントとして原文のまま書く（逆変換で同じ指定へ戻る）。
            if (!/^ {0,3}<!--/.test(line) && !TEXTILE_BLOCK_HTML.test(line) && !INLINE_HTML_LINE.test(line)) reportUnsupported();
            // pre/script/style/textareaとHTMLコメントは、Markdownでは空行をまたいで閉じタグ（`-->`）まで続き、閉じタグの行で終わる
            // （同じ行で閉じるコメントの次の行は、空行がなくても別のブロック）。
            const rawTag = /^ {0,3}<(pre|script|style|textarea)\b/i.exec(line)?.[1];
            const comment = /^ {0,3}<!--/.test(line);
            const closing = rawTag ? new RegExp(`</${rawTag}\\s*>`, 'i') : comment ? /-->/ : undefined;
            const blockStart = index;
            while (index < lines.length && lines[index].trim()) {
                writer.push(lines[index], eols[index]);
                const closed = closing?.test(lines[index]);
                index += 1;
                if (closing && closed) break;
                if (!closing) continue;
            }
            if (closing) {
                // 閉じタグまでは空行を含めて無変換で残す。
                let reached = closing.test(writer.last() ?? '');
                while (!reached && index < lines.length) {
                    writer.push(lines[index], eols[index]);
                    reached = closing.test(lines[index]);
                    index += 1;
                }
                // Textileのプレビューは描画単位を空行で区切るため、空行をまたぐ生HTML（scriptなど）は途中で分断され、
                // 閉じていない要素は後続を巻き込む。生HTMLの`<pre>`は、Textileのプレビューも閉じタグまでを1つの単位にするため対象外。
                const spansBlankLine = rawTag?.toLowerCase() !== 'pre' && lines.slice(blockStart, index).some((text) => !text.trim());
                if (!reached || spansBlankLine) reportUnsupported(blockStart, index);
            }
            state.needsSignature = false;
            continue;
        }

        // ATX見出し
        const heading = MARKDOWN_ATX_HEADING.exec(line);
        if (heading) {
            const level = heading[1].length;
            let text = heading[2] ?? '';
            const explicitId = /\s+\{#([^}]+)\}\s*$/.exec(text);
            if (explicitId) {
                // 見出しの明示IDは、構文の意味が同じTextileの`h1(#id).`へ写す（プレビューは見出しIDを本文から決める）。
                text = text.slice(0, explicitId.index);
            }
            writer.push(`h${level}${explicitId ? `(#${explicitId[1]})` : ''}. ${inline(text)}`, eol);
            state.needsSignature = false;
            index += 1;
            continue;
        }

        // 水平線
        if (MARKDOWN_THEMATIC_BREAK.test(line)) {
            writer.push('---', eol);
            state.needsSignature = false;
            index += 1;
            continue;
        }

        // 引用
        if (MARKDOWN_QUOTE_LINE.test(line)) {
            const inner: string[] = [];
            let end = index;
            while (end < lines.length && (MARKDOWN_QUOTE_LINE.test(lines[end]) || (lines[end].trim() && inner.length > 0 && inner[inner.length - 1].trim() && !isMarkdownBlockStart(lines[end])))) {
                inner.push(MARKDOWN_QUOTE_LINE.exec(lines[end])?.[1] ?? lines[end]);
                end += 1;
            }
            // 入れ子の引用、引用内のリスト・コード・見出し・表はTextileの引用で表せない。
            // 注記（`[!NOTE]`）は、Textileに記法がないため引用の中の文字として書く（逆変換で同じ書き方へ戻る）。
            if (inner.some((text) => isMarkdownBlockStart(text) || /^\s*(?: {4}|\t)\S/.test(text) || MARKDOWN_TABLE_SEPARATOR.test(text))) {
                reportUnsupported(index, end);
            }
            // 表せない構造は、原文にない文字を本文へ足さない形で引用の中へ書く。入れ子の引用は`>`を外した別の段落、
            // コードはフェンスを外したコードの行（項目の中の改行に続ける）、リストの項目は改行に続けた行にする。
            const flattened = flattenQuoteContent(inner);
            const paragraphs: string[][] = [];
            let current: string[] = [];
            for (const text of flattened) {
                if (!text.trim()) {
                    if (current.length) paragraphs.push(current);
                    current = [];
                } else current.push(text);
            }
            if (current.length) paragraphs.push(current);
            const converted = paragraphs.map((paragraph) => joinSoftBreaks(paragraph).map(inline));
            const output: string[] = [];
            if (converted.length <= 1) {
                const [first = [''], ...rest] = converted[0] ?? [['']];
                output.push(`bq. ${first}`, ...(rest as string[]));
                state.needsSignature = false;
            } else {
                converted.forEach((paragraph, paragraphIndex) => {
                    if (paragraphIndex > 0) output.push('');
                    output.push(...(paragraphIndex === 0 ? [`bq.. ${paragraph[0]}`, ...paragraph.slice(1)] : paragraph));
                });
                state.needsSignature = true;
            }
            writer.pushBlock(output, eols[end - 1]);
            index = end;
            continue;
        }

        // 逆変換モード: Textile→Markdownの順変換は定義リスト（`- 用語 := 定義`）をMarkdownに記法がないため原文のまま書くため、
        // その逆として、すべての項目が定義リストの形の`-`の箇条書きは原文のまま戻す。
        if (restoreMode && /^- \S.*? := \S/.test(line)) {
            let end = index;
            while (end < lines.length && /^- \S.*? := \S/.test(lines[end])) end += 1;
            if (end >= lines.length || !lines[end].trim()) {
                writer.pushBlock(lines.slice(index, end), eols[end - 1]);
                state.needsSignature = false;
                index = end;
                continue;
            }
        }

        // リスト
        if (MARKDOWN_LIST_ITEM.test(line)) {
            const indents: number[] = [];
            let end = index;
            let previousItemLine: string | undefined;
            // 項目の中で開いているフェンスの記号（`` ``` ``など）。閉じるまでの行は原文の文字として書く。
            let itemFence: string | undefined;
            // 空行の後に続く項目の中の段落の1行目なら、前の行とつながず、項目の中の改行に続けて書く。
            let paragraphBreak = false;
            const topOrdered = /\d/.test(MARKDOWN_LIST_ITEM.exec(line)?.[2] ?? '');
            while (end < lines.length) {
                const candidate = lines[end];
                // 項目の中のフェンスの空行は、Textileの項目の中に空行を書けない（リストが終わる）ため書かない（報告済み）。
                if (itemFence !== undefined && !candidate.trim()) {
                    end += 1;
                    continue;
                }
                const item = itemFence === undefined ? MARKDOWN_LIST_ITEM.exec(candidate) : null;
                if (item) {
                    const indent = item[1].replace(/\t/g, '    ').length;
                    while (indents.length && indent < indents[indents.length - 1]) indents.pop();
                    const newLevel = !indents.length || indent > indents[indents.length - 1];
                    if (newLevel) indents.push(indent);
                    const depth = indents.length;
                    const ordered = /\d/.test(item[2]);
                    // 番号付きリストの開始番号（`3.`）は、同じ意味のTextileの`#3 項目`へ写す（最上位のリストの最初の項目だけ）。
                    const start = ordered && depth === 1 && end === index ? Number.parseInt(item[2], 10) : 1;
                    const marker = (ordered ? '#' : '*').repeat(depth) + (start !== 1 ? String(start) : '');
                    const body = (item[3] ?? '').replace(/(?<!\\)\\$/, '').replace(/ {2,}$/, '');
                    // タスクリストの印（`[ ]`・`[x]`）は、Textileにチェックボックスの記法がないため項目の文字として書く
                    // （逆変換で同じ印へ戻る）。入れ子のリストの開始番号はTextileで書けないため報告する。
                    if (ordered && depth > 1 && newLevel && !/^0*1[.)]$/.test(item[2])) reportUnsupported(end);
                    if (activeCollector) activeCollector.line = end;
                    previousItemLine = `${marker} ${inline(body)}`;
                    writer.push(previousItemLine, eols[end]);
                    end += 1;
                    continue;
                }
                if (!candidate.trim()) {
                    // 空行の後に次の項目が続く場合は同じリストとして続ける（Textileは連続行で1つのリストになる）。
                    let next = end + 1;
                    while (next < lines.length && !lines[next].trim()) next += 1;
                    const nextItem = MARKDOWN_LIST_ITEM.exec(lines[next] ?? '');
                    const nextIndent = (nextItem?.[1] ?? '').replace(/\t/g, '    ').length;
                    if (nextItem && (nextIndent > indents[0] || /\d/.test(nextItem[2]) === topOrdered)) {
                        // 空行で区切った項目は「ゆるいリスト」になり、Markdownは各項目を段落で包んで行間を広げる。項目の並びと内容は
                        // 同じ意味で、行間の違いは表示上の装飾なので、Textileの1つのリストとして続ける（逆変換は空行のないリストになる）。
                        end = next;
                        continue;
                    }
                    // 空行の後に字下げした本文が続く場合は項目内の段落（またはコードなどのブロック）。Textileの項目は段落を分けられない
                    // ため、項目の中の段落は項目の中の改行に続けて書く（同じ項目の中の別の行という意味は同じ）。項目の中のブロックは、
                    // 下の継続行の処理で変換できない記法として報告する。
                    if (next < lines.length && /^\s+\S/.test(lines[next])) {
                        end = next;
                        paragraphBreak = true;
                        continue;
                    }
                    break;
                }
                if (itemFence === undefined && (previousItemLine === undefined || isMarkdownBlockStart(candidate.trimStart()) && !/^\s/.test(candidate))) break;
                // 項目内のフェンス・引用・見出し・表などのブロックはTextileのリスト項目では表せない。変換できない記法として報告し、
                // 内容が読めるよう、項目の中の改行に続けて原文の行を記法として解釈されない範囲（`==…==`）に書く。
                // フェンスは閉じるまでの行を対象にし、その後ろの項目の中の段落は通常どおり変換する。
                if (itemFence !== undefined || isMarkdownBlockStart(candidate.trimStart()) || MARKDOWN_TABLE_SEPARATOR.test(candidate)) {
                    reportUnsupported(end);
                    const fenceLine = /^(`{3,}|~{3,})/.exec(candidate.trim());
                    if (itemFence === undefined) itemFence = fenceLine?.[1];
                    else if (fenceLine && fenceLine[1][0] === itemFence[0] && fenceLine[1].length >= itemFence.length && !candidate.trim().slice(fenceLine[1].length).trim()) itemFence = undefined;
                    if (activeCollector) activeCollector.line = end;
                    // 原文にない文字を足さないよう、フェンスの行は書かず、コードの行はコード、引用の行は`>`を外した本文にする。
                    const trimmed = candidate.trim();
                    const fenceOnly = /^(`{3,}|~{3,})/.test(trimmed);
                    if (!fenceOnly) writer.push(itemFence !== undefined ? renderTextileCodeLine(trimmed) : inline(trimmed.replace(/^(?:>\s?)+/, '')), eols[end]);
                    end += 1;
                    continue;
                }
                // 項目の継続行。ソフト改行は空白で連結し、強制改行は改行のまま残す。
                const previousRaw = lines[end - 1];
                const hard = paragraphBreak || /(?<!\\)\\$/.test(previousRaw.trimEnd()) || / {2,}$/.test(previousRaw);
                paragraphBreak = false;
                if (activeCollector) activeCollector.line = end;
                const body = inline(candidate.trim().replace(/(?<!\\)\\$/, ''));
                if (hard) writer.push(body, eols[end]);
                else writer.amendLast((text) => `${text} ${body}`);
                end += 1;
            }
            state.needsSignature = false;
            index = end;
            continue;
        }

        // GFM表。見出し行と区切り行のセルの数が違う場合、GFMは表にしない（段落として表示する）。
        if (line.includes('|') && index + 1 < lines.length && isMarkdownTableSeparator(lines[index + 1])
            && countMarkdownTableCells(line) === countMarkdownTableCells(lines[index + 1])) {
            const splitRow = (row: string): string[] => {
                const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
                return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
            };
            const header = splitRow(line);
            const aligns = splitRow(lines[index + 1]).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? '=' : cell.endsWith(':') ? '>' : cell.startsWith(':') ? '<' : '');
            // Textileの表はコードの中でも`|`でセルを区切るため、セル内容の`|`は文字参照にする。
            const cellText = (cell: string): string => inline(cell).replace(/\|/g, '&#124;');
            const output = [`|${header.map((cell, column) => `_${aligns[column] ?? ''}. ${cellText(cell)}`).join('|')}|`];
            let end = index + 2;
            while (end < lines.length && lines[end].trim() && lines[end].includes('|') && !isMarkdownBlockStart(lines[end])) {
                if (activeCollector) activeCollector.line = end;
                const cells = splitRow(lines[end]);
                output.push(`|${header.map((_, column) => `${aligns[column] ? `${aligns[column]}. ` : ''}${cellText(cells[column] ?? '')}`).join('|')}|`);
                end += 1;
            }
            writer.pushBlock(output, eols[end - 1]);
            state.needsSignature = false;
            index = end;
            continue;
        }

        // 脚注定義
        const footnote = MARKDOWN_FOOTNOTE_DEFINITION.exec(line);
        if (footnote) {
            // 脚注はTextileとMarkdownで描画様式（番号の位置・戻りリンク・区切り線）が異なるが、構文の意味は同じなので報告しない。
            // ただしMarkdown文書のプレビューは脚注の本文の記法を解釈せず文字のまま表示するため、本文が記法になり得る記号を含む場合は報告する。
            const number = state.footnoteNumbers.get(footnote[1]);
            const body: string[] = [footnote[2]];
            let end = index + 1;
            while (end < lines.length && /^\s{2,}\S/.test(lines[end])) {
                body.push(lines[end]);
                end += 1;
            }
            if (!body.every(isPlainFootnoteBody)) reportUnsupported(index, end);
            writer.pushBlock([`fn${number}. ${joinSoftBreaks(body).map(inline).join(' ')}`], eols[end - 1]);
            state.needsSignature = false;
            index = end;
            continue;
        }

        // Setext見出し
        if (index + 1 < lines.length && /^ {0,3}(=+|-+)\s*$/.test(lines[index + 1]) && !isMarkdownBlockStart(line)) {
            const level = lines[index + 1].trim().startsWith('=') ? 1 : 2;
            writer.pushBlock([`h${level}. ${inline(line.trim())}`], eols[index + 1]);
            state.needsSignature = false;
            index += 2;
            continue;
        }

        // 段落
        const paragraph: string[] = [];
        let end = index;
        while (end < lines.length && !/^[ \t]*$/.test(lines[end]) && (end === index || !isMarkdownBlockStart(lines[end]))
            && !(end > index && /^ {0,3}(=+|-+)\s*$/.test(lines[end]))
            // GFMの表は段落を途中で打ち切る。
            && !(end > index && lines[end].includes('|') && isMarkdownTableSeparator(lines[end + 1] ?? ''))) {
            paragraph.push(lines[end]);
            end += 1;
        }
        // Markdown文書に書かれたTextileのブロック（署名付き段落・表）は、Markdownのプレビューも既にTextileとして描画している。
        // そのまま残せばTextileでも同じ見た目になるため、行もインライン記法も書き換えない。
        // 複数段落ブロック（`bc..`など）はプレビューと同じく次のTextile署名の直前まで空行を含めて続く。
        const textileLead = parseTextileSignature(line);
        // 2行目がGFMの区切り行の形の表行は、Markdownのプレビューでは（GFMの表にならなければ）段落になるため対象にしない。
        if (!markdownOnlyMode && (textileLead || (TEXTILE_TABLE_ROW.test(line) && !MARKDOWN_TABLE_SEPARATOR.test(lines[index + 1] ?? '')))) {
            if (textileLead?.extended) {
                while (end < lines.length && !parseTextileSignature(lines[end])) end += 1;
                while (end > index + 1 && !lines[end - 1].trim()) end -= 1;
            }
            for (let cursor = index; cursor < end; cursor += 1) writer.push(lines[cursor], eols[cursor]);
            state.needsSignature = false;
            index = end;
            continue;
        }
        const converted = joinSoftBreaks(paragraph).map(inline);
        const setext = end < lines.length && /^ {0,3}(=+|-+)\s*$/.test(lines[end]) && end > index;
        if (setext) {
            const level = lines[end].trim().startsWith('=') ? 1 : 2;
            writer.pushBlock([`h${level}. ${converted.join(' ')}`], eols[end]);
            state.needsSignature = false;
            index = end + 1;
            continue;
        }
        converted[0] = paragraphLead(converted[0] ?? '', paragraph[0] ?? '', paragraph[1]);
        writer.pushBlock(converted, eols[end - 1]);
        index = end;
    }
    return writer.toString();
}

/**
 * 文書を指定した記法へ変換し、プレビューの見た目が変わる記法を含む行を一緒に返す。
 * 変換元と変換先が同じ場合は原文をそのまま返し、報告行は空になる。
 * @param source - 変換対象の原文。
 * @param from - 原文の記法。
 * @param to - 変換先の記法。
 * @param options - 変換の指定。省略時は通常の変換。
 * @returns 変換後の原文と、変換するとプレビューが変わる記法を含む行（1始まり）。
 */
export function convertDocumentSyntax(
    source: string,
    from: DocumentSyntax,
    to: DocumentSyntax,
    options: DocumentConversionOptions = {}
): DocumentConversionResult {
    if (from === to) return { text: source, unsupportedLines: [] };
    return collectUnsupported(
        () => (to === 'markdown' ? convertTextileToMarkdown(source) : convertMarkdownToTextile(source)),
        options.restore === true,
        options.footnotes,
        options.references,
        options.markdownOnly === true
    );
}
