/**
 * @fileoverview DOCX出力の中間モデル。ブラウザー内の抽出処理（extract.ts）が描画済みDOMから作り、
 * Node側のOOXML生成処理（ooxml.ts）が読み取る。page.evaluateの境界を越えるため、
 * すべての値はJSONで表現できるプレーンなデータに限り、関数・DOMノード・循環参照を含めない。
 */

/** 文字列の書式。描画済みDOMの計算済みスタイルから決め、既定値と同じ項目は省略する。 */
export interface DocxRunStyle {
    /** 太字。font-weightが600以上のとき。 */
    bold?: boolean;
    /** 斜体。 */
    italic?: boolean;
    /** 下線。リンクの下線も含む。 */
    underline?: boolean;
    /** 取り消し線。 */
    strike?: boolean;
    /** 上付き・下付き。 */
    vertAlign?: 'superscript' | 'subscript';
    /** 文字色（`RRGGBB`）。段落の基準色と同じ場合は省略する。 */
    color?: string;
    /** 背景色（`RRGGBB`）。mark・インラインコードなど、インライン要素の背景だけを写す。 */
    shading?: string;
    /** 文字サイズ（半ポイント）。段落のWordスタイルと異なる場合だけ持つ（インラインコードなど）。 */
    size?: number;
    /** 本文と異なるフォントファミリー。先頭は採用名、残りは代替候補として fontTable に写す。 */
    fonts?: readonly string[];
}

/** 段落内の要素。 */
export type DocxInline =
    | {
        /** 書式付きの文字列。改行を含まない。 */
        type: 'text';
        /** 表示する文字列。空白は印刷時の表示どおりに詰め済み。タブはWordのタブへ写す。 */
        text: string;
        /** 文字の書式。 */
        style: DocxRunStyle;
        /** white-space: pre系で表示された文字列。前後の空白を詰めずにそのまま出す。 */
        preserve?: boolean;
        /** リンク先。外部URLは`href`、文書内の見出しは`anchor`（ブックマーク名へ解決済みのid）。 */
        link?: { href: string } | { anchor: string };
    }
    | {
        /** 段落内の改行（`<br>`）。 */
        type: 'break';
    }
    | {
        /** 画像。`id`は`DocxModel.images`の添字。 */
        type: 'image';
        id: number;
    }
    | {
        /** 行内数式。`omml`はm:oMath要素の文字列。変換できない式は`image`で埋め込む。 */
        type: 'math';
        omml: string;
    }
    | {
        /** 脚注参照。`id`は`DocxModel.footnotes`の添字。 */
        type: 'footnote';
        id: number;
        /**
         * 同じ脚注への2回目以降の参照。Wordの脚注は1か所からしか参照できないため、
         * 最初の参照に付けたブックマークをNOTEREFフィールドで参照し、同じ番号を表示する。
         */
        repeat?: boolean;
    };

/** 番号付き・箇条書きの形式。CSSのlist-style-typeからWordのnumFmtへ対応付ける。 */
export type DocxListFormat = 'bullet' | 'decimal' | 'lowerLetter' | 'upperLetter' | 'lowerRoman' | 'upperRoman' | 'none';

/** リスト項目の段落に付ける番号情報。 */
export interface DocxNumbering {
    /** 同じリストの項目で共有する番号。番号付きリストは開始番号ごとに別の番号定義を作る。 */
    list: number;
    /** 入れ子の深さ（0始まり、最大8）。 */
    level: number;
    /** 番号の形式。 */
    format: DocxListFormat;
    /** 番号付きリストの開始番号。 */
    start: number;
}

/** 段落の種類と配置。 */
export interface DocxParagraph {
    type: 'paragraph';
    /** 段落スタイル。見出しは`heading`の値でHeading1–6を使う。 */
    style?: 'code' | 'tocTitle' | 'caption';
    /** 見出しの段階（1–6）。 */
    heading?: number;
    /** 見出しに付けるブックマーク名。文書内リンクの飛び先になる。 */
    bookmark?: string;
    /** 目次項目の段階（1–6）。TOC1–6スタイルを使う。 */
    tocLevel?: number;
    /** 文字揃え。左揃えは省略する。 */
    align?: 'center' | 'right' | 'both';
    /** 入れ子の引用の深さ。1以上で引用スタイルを使う。 */
    quote?: number;
    /** 左罫線。引用の縦線を表し、色と太さは印刷CSSの計算済みスタイルから写す。 */
    leftBorder?: DocxBorder;
    /**
     * 段落が属する引用の通し番号。Wordは罫線と背景が同じ段落を1つの枠にまとめるため、
     * 同じ深さで番号が異なる段落が続く場合に、枠を分ける区切りを入れる。
     */
    quoteGroup?: number;
    /** 下罫線。水平線（`<hr>`）や、下線付きの見出し（h1・h2）を表す。 */
    bottomBorder?: DocxBorder;
    /** リスト内の段落。同じリストの段落どうしの間隔を詰める（contextualSpacing）。 */
    list?: boolean;
    /** 左インデント（twip）。リストの継続段落や引用の入れ子で使う。 */
    indent?: number;
    /** ぶら下げインデント（twip）。リスト項目の番号・記号を本文の左へ出す幅。 */
    hanging?: number;
    /** リスト項目の番号。 */
    numbering?: DocxNumbering;
    /** 段落の背景色（`RRGGBB`）。コードブロックや、背景のある引用の中の段落で使う。 */
    shading?: string;
    /** この段落の前で改ページする。 */
    pageBreakBefore?: boolean;
    inlines: DocxInline[];
}

/** 段落の罫線。 */
export interface DocxBorder {
    /** 線の色（`RRGGBB`）。 */
    color: string;
    /** 線の太さ（CSSピクセル）。 */
    width: number;
}

/** 独立した数式段落（ディスプレイ数式）。引用・リストの中では、その段落の字下げ・罫線・背景を引き継ぐ。 */
export interface DocxMathBlock {
    type: 'math';
    omml: string;
    /** 段落の書式。行内要素と見出し・番号の情報は使わない。 */
    paragraph?: Omit<DocxParagraph, 'type' | 'inlines'>;
}

/** 表のセル。 */
export interface DocxTableCell {
    /** セル内の段落。空のセルも1段落を持つ。 */
    blocks: DocxBlock[];
    /** 横方向の結合数。 */
    colSpan: number;
    /** 縦方向の結合。`restart`で始まり、`continue`のセルは内容を持たない。 */
    vMerge?: 'restart' | 'continue';
    /** 描画上の幅（twip）。 */
    width: number;
    /** 背景色（`RRGGBB`）。 */
    shading?: string;
    /** 縦位置。 */
    vAlign?: 'center' | 'bottom';
}

/** 表。 */
export interface DocxTable {
    type: 'table';
    /** 各列の幅（twip）。描画上の列幅から求める。 */
    columns: number[];
    rows: Array<{
        /** 見出し行。ページをまたぐとき繰り返す。 */
        header: boolean;
        cells: DocxTableCell[];
    }>;
    /** 表全体の左インデント（twip）。 */
    indent?: number;
}

/** 目次フィールド。既存の目次項目を表示用の結果として持ち、Wordで更新できる。 */
export interface DocxToc {
    type: 'toc';
    /** 目次の見出し段落。 */
    title?: DocxParagraph;
    /** 目次項目の段落。 */
    entries: DocxParagraph[];
}

/** 本文のブロック要素。 */
export type DocxBlock = DocxParagraph | DocxMathBlock | DocxTable | DocxToc;

/** 埋め込み画像。 */
export interface DocxImage {
    /**
     * Wordがそのまま扱える画像（PNG・JPEG・GIF・BMP）のdata URL。
     * それ以外（SVG・WebP・Mermaid・リモート画像・未対応数式）は空で、Node側が要素のスクリーンショットでPNG化する。
     * 宣言された形式と中身の署名が一致しない場合も、Node側はスクリーンショットへ切り替える。
     */
    dataUrl?: string;
    /** スクリーンショット対象の要素に付けた`data-mve-docx-raster`の値。すべての画像が持つ。 */
    rasterId: number;
    /** 表示サイズ（CSSピクセル）。印刷本文幅で描画したときの寸法。 */
    width: number;
    height: number;
    /** 代替テキスト。 */
    alt: string;
}

/** 抽出結果全体。 */
export interface DocxModel {
    body: DocxBlock[];
    /** 脚注。各脚注は段落の並び。 */
    footnotes: DocxBlock[][];
    images: DocxImage[];
    /** 本文の基準書式。 */
    base: {
        /** 本文フォントの候補（CSSのfont-family順、総称名を除く）。 */
        fonts: string[];
        /** コード用フォントの候補。 */
        codeFonts: string[];
        /** 本文の文字色（`RRGGBB`）。 */
        color: string;
        /**
         * 見出しの段階（`h1`〜`h6`）ごとの計算済みの色（`RRGGBB`）。文書に現れた段階だけを持つ。
         * Wordの見出しスタイルの色にし、`--css`による色の変更を反映する。ない段階はテーマ色を使う。
         */
        headingColors: Record<string, string>;
        /** 本文の文字サイズ（半ポイント）。印刷CSS（`--css`を含む）の計算済みの値。Wordの標準スタイルに使う。 */
        bodySize: number;
        /** コードブロックの文字サイズ（半ポイント）。Code・CodeCaptionスタイルに使う。 */
        codeSize: number;
        /** 本文の段落の行の高さ（pt）。印刷CSSの計算済みのline-height。Wordの行間（最小値）に使う。 */
        lineHeight: number;
        /** コードブロックの行の高さ（pt）。 */
        codeLineHeight: number;
        /**
         * 段落と見出しの前後の間隔（pt）。印刷CSSの計算済みの余白から、Wordの「前後の間隔を足し合わせる」規則に合わせて換算した値。
         * `paragraph`は段落の後ろの間隔、`headings`は見出しの段階ごとの前・後ろの間隔。
         */
        spacing: { paragraph: number; headings: Record<string, { before: number; after: number }> };
        /** 見出しの段階ごとの文字サイズ（半ポイント）。文書に現れた段階だけを持ち、ない段階は設定値を使う。 */
        headingSizes: Record<string, number>;
    };
    /** 変換できなかった要素などの警告。 */
    warnings: string[];
}

