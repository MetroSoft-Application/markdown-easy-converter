/**
 * @fileoverview HostとWebviewで使う表示文言とローカライズキーを対応付ける。未登録キーのフォールバックを一貫させる。
 */
import localeCatalog from './locales.json';
import type { TextColorId } from './textColor';


/**
 * ローカライズ辞書が提供する言語コードの一覧。
 */
export const SUPPORTED_LANGUAGES = ['ja', 'en', 'zh-cn', 'ko', 'fr', 'de', 'es'] as const;
/**
 * ローカライズ辞書が提供する言語コード。
 */
export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];
/**
 * 表示言語の自動判定または明示指定。
 */
export type LanguageSetting = 'auto' | SupportedLanguage;

/**
 * 表示文言で送受信するメッセージまたは要求のデータ形状。
 */
export interface Messages {

    /**
     * リボンで表示する文言をまとめた辞書。
     */
    ribbon: {

        /**
         * リボンのタブ名をまとめた辞書。
         */
        tabs: {
            /**
             * ホームタブとして表示するローカライズ済み文言。
             */
            home: string;
            /**
             * 挿入タブとして表示するローカライズ済み文言。
             */
            insert: string;
            /**
             * 表タブとして表示するローカライズ済み文言。
             */
            table: string;
            /**
             * 表示タブとして表示するローカライズ済み文言。
             */
            view: string;
            /**
             * 出力タブとして表示するローカライズ済み文言。
             */
            export: string;
            /**
             * 設定タブとして表示するローカライズ済み文言。
             */
            settings: string;
            /**
             * ヘルプタブとして表示するローカライズ済み文言。
             */
            help: string
        };

        /**
         * 表示項目「表示文言」の文言として表示するローカライズ済み文言。
         */
        label: string;

        /**
         * 表示項目「source」の文言として表示するローカライズ済み文言。
         */
        source: string;

        /**
         * 本文編集面の見出しとして表示するローカライズ済み文言。
         */
        sourceTitle: string;

        /**
         * outline設定の表示文言として表示するローカライズ済み文言。
         */
        outline: string;

        /**
         * 目次の見出しとして表示するローカライズ済み文言。
         */
        outlineTitle: string;

        /**
         * 表示項目「スクロール同期」の文言として表示するローカライズ済み文言。
         */
        scrollSync: string;

        /**
         * スクロール同期設定の見出しとして表示するローカライズ済み文言。
         */
        scrollSyncTitle: string;

        /**
         * 表示項目「search」の文言として表示するローカライズ済み文言。
         */
        search: string;

        /**
         * split設定の表示文言として表示するローカライズ済み文言。
         */
        split: string;

        /**
         * 表示項目「本文のみ表示」の文言として表示するローカライズ済み文言。
         */
        textOnly: string;

        /**
         * プレビューのみ表示設定の表示文言として表示するローカライズ済み文言。
         */
        previewOnly: string;

        /**
         * 表示項目「pin」の文言として表示するローカライズ済み文言。
         */
        pin: string;

        /**
         * 表示項目「unpin」の文言として表示するローカライズ済み文言。
         */
        unpin: string;

        /**
         * 表示項目「collapse」の文言として表示するローカライズ済み文言。
         */
        collapse: string;

        /**
         * 表示項目「expand」の文言として表示するローカライズ済み文言。
         */
        expand: string;

        /**
         * リボンの各タブに属する操作グループの翻訳文言をまとめる。
         */
        groups: {

            /**
             * 表示項目「履歴」の文言として表示するローカライズ済み文言。
             */
            history: string;

            /**
             * 表示項目「段落」の文言として表示するローカライズ済み文言。
             */
            paragraph: string;

            /**
             * 表示項目「文字書式」の文言として表示するローカライズ済み文言。
             */
            textFormat: string;

            /**
             * 解除操作のラベルとして表示するローカライズ済み文言。
             */
            clear: string;

            /**
             * 表示項目「basic」の文言として表示するローカライズ済み文言。
             */
            basic: string;

            /**
             * 表示項目「block」の文言として表示するローカライズ済み文言。
             */
            block: string;

            /**
             * 表示項目「assist」の文言として表示するローカライズ済み文言。
             */
            assist: string;

            /**
             * 表示項目「rows」の文言として表示するローカライズ済み文言。
             */
            rows: string;

            /**
             * 表示項目「columns」の文言として表示するローカライズ済み文言。
             */
            columns: string;

            /**
             * 表示項目「alignment」の文言として表示するローカライズ済み文言。
             */
            alignment: string;

            /**
             * 表示項目「excel」の文言として表示するローカライズ済み文言。
             */
            excel: string;

            /**
             * 表示項目「pane」の文言として表示するローカライズ済み文言。
             */
            pane: string;

            /**
             * 表示項目「pdf」の文言として表示するローカライズ済み文言。
             */
            pdf: string;

            /**
             * 表示項目「html」の文言として表示するローカライズ済み文言。
             */
            html: string;

            /**
             * 表示項目「inspection」の文言として表示するローカライズ済み文言。
             */
            inspection: string;

            /**
             * プレビュー操作のグループ名。
             */
            preview: string;

            /**
             * テーマ操作のグループ名。
             */
            theme: string;

            /**
             * ヘルプタブとして表示するローカライズ済み文言。
             */
            help: string;
        };

        /**
         * リボンの操作に付ける表示ラベルの翻訳文言をまとめる。
         */
        labels: {

            /**
             * 元に戻す操作のラベルとして表示するローカライズ済み文言。
             */
            undo: string;

            /**
             * やり直す操作のラベルとして表示するローカライズ済み文言。
             */
            redo: string;

            /**
             * 表示項目「style」の文言として表示するローカライズ済み文言。
             */
            style: string;

            /**
             * 表示項目「body」の文言として表示するローカライズ済み文言。
             */
            body: string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param level - 見出しレベル1から6。

             */
            heading: (level: number) => string;

            /**
             * 引用書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            quote: string;

            /**
             * 箇条書き書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            bulletList: string;

            /**
             * 番号付きリスト書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            orderedList: string;

            /**
             * タスクリスト書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            taskList: string;

            /**
             * 表示項目「indent」の文言として表示するローカライズ済み文言。
             */
            indent: string;

            /**
             * 表示項目「outdent」の文言として表示するローカライズ済み文言。
             */
            outdent: string;

            /**
             * 太字書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            bold: string;

            /**
             * 斜体書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            italic: string;

            /**
             * 取り消し線書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            strike: string;

            /**
             * 下線書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            underline: string;

            /**
             * 表示項目「highlight」の文言として表示するローカライズ済み文言。
             */
            highlight: string;

            /**
             * コード書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            code: string;

            /**
             * 表示項目「superscript」の文言として表示するローカライズ済み文言。
             */
            superscript: string;

            /**
             * 表示項目「subscript」の文言として表示するローカライズ済み文言。
             */
            subscript: string;

            /**
             * インライン書式解除操作のラベルとして表示するローカライズ済み文言。
             */
            clearInline: string;

            /**
             * ブロック書式解除操作のラベルとして表示するローカライズ済み文言。
             */
            clearBlock: string;

            /**
             * すべてクリア操作のラベルとして表示するローカライズ済み文言。
             */
            clearAll: string;

            /**
             * unlink書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            unlink: string;

            /**
             * リンク書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            link: string;

            /**
             * 画像書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            image: string;

            /**
             * 表示項目「表サイズ」の文言として表示するローカライズ済み文言。
             */
            tableSize: string;

            /**
             * 表示項目「rows」の文言として表示するローカライズ済み文言。
             */
            rows: string;

            /**
             * 表示項目「columns」の文言として表示するローカライズ済み文言。
             */
            columns: string;

            /**
             * 表を挿入操作のラベルとして表示するローカライズ済み文言。
             */
            insertTable: string;

            /**
             * 表示項目「水平線」の文言として表示するローカライズ済み文言。
             */
            horizontalRule: string;

            /**
             * 表示項目「強制改行」の文言として表示するローカライズ済み文言。
             */
            hardBreak: string;

            /**
             * 表示項目「language」の文言として表示するローカライズ済み文言。
             */
            language: string;

            /**
             * コードブロック書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            codeBlock: string;

            /**
             * 表示項目「math」の文言として表示するローカライズ済み文言。
             */
            math: string;

            /**
             * 表示項目「footnote」の文言として表示するローカライズ済み文言。
             */
            footnote: string;

            /**
             * 表示項目「toc」の文言として表示するローカライズ済み文言。
             */
            toc: string;

            /**
             * 文字色操作のラベル。
             */
            textColor: string;

            /**
             * 画像リサイズ操作のラベル。
             */
            imageResize: string;

            /**
             * プレビュー画像リサイズ操作の説明。
             */
            imageResizeControls: string;

            /**
             * エディターテーマ選択のラベル。
             */
            editorTheme: string;

            /**
             * 明るいテーマのラベル。
             */
            light: string;

            /**
             * 暗いテーマのラベル。
             */
            dark: string;

            /**
             * 表示項目「改ページ」の文言として表示するローカライズ済み文言。
             */
            pageBreak: string;

            /**
             * 表示項目「emoji」の文言として表示するローカライズ済み文言。
             */
            emoji: string;

            /**
             * 絵文字を挿入操作のラベルとして表示するローカライズ済み文言。
             */
            insertEmoji: string;

            /**
             * 前へ追加操作のラベルとして表示するローカライズ済み文言。
             */
            addBefore: string;

            /**
             * 後ろへ追加操作のラベルとして表示するローカライズ済み文言。
             */
            addAfter: string;

            /**
             * 左へ追加操作のラベルとして表示するローカライズ済み文言。
             */
            addLeft: string;

            /**
             * 右へ追加操作のラベルとして表示するローカライズ済み文言。
             */
            addRight: string;

            /**
             * 行を削除操作のラベルとして表示するローカライズ済み文言。
             */
            deleteRow: string;

            /**
             * 表示項目「見出し行を切り替え」の文言として表示するローカライズ済み文言。
             */
            toggleHeader: string;

            /**
             * 列を削除操作のラベルとして表示するローカライズ済み文言。
             */
            deleteColumn: string;

            /**
             * 表示項目「左揃え」の文言として表示するローカライズ済み文言。
             */
            alignLeft: string;

            /**
             * 表示項目「中央揃え」の文言として表示するローカライズ済み文言。
             */
            alignCenter: string;

            /**
             * 表示項目「右揃え」の文言として表示するローカライズ済み文言。
             */
            alignRight: string;

            /**
             * 表示項目「列幅を揃える」の文言として表示するローカライズ済み文言。
             */
            alignColumns: string;

            /**
             * 表示項目「セル内改行」の文言として表示するローカライズ済み文言。
             */
            cellBreak: string;

            /**
             * TSVをコピー操作のラベルとして表示するローカライズ済み文言。
             */
            copyTsv: string;

            /**
             * 印刷プレビュー設定の表示文言として表示するローカライズ済み文言。
             */
            printPreview: string;

            /**
             * 表示項目「PDF出力」の文言として表示するローカライズ済み文言。
             */
            exportPdf: string;

            /**
             * 表示項目「HTML出力」の文言として表示するローカライズ済み文言。
             */
            exportHtml: string;

            /**
             * 画像を埋め込む書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            embedImages: string;

            /**
             * リンク形式へ変換・markdown書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            convertLinkedMarkdown: string;

            /**
             * HTML出力へMarkdownアウトラインを表示する設定のラベル。
             */
            showOutlineSidebar: string;

            /**
             * ダイアログなしで保存・dialog操作のラベルとして表示するローカライズ済み文言。
             */
            saveWithoutDialog: string;

            /**
             * 表示項目「preflight」の文言として表示するローカライズ済み文言。
             */
            preflight: string;

            /**
             * 表示項目「shortcuts」の文言として表示するローカライズ済み文言。
             */
            shortcuts: string;

            /**
             * 表示項目「features」の文言として表示するローカライズ済み文言。
             */
            features: string;

            /**
             * 表示項目「Markdownの対応範囲」の文言として表示するローカライズ済み文言。
             */
            markdownSupport: string;

            /**
             * 画面または設定項目の説明として表示するローカライズ済み文言。
             */
            about: string;

            /**
             * 表示項目「header」の文言として表示するローカライズ済み文言。
             */
            header: string;

            /**
             * 入力欄のプレースホルダーとして表示するローカライズ済み文言。
             */
            headerPlaceholder: string;
        };

        /** 利用者向けヘルプに表示する機能説明文をまとめる。 */
        featureDescriptions: {

            /**
             * 元に戻す操作のラベルとして表示するローカライズ済み文言。
             */
            undo: string;

            /**
             * やり直す操作のラベルとして表示するローカライズ済み文言。
             */
            redo: string;

            /**
             * 太字書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            bold: string;

            /**
             * 斜体書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            italic: string;

            /**
             * インライン書式解除操作のラベルとして表示するローカライズ済み文言。
             */
            clearInline: string;

            /**
             * ブロック書式解除操作のラベルとして表示するローカライズ済み文言。
             */
            clearBlock: string;

            /**
             * リンク書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            link: string;

            /**
             * 画像書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            image: string;

            /**
             * 表を挿入操作のラベルとして表示するローカライズ済み文言。
             */
            insertTable: string;

            /**
             * コードブロック書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            codeBlock: string;

            /**
             * 表示項目「math」の文言として表示するローカライズ済み文言。
             */
            math: string;

            /**
             * 表示項目「footnote」の文言として表示するローカライズ済み文言。
             */
            footnote: string;

            /**
             * 表示項目「toc」の文言として表示するローカライズ済み文言。
             */
            toc: string;

            /**
             * 前へ追加操作のラベルとして表示するローカライズ済み文言。
             */
            addBefore: string;

            /**
             * 行を削除操作のラベルとして表示するローカライズ済み文言。
             */
            deleteRow: string;

            /**
             * 列を削除操作のラベルとして表示するローカライズ済み文言。
             */
            deleteColumn: string;

            /**
             * 表示項目「左揃え」の文言として表示するローカライズ済み文言。
             */
            alignLeft: string;

            /**
             * 表示項目「中央揃え」の文言として表示するローカライズ済み文言。
             */
            alignCenter: string;

            /**
             * 表示項目「右揃え」の文言として表示するローカライズ済み文言。
             */
            alignRight: string;

            /**
             * TSVをコピー操作のラベルとして表示するローカライズ済み文言。
             */
            copyTsv: string;

            /**
             * 表エディター設定の表示文言として表示するローカライズ済み文言。
             */
            tableEditor: string;

            /**
             * 表エディター・列幅の変更設定の表示文言として表示するローカライズ済み文言。
             */
            tableEditorColumnResize: string;

            /**
             * 表エディター・行高の変更設定の表示文言として表示するローカライズ済み文言。
             */
            tableEditorRowResize: string;

            /**
             * 表エディター・layout設定の表示文言として表示するローカライズ済み文言。
             */
            tableEditorLayout: string;

            /**
             * outline設定の表示文言として表示するローカライズ済み文言。
             */
            outline: string;

            /**
             * 表示項目「search」の文言として表示するローカライズ済み文言。
             */
            search: string;

            /**
             * split設定の表示文言として表示するローカライズ済み文言。
             */
            split: string;

            /**
             * 表示項目「本文のみ表示」の文言として表示するローカライズ済み文言。
             */
            textOnly: string;

            /**
             * プレビューのみ表示設定の表示文言として表示するローカライズ済み文言。
             */
            previewOnly: string;

            /**
             * 印刷プレビュー設定の表示文言として表示するローカライズ済み文言。
             */
            printPreview: string;

            /**
             * 表示項目「PDF出力」の文言として表示するローカライズ済み文言。
             */
            exportPdf: string;

            /**
             * 表示項目「preflight」の文言として表示するローカライズ済み文言。
             */
            preflight: string;
        };

        /** コード挿入UIで選べる言語名をまとめる。 */
        codeLanguages: ReadonlyArray<{
            /**
             * 表示項目「値」の文言として表示するローカライズ済み文言。
             */
            value: string;
            /**
             * 表示項目「表示文言」の文言として表示するローカライズ済み文言。
             */
            label: string
        }>;

        /** 定型入力候補とその挿入内容をまとめる。 */
        snippets: {
            /**
             * 表示項目「mermaid」の文言として表示するローカライズ済み文言。
             */
            mermaid: string;
            /**
             * 表示項目「footnote」の文言として表示するローカライズ済み文言。
             */
            footnote: string;
            /**
             * 表示項目「note」の文言として表示するローカライズ済み文言。
             */
            note: string;
            /**
             * 失敗または入力エラーの説明として表示するローカライズ済み文言。
             */
            warning: string
        };

        /**
         * 表示文言へ渡す設定または境界値。
         */
        settings: {

            /**
             * images書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            images: string;

            /**
             * 画像の保存先書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            imageDirectory: string;

            /**
             * 入力欄のプレースホルダーとして表示するローカライズ済み文言。
             */
            imageDirectoryPlaceholder: string;

            /**
             * 操作部品のツールチップとして表示するローカライズ済み文言。
             */
            imageDirectoryHint: string;

            /**
             * fonts設定の表示文言として表示するローカライズ済み文言。
             */
            fonts: string;

            /**
             * Mermaid設定グループの見出しとして表示するローカライズ済み文言。
             */
            mermaid: string;

            /**
             * Mermaid文字サイズ入力欄のラベルとして表示するローカライズ済み文言。
             */
            mermaidFontSize: string;

            /**
             * Mermaid文字サイズの有効範囲と出力先を説明するローカライズ済み文言。
             */
            mermaidFontSizeHint: string;

            /**
             * フォント設定設定の表示文言として表示するローカライズ済み文言。
             */
            fontSettings: string;

            /**
             * 編集フォント・family設定の表示文言として表示するローカライズ済み文言。
             */
            editorFontFamily: string;

            /**
             * preview・フォントファミリー設定の表示文言として表示するローカライズ済み文言。
             */
            previewFontFamily: string;

            /**
             * 入力欄のプレースホルダーとして表示するローカライズ済み文言。
             */
            fontFamilyPlaceholder: string;

            /**
             * 操作部品のツールチップとして表示するローカライズ済み文言。
             */
            fontFamilyHint: string;

            /**
             * 表示項目「apply」の文言として表示するローカライズ済み文言。
             */
            apply: string;
        };
    };

    /** アプリ全体の操作説明、通知、エラーに使う文言をまとめる。 */
    app: {

        /**
         * 表示項目「startup」の文言として表示するローカライズ済み文言。
         */
        startup: string;

        /**
         * outline設定の表示文言として表示するローカライズ済み文言。
         */
        outline: string;

        /**
         * 目次を隠す設定の表示文言として表示するローカライズ済み文言。
         */
        hideOutline: string;

        /**
         * 目次を表示設定の表示文言として表示するローカライズ済み文言。
         */
        showOutline: string;

        /**
         * 目次の幅設定の表示文言として表示するローカライズ済み文言。
         */
        outlineWidth: string;

        /** セクションへのリンクをコピーするメニュー項目。 */
        copySectionLink: string;

        /** HTML出力の見出しに表示するセクションリンク。 */
        sectionAnchorLink: string;

        /** セクションリンクのコンテキストメニュー名。 */
        sectionLinkMenu: string;

        /** 同じワークスペースフォルダー内で使えるセクションリンクをコピーするメニュー項目。 */
        copyWorkspaceSectionLink: string;

        /** 文書がワークスペースフォルダーに含まれていない場合の通知。 */
        workspaceSectionLinkUnavailable: string;

        /** セクションリンクのコピー成功通知。 */
        sectionLinkCopied: string;

        /**
         * 見出しなし書式コマンドのラベルとして表示するローカライズ済み文言。
         */
        noHeadings: string;

        /**
         * 表示項目「検索と・replace」の文言として表示するローカライズ済み文言。
         */
        searchAndReplace: string;

        /**
         * 表示項目「検索文字列」の文言として表示するローカライズ済み文言。
         */
        searchText: string;

        /**
         * 表示項目「置換文字列」の文言として表示するローカライズ済み文言。
         */
        replacementText: string;

        /**
         * 表示項目「replacement」の文言として表示するローカライズ済み文言。
         */
        replacement: string;

        /**
         * 表示項目「前の検索結果」の文言として表示するローカライズ済み文言。
         */
        previousMatch: string;

        /**
         * 表示項目「次の検索結果」の文言として表示するローカライズ済み文言。
         */
        nextMatch: string;

        /**
         * 表示項目「すべて置換」の文言として表示するローカライズ済み文言。
         */
        replaceAll: string;

        /**
         * 閉じる操作のラベルとして表示するローカライズ済み文言。
         */
        close: string;

        /**
         * 分割位置設定の表示文言として表示するローカライズ済み文言。
         */
        splitBoundary: string;

        /**
         * 表示項目「選択範囲の書式」の文言として表示するローカライズ済み文言。
         */
        selectionFormatting: string;

        /**
         * 画面または設定項目の見出しとして表示するローカライズ済み文言。
         */
        diagnosticsTitle: string;

        /**
         * 画面または設定項目の説明として表示するローカライズ済み文言。
         */
        diagnosticHelp: string;

        /**
         * 表示項目「問題なし」の文言として表示するローカライズ済み文言。
         */
        noProblems: string;

        /** 診断の重大度ごとに表示する名称をまとめる。 */
        severity: {
            /**
             * 失敗または入力エラーの説明として表示するローカライズ済み文言。
             */
            error: string;
            /**
             * 失敗または入力エラーの説明として表示するローカライズ済み文言。
             */
            warning: string;
            /**
             * 表示項目「info」の文言として表示するローカライズ済み文言。
             */
            info: string
        };
        /**
         * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
         * @param line - 表示する行番号（1始まり）。

         */
        line: (line: number) => string;

        /**
         * 表示項目「印刷設定」の文言として表示するローカライズ済み文言。
         */
        printSettings: string;

        /**
         * 画面または設定項目の説明として表示するローカライズ済み文言。
         */
        printSettingsHelp: string;

        /**
         * paper設定の表示文言として表示するローカライズ済み文言。
         */
        paper: string;

        /**
         * 表示項目「orientation」の文言として表示するローカライズ済み文言。
         */
        orientation: string;

        /**
         * 表示項目「portrait」の文言として表示するローカライズ済み文言。
         */
        portrait: string;

        /**
         * 表示項目「landscape」の文言として表示するローカライズ済み文言。
         */
        landscape: string;

        /**
         * 表示項目「header」の文言として表示するローカライズ済み文言。
         */
        header: string;

        /**
         * 表示項目「footer」の文言として表示するローカライズ済み文言。
         */
        footer: string;

        /**
         * margins設定の表示文言として表示するローカライズ済み文言。
         */
        margins: string;

        /**
         * 表示項目「top」の文言として表示するローカライズ済み文言。
         */
        top: string;

        /**
         * 表示項目「right」の文言として表示するローカライズ済み文言。
         */
        right: string;

        /**
         * 表示項目「bottom」の文言として表示するローカライズ済み文言。
         */
        bottom: string;

        /**
         * 表示項目「left」の文言として表示するローカライズ済み文言。
         */
        left: string;

        /**
         * 表示項目「ダイアログなし」の文言として表示するローカライズ済み文言。
         */
        withoutDialog: string;
        /**
         * 表示項目「typography」の文言として表示するローカライズ済み文言。
         */
        typography: string;

        /**
         * フォントファミリー設定の表示文言として表示するローカライズ済み文言。
         */
        fontFamily: string;

        /**
         * 本文フォント・size設定の表示文言として表示するローカライズ済み文言。
         */
        bodyFontSize: string;

        /**
         * 見出しフォント・sizes書式コマンドのラベルとして表示するローカライズ済み文言。
         */
        headingFontSizes: string;

        /**
         * コードフォント・size書式コマンドのラベルとして表示するローカライズ済み文言。
         */
        codeFontSize: string;

        /**
         * 表示項目「行の高さ」の文言として表示するローカライズ済み文言。
         */
        lineHeight: string;

        /**
         * 表示項目「段落間隔」の文言として表示するローカライズ済み文言。
         */
        paragraphSpacing: string;

        /**
         * 出力時の置換ルールをまとめる見出し。
         */
        outputReplacementRules: string;

        /**
         * PDFとHTMLの出力対象・順序・Markdown本文を変更しないことの説明。
         */
        outputReplacementHelp: string;

        /**
         * 置換ルールの検索文字列欄のラベル。
         */
        outputReplacementPattern: string;

        /**
         * 置換ルールで挿入する文字列欄のラベル。
         */
        outputReplacementText: string;

        /**
         * 置換ルールの追加ボタンに表示する文言。
         */
        addOutputReplacementRule: string;

        /**
         * 置換ルールの削除ボタンに表示する文言とアクセシブルな名前。
         */
        removeOutputReplacementRule: string;

        /** 置換ルールの削除ボタンに表示する短い文言。 */
        removeOutputReplacementRuleShort: string;

        /**
         * 空または無効な置換正規表現を示す文言。
         */
        invalidOutputReplacementPattern: string;

        /** 出力時の置換処理が制限時間を超えた場合に表示する文言。 */
        outputReplacementTimeout: string;

        /** 出力時の置換処理が失敗した場合に表示する文言。 */
        outputReplacementFailed: string;

        /** Marpプレビューの表示、読み込み、失敗を伝える文言。 */
        marpPreview: {
            /** Marpプレビューiframeのアクセシブル名。 */
            title: string;
            /** Marp Workerの描画中に表示する状態。 */
            loading: string;
            /** Workerの起動または描画が失敗した場合に表示する文言。 */
            failed: string;
            /** Marp判定に失敗し、通常プレビューへ切り替えない場合に表示する文言。 */
            detectionFailed: string;
            /** スライドごとのアクセシブル名。 */
            slideLabel: (index: number) => string;
        };

        /** 文書処理や保存の進行状態を伝える文言をまとめる。 */
        status: {

            /**
             * 分割表示モード設定の表示文言として表示するローカライズ済み文言。
             */
            modeSplit: string;

            /**
             * プレビューモード設定の表示文言として表示するローカライズ済み文言。
             */
            modePreview: string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param count - 文書内の行数。

             */
            lines: (count: number) => string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param count - 編集本文の文字数。

             */
            textCharacters: (count: number) => string;
            /**
             * 表示文言の変更または利用者の操作意図を記録し、後続処理へ渡す。
             * @param count - Markdown本文の文字数。

             */
            markdownCharacters: (count: number) => string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param percent - 表示するズーム倍率（パーセント）。

             */
            zoom: (percent: number) => string;

            /**
             * 表示項目「syncing」の文言として表示するローカライズ済み文言。
             */
            syncing: string;

            /**
             * 表示項目「synced」の文言として表示するローカライズ済み文言。
             */
            synced: string;
        };

        /** 文書診断パネルの見出しと操作文言をまとめる。 */
        inspector: {
            /**
             * 表示項目「mermaid」の文言として表示するローカライズ済み文言。
             */
            mermaid: string;
            /**
             * 表示項目「math」の文言として表示するローカライズ済み文言。
             */
            math: string;
            /**
             * 画像書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            image: string;
            /**
             * 表示項目「alt」の文言として表示するローカライズ済み文言。
             */
            alt: string;
            /**
             * 表示項目「reference」の文言として表示するローカライズ済み文言。
             */
            reference: string;
            /**
             * ファイルを開く操作のラベルとして表示するローカライズ済み文言。
             */
            openFile: string;
            /**
             * 表示項目「apply」の文言として表示するローカライズ済み文言。
             */
            apply: string;
        };

        /** 画像プレビューダイアログの見出しと操作文言をまとめる。 */
        imagePreview: {
            /** ダイアログの見出し。 */
            title: string;
            /** 画像プレビューの縮小操作のラベル。 */
            zoomOut: string;
            /** 画像プレビューの拡大操作のラベル。 */
            zoomIn: string;
            /** 画像プレビューのプロパティ領域の見出し。 */
            properties: string;
            /** 画像の元サイズを示すラベル。 */
            dimensions: string;
            /** 画像ファイルのデータサイズを示すラベル。 */
            fileSize: string;
        };

        /** リンク編集欄に表示するラベルと説明をまとめる。 */
        link: {
            /**
             * 画面または設定項目の見出しとして表示するローカライズ済み文言。
             */
            title: string;
            /**
             * 表示項目「url」の文言として表示するローカライズ済み文言。
             */
            url: string;
            /**
             * 入力欄のプレースホルダーとして表示するローカライズ済み文言。
             */
            urlPlaceholder: string;
            /**
             * 表示項目「本文」の文言として表示するローカライズ済み文言。
             */
            text: string;
            /**
             * 操作部品のツールチップとして表示するローカライズ済み文言。
             */
            textHint: string;
            /**
             * キャンセル操作のラベルとして表示するローカライズ済み文言。
             */
            cancel: string;
            /**
             * 挿入タブとして表示するローカライズ済み文言。
             */
            insert: string
        };

        /**
         * プレビュー画像のコピー操作に使う文言。
         */
        previewImageContextMenu: {
            /** Mermaid全体をPNGとしてコピーする操作のラベル。 */
            copyPng: string;
            /**
             * 画像コピー操作のラベル。
             */
            copy: string;
            /**
             * 画像の準備中に表示する状態。
             */
            preparing: string;
            /**
             * コピー成功時に表示する通知。
             */
            copied: string;
            /**
             * コピーできない画像に表示する説明。
             */
            unavailable: string;
            /**
             * コピー失敗時に表示する通知。
             */
            failed: string;
        };

        /**
         * 文字色操作に使う文言。
         */
        textColor: {
            /**
             * 文字色操作のラベル。
             */
            label: string;
            /**
             * 既定色へ戻す選択肢のラベル。
             */
            defaultColor: string;
            /**
             * 複数の選択色が混在するときの表示。
             */
            mixed: string;
            /**
             * 文字色ごとのラベル。
             */
            colors: Record<TextColorId, string>;
        };

        /**
         * プレビュー画像の操作に使う文言。
         */
        imageControls: {
            /**
             * 画像サイズ変更操作の説明。
             */
            resize: string;
            /**
             * 画像を左揃えにする操作の説明。
             */
            alignLeft: string;
            /**
             * 左揃え操作の短い表示。
             */
            alignLeftShort: string;
            /**
             * 画像を中央揃えにする操作の説明。
             */
            alignCenter: string;
            /**
             * 中央揃え操作の短い表示。
             */
            alignCenterShort: string;
            /**
             * 画像を右揃えにする操作の説明。
             */
            alignRight: string;
            /**
             * 右揃え操作の短い表示。
             */
            alignRightShort: string;
            /**
             * 画像サイズをリセットする操作の説明。
             */
            reset: string;
        };

        /**
         * PDFプレビューに使う状態と操作の文言。
         */
        pdfPreview: {
            /**
             * PDFの縮小操作のラベル。
             */
            zoomOut: string;
            /**
             * PDFの拡大操作のラベル。
             */
            zoomIn: string;
            /**
             * PDFプレビューを表示できない状態。
             */
            unavailable: string;
            /**
             * PDF生成中の状態。
             */
            generating: string;
            /**
             * PDFページ描画中の状態。
             */
            drawing: string;
            /**
             * PDFプレビュー準備中の状態。
             */
            preparing: string;
            /**
             * ページコンポーネントでのPDF生成中の状態。
             */
            loading: string;
            /**
             * PDFプレビュー用スクリプトを読み込めない状態。
             */
            webviewUnavailable: string;
            /**
             * PDF描画失敗時に詳細を加える文。
             * @param detail - PDF描画エラーに付け加えて表示する詳細。
             */
            failed: (detail: string) => string;
            /**
             * PDFページを描画できない状態。
             */
            pageError: string;
            /**
             * PDFページに付けるアクセシブル名。
             * @param page - 1始まりのPDFページ番号。
             */
            pageLabel: (page: number) => string;
        };

        /** 表の編集操作とセル状態を説明する文言をまとめる。 */
        tableEditor: {

            /**
             * 画面または設定項目の見出しとして表示するローカライズ済み文言。
             */
            title: string;

            /**
             * 閉じる操作のラベルとして表示するローカライズ済み文言。
             */
            close: string;

            /**
             * 行を追加操作のラベルとして表示するローカライズ済み文言。
             */
            addRow: string;

            /**
             * 行を削除操作のラベルとして表示するローカライズ済み文言。
             */
            deleteRow: string;

            /**
             * 列を追加操作のラベルとして表示するローカライズ済み文言。
             */
            addColumn: string;

            /**
             * 列を削除操作のラベルとして表示するローカライズ済み文言。
             */
            deleteColumn: string;

            /**
             * 表示項目「左揃え」の文言として表示するローカライズ済み文言。
             */
            alignLeft: string;

            /**
             * 表示項目「中央揃え」の文言として表示するローカライズ済み文言。
             */
            alignCenter: string;

            /**
             * 表示項目「右揃え」の文言として表示するローカライズ済み文言。
             */
            alignRight: string;

            /**
             * 配置を解除操作のラベルとして表示するローカライズ済み文言。
             */
            clearAlignment: string;

            /**
             * TSVをコピー操作のラベルとして表示するローカライズ済み文言。
             */
            copyTsv: string;

            /**
             * 列をコピー操作のラベルとして表示するローカライズ済み文言。
             */
            copyColumn: string;

            /**
             * 行をコピー操作のラベルとして表示するローカライズ済み文言。
             */
            copyRow: string;

            /**
             * キャンセル操作のラベルとして表示するローカライズ済み文言。
             */
            cancel: string;

            /**
             * 表示項目「apply」の文言として表示するローカライズ済み文言。
             */
            apply: string;

            /**
             * 操作部品のツールチップとして表示するローカライズ済み文言。
             */
            navigationHint: string;

            /**
             * 本文編集面・required設定の表示文言として表示するローカライズ済み文言。
             */
            sourceEditorRequired: string;

            /**
             * 表示項目「表が必要」の文言として表示するローカライズ済み文言。
             */
            tableRequired: string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param rows - 表編集で許可する最大行数。
             * @param columns - 表編集で許可する最大列数。

             */
            rowColumnLimit: (rows: number, columns: number) => string;

            /**
             * 表示項目「copied」の文言として表示するローカライズ済み文言。
             */
            copied: string;

            /**
             * 本文編集面・closed操作のラベルとして表示するローカライズ済み文言。
             */
            sourceEditorClosed: string;

            /**
             * 表示項目「文書の変更」の文言として表示するローカライズ済み文言。
             */
            documentChanged: string;

            /**
             * 表示項目「列幅を変更」の文言として表示するローカライズ済み文言。
             */
            resizeColumn: string;

            /**
             * 表示項目「行高を変更」の文言として表示するローカライズ済み文言。
             */
            resizeRow: string;

            /**
             * エディターのサイズ変更設定の表示文言として表示するローカライズ済み文言。
             */
            resizeEditor: string;

            /**
             * 適用前の変更がある状態を示すラベル。
             */
            modified: string;
            /**
             * 適用前の変更を破棄する確認文。
             */
            discard: string;
            /**
             * 現在の選択範囲を示すラベル。
             */
            selection: string;
            /**
             * 選択範囲のセル数を表す語。
             */
            cells: string;
            /**
             * 表全体を選択する操作のラベル。
             */
            selectAll: string;
            /**
             * 行のドラッグ並べ替え操作の説明。
             */
            dragRow: string;
            /**
             * 列のドラッグ並べ替え操作の説明。
             */
            dragColumn: string;
            /**
             * 現在の行を上へ移動する操作のラベル。
             */
            moveRowUp: string;
            /**
             * 現在の行を下へ移動する操作のラベル。
             */
            moveRowDown: string;
            /**
             * 現在の列を左へ移動する操作のラベル。
             */
            moveColumnLeft: string;
            /**
             * 現在の列を右へ移動する操作のラベル。
             */
            moveColumnRight: string;
            /**
             * 列を昇順に並べ替える操作のラベル。
             */
            sortAscending: string;
            /**
             * 列を降順に並べ替える操作のラベル。
             */
            sortDescending: string;
        };

        /** ヘルプ画面と操作ヒントに表示する文言をまとめる。 */
        help: {

            /**
             * 表示項目「shortcuts」の文言として表示するローカライズ済み文言。
             */
            shortcuts: string;

            /**
             * 表示項目「markdown」の文言として表示するローカライズ済み文言。
             */
            markdown: string;

            /**
             * 画面または設定項目の説明として表示するローカライズ済み文言。
             */
            about: string;

            /**
             * 画像操作のショートカット書式コマンドのラベルとして表示するローカライズ済み文言。
             */
            shortcutImage: string;

            /**
             * 表示項目「表操作のショートカット・break」の文言として表示するローカライズ済み文言。
             */
            shortcutTableBreak: string;

            /**
             * 表示項目「Markdownの紹介」の文言として表示するローカライズ済み文言。
             */
            markdownIntro: string;

            /**
             * 表示項目「Markdown機能」の文言として表示するローカライズ済み文言。
             */
            markdownFeatures: string;

            /**
             * 画面または設定項目の説明として表示するローカライズ済み文言。
             */
            aboutIntro: string;

            /**
             * 画面または設定項目の説明として表示するローカライズ済み文言。
             */
            aboutFeatures: string;
        };

        /** トースト通知で使うローカライズ済み文言。 */
        toast: {
            /**
             * 表示文言の入力を検証し、表示または保存に使う形式へ変換する。
             * @param count - 保存した画像ファイル数。

             */
            imagesSaved: (count: number) => string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param count - PDF出力前に検出したローカルリソース警告数。
             * @param detail - 警告の概要として通知に追加する文字列。

             */
            pdfResourceWarnings: (count: number, detail: string) => string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param errors - PDF事前確認で見つかったエラー数。
             * @param warnings - PDF事前確認で見つかった警告数。
             * @param infos - PDF事前確認で見つかった情報項目数。

             */
            preflightSummary: (errors: number, warnings: number, infos: number) => string;
            /**
             * 表示文言の入力を検証し、表示または保存に使う形式へ変換する。
             * @param detail - 画像保存失敗の理由として通知に追加する詳細。

             */
            imageSaveFailed: (detail: string) => string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param detail - PDF出力失敗の理由として通知に追加する詳細。

             */
            pdfExportFailed: (detail: string) => string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param detail - ローカルリソース検査失敗の理由として通知に追加する詳細。
             * @param duringPdf - PDF出力中の検査ならtrue。

             */
            resourceCheckFailed: (detail: string, duringPdf: boolean) => string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param detail - 操作失敗の理由として通知に追加する詳細。

             */
            operationFailed: (detail: string) => string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param path - 読み書きするファイルまたはリソースの場所。

             */
            pdfExported: (path: string) => string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param path - 読み書きするファイルまたはリソースの場所。
             * @param count - 書き出したHTML文書数。

             */
            htmlExported: (path: string, count: number) => string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param detail - HTML出力失敗の理由として通知に追加する詳細。

             */
            htmlExportFailed: (detail: string) => string;

            /**
             * 表示項目「表セル・required」の文言として表示するローカライズ済み文言。
             */
            tableCellRequired: string;

            /**
             * 貼り付け不可・tsv操作のラベルとして表示するローカライズ済み文言。
             */
            cannotPasteTsv: string;

            /**
             * 表示項目「表をコピー済み」の文言として表示するローカライズ済み文言。
             */
            tableCopied: string;
            /**
             * 表示文言の条件を判定する。
             * @param detail - TSVをコピーできなかった理由の補足。未指定なら空選択用の文言を使う。
             * @returns TSVをコピーできなかった理由を示すローカライズ済みメッセージ。
             */
            cannotCopyTsv: (detail?: string) => string;

            /**
             * 表示項目「ワークスペースの信頼状態・required」の文言として表示するローカライズ済み文言。
             */
            workspaceTrustRequired: string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param count - PDF出力前に検出した警告数。
             * @param detail - 診断内容の概要として通知に追加する文字列。

             */
            pdfStartedWithDiagnostics: (count: number, detail: string) => string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param detail - Markdownへのフォールバック理由。指定時は進捗文言の前へ付ける。

             */
            pdfFallbackToMarkdown: (detail?: string) => string;
        };

        /** 利用者へエラー原因を伝える文言をまとめる。 */
        errors: {

            /**
             * 表示項目「ACKの不一致」の文言として表示するローカライズ済み文言。
             */
            ackMismatch: string;
            /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param opId - 完了を待っている操作の識別子。

             */
            pendingOperationChain: (opId: string) => string;

            /**
             * 表示項目「クリップボードが利用不可」の文言として表示するローカライズ済み文言。
             */
            clipboardUnavailable: string;

            /**
             * 表示項目「BMP変換」の文言として表示するローカライズ済み文言。
             */
            bmpConversion: string;
            /**
             * 表示文言の入力を検証し、表示または保存に使う形式へ変換する。
             * @param maxSizeMb - 許可する画像ファイルの最大サイズ（MB）。

             */
            imageSize: (maxSizeMb: number) => string;
        };
    };

    /** Markdown描画結果に付ける補助ラベルをまとめる。 */
    renderer: {

        /**
         * 外部画像・disabled書式コマンドのラベルとして表示するローカライズ済み文言。
         */
        remoteImageDisabled: string;

        /**
         * コピー操作のラベルとして表示するローカライズ済み文言。
         */
        copy: string;

        /**
         * 表示項目「copied」の文言として表示するローカライズ済み文言。
         */
        copied: string;

        /**
         * 表示項目「改ページ」の文言として表示するローカライズ済み文言。
         */
        pageBreak: string;

        /**
         * 表示項目「toc」の文言として表示するローカライズ済み文言。
         */
        toc: string;

        /**
         * 表示項目「戻る・text」の文言として表示するローカライズ済み文言。
         */
        backToText: string;

        /**
         * 失敗または入力エラーの説明として表示するローカライズ済み文言。
         */
        mathError: string;

        /**
         * 失敗または入力エラーの説明として表示するローカライズ済み文言。
         */
        mermaidError: string;

        /** 描画中のMermaid図に付けるアクセシブルな状態文言。 */
        mermaidRendering: string;

        /**
         * Mermaid図のアクセシブル名。
         * @param description - Mermaid図を説明するアクセシブル名の補足。
         */
        mermaidDiagramLabel: (description: string) => string;

        /** 操作完了や失敗を知らせる通知文言をまとめる。 */
        alerts: {
            /**
             * 表示項目「note」の文言として表示するローカライズ済み文言。
             */
            note: string;
            /**
             * 表示項目「tip」の文言として表示するローカライズ済み文言。
             */
            tip: string;
            /**
             * 表示項目「important」の文言として表示するローカライズ済み文言。
             */
            important: string;
            /**
             * 失敗または入力エラーの説明として表示するローカライズ済み文言。
             */
            warning: string;
            /**
             * 表示項目「caution」の文言として表示するローカライズ済み文言。
             */
            caution: string
        };
    };

    /** 診断項目の説明に使うローカライズ済み文言。 */
    diagnostics: {
        /**
         * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
         * @param marker - 表示文言で受け渡す文字列。

         */
        unclosedFence: (marker: string) => string;
        /**
         * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
         * @param id - 重複が検出された見出しanchor ID。

         */
        duplicateHeading: (id: string) => string;

        /**
         * 失敗または入力エラーの説明として表示するローカライズ済み文言。
         */
        invalidTableSeparator: string;

        /**
         * 画像が空・alt書式コマンドのラベルとして表示するローカライズ済み文言。
         */
        emptyImageAlt: string;
        /**
         * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
         * @param source - ローカル画像として検査する参照文字列。

         */
        localImageCheck: (source: string) => string;

        /**
         * 表示項目「表が空・header」の文言として表示するローカライズ済み文言。
         */
        emptyTableHeader: string;
        /**
         * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
         * @param header - Markdown表ヘッダー行の列数。
         * @param separator - 区切り行または本文行で見つかった列数。
         * @param kind - 列数が一致しない行の種別。

         */
        tableColumnMismatch: (header: number, separator: number, kind: 'separator' | 'body') => string;
        /**
         * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
         * @param label - エラーメッセージに埋め込む未定義参照ラベル。

         */
        missingReference: (label: string) => string;
        /**
         * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
         * @param kind - 検査対象が画像参照かリンク参照かを示す種別。
         * @param missing - 参照先が存在しない場合true。
         * @param source - 検査する画像またはリンクの参照文字列。
         * @param detail - 参照先検査の結果または失敗理由を補う詳細文。

         */
        localResource: (kind: 'image' | 'link', missing: boolean, source: string, detail: string) => string;
    };

    /** Extension Hostから通知する出力状態とエラーの文言をまとめる。 */
    host: {

        /**
         * 表示項目「PDF出力の信頼状態・required」の文言として表示するローカライズ済み文言。
         */
        pdfTrustRequired: string;

        /**
         * 表示項目「PDF出力の進捗」の文言として表示するローカライズ済み文言。
         */
        pdfProgress: string;
        /**
         * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
         * @param path - 読み書きするファイルまたはリソースの場所。

         */
        pdfExported: (path: string) => string;

        /**
         * 表示項目「HTML出力の信頼状態・required」の文言として表示するローカライズ済み文言。
         */
        htmlTrustRequired: string;

        /**
         * 表示項目「HTML出力の進捗」の文言として表示するローカライズ済み文言。
         */
        htmlProgress: string;
        /**
         * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
         * @param path - 読み書きするファイルまたはリソースの場所。

         */
        htmlExported: (path: string) => string;

        /**
         * 開く操作のラベルとして表示するローカライズ済み文言。
         */
        open: string;

        /**
         * 保存をキャンセル操作のラベルとして表示するローカライズ済み文言。
         */
        saveCanceled: string;

        /**
         * 画像文書・である必要がある・saved操作のラベルとして表示するローカライズ済み文言。
         */
        imageDocumentMustBeSaved: string;
        /**
         * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
         * @param mime - 未対応と判定された貼り付け画像のMIMEタイプ。

         */
        unsupportedImage: (mime: string) => string;

        /**
         * 失敗または入力エラーの説明として表示するローカライズ済み文言。
         */
        invalidImageDirectory: string;

        /**
         * 表示項目「PDF用ブラウザー・unavailable」の文言として表示するローカライズ済み文言。
         */
        pdfBrowserUnavailable: string;

        /**
         * 失敗または入力エラーの説明として表示するローカライズ済み文言。
         */
        errorPrefix: string;

        /**
         * クライアントIDが一致しない場合に表示するローカライズ済み文言。
         */
        clientIdMismatch: string;

        /** Copilot Chatの選択範囲添付コマンドが利用できない場合の案内。 */
        copilotChatUnavailable: string;

        /** 文書変更後に選択本文が一致しない場合の案内。 */
        copilotSelectionChanged: string;

        /** クリップボードに有効なSVG文字列がない場合の案内。 */
        clipboardSvgInvalid: string;

        /** 既存タブを再利用せず添付用エディターを開けない場合の案内。 */
        copilotChatEditorUnavailable: string;
    };

    /** エディターと編集コマンドの表示文言をまとめる。 */
    editor: {
        /**
         * 入力欄のプレースホルダーとして表示するローカライズ済み文言。
         */
        placeholder: string;
        /**
         * 入力欄のプレースホルダーとして表示するローカライズ済み文言。
         */
        codePlaceholder: string;
        /**
         * 既定のリンク・label書式コマンドのラベルとして表示するローカライズ済み文言。
         */
        defaultLinkLabel: string;
        /**
         * 既定の画像・alt書式コマンドのラベルとして表示するローカライズ済み文言。
         */
        defaultImageAlt: string;
        /**
         * 表示項目「プレーンテキスト」の文言として表示するローカライズ済み文言。
         */
        plainText: string
    };

    /** UIには表示しない内部通知の文言をまとめる。 */
    internal: {
        /**
         * 表示項目「同時編集・overlap」の文言として表示するローカライズ済み文言。
         */
        concurrentEditsOverlap: string;
        /**
         * 表示項目「ルートが見つからない・found」の文言として表示するローカライズ済み文言。
         */
        rootNotFound: string
    };
}

/**
 * 表示文言で扱う値の種類と境界を表す型。
 */
type RawCatalog = Record<string, unknown>;
/**
 * 表示文言で扱う値の種類と境界を表す型。
 */
type RawLocales = Record<SupportedLanguage, RawCatalog>;
/**
 * 表示文言で扱う値の種類と境界を表す型。
 */
type Values = Record<string, string | number>;


/**
 * 表示文言で扱う一覧または対応表。
 */
const rawLocales = localeCatalog as RawLocales;

/**
 * ロケールコードの空白、大文字、区切り記号を正規化する。
 * @param value - 言語コードへ整形するロケール文字列。

 */
function normalizeLanguage(value: string | undefined): string {
    return (value ?? '').trim().toLowerCase().replace(/_/g, '-');
}

/**
 * VS Codeのlocale文字列から対応する表示言語を選ぶ。
 * @param value - 対応するUI言語を判定するロケール文字列。
 * @returns 対応する日本語・英語・中国語の言語コード。その他のlocaleではundefined。
 */
function languageFromLocale(value: string | undefined): SupportedLanguage | undefined {
    const normalized = normalizeLanguage(value);
    if (!normalized) return undefined;
    if (normalized === 'zh' || normalized.startsWith('zh-cn')) return 'zh-cn';
    const primary = normalized.split('-')[0];
    return (SUPPORTED_LANGUAGES as readonly string[]).includes(primary) ? primary as SupportedLanguage : undefined;
}

/**
 * 設定値とVS Codeのlocaleから使用する表示言語を選ぶ。
 * @param setting - ユーザーが選択した表示言語設定。
 * @param vscodeLanguage - 設定がautoまたは未指定の場合に使うVS Code表示言語。
 * @returns 対応する表示言語。明示設定が不正なら英語へフォールバックする。
 */
export function resolveLanguage(setting: string | undefined, vscodeLanguage?: string): SupportedLanguage {
    const normalized = normalizeLanguage(setting);
    if (normalized && normalized !== 'auto') return languageFromLocale(normalized) ?? 'en';
    return languageFromLocale(vscodeLanguage) ?? 'en';
}

/**
 * 選択した言語のローカライズ辞書を返す。
 * @param language - 読み込むロケールコード。
 * @returns 指定ロケールに対応するメッセージ辞書。
 */
function resolveCatalog(language: SupportedLanguage): RawCatalog {
    return rawLocales[language];
}

/**
 * ドット区切りキーで辞書を辿り、文字列値を返す。
 * @param catalog - dot区切りメッセージキーから文字列を取得するロケールカタログ。
 * @param key - ロケールカタログ内のdot区切りメッセージキー。
 * @returns 取得したメッセージ。キーがない場合や値が文字列でない場合は空文字。
 */
function read(catalog: RawCatalog, key: string): string {
    let value: unknown = catalog;
    for (const segment of key.split('.')) {
        if (!value || typeof value !== 'object') return '';
        value = (value as Record<string, unknown>)[segment];
    }
    return typeof value === 'string' ? value : '';
}

/**
 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
 * @param template - {name}形式のプレースホルダーを含むメッセージテンプレート。
 * @param values - テンプレート内placeholder名に対応する補間値辞書。

 */
function interpolate(template: string, values: Values = {}): string {
    return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g,
        /**
         * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
         * @param match - {name}形式で正規表現に一致したplaceholder全体。
         * @param key - 波括弧内から取り出した補間値キー。
         * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
         */
        (match, key: string) => (
            Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
        ));
}

/**
 * 指定言語のカタログから補間関数を含むメッセージ群を生成する。
 * @param language - メッセージを生成する対象ロケールコード。
 * @returns 指定言語のカタログから生成したMessages一式。
 */
function createMessages(language: SupportedLanguage): Messages {
    const raw = resolveCatalog(language) as Record<string, any>;


    const text = /**
     * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
     * @param key - ロケールカタログから取得するdot区切りメッセージキー。
     * @param values - 読み取ったメッセージ内placeholderへ埋め込む値辞書。

     */ (key: string, values?: Values): string => interpolate(read(raw, key), values);
    return {
        ribbon: {
            tabs: raw.ribbon.tabs,
            label: raw.ribbon.label,
            source: raw.ribbon.source,
            sourceTitle: raw.ribbon.sourceTitle,
            outline: raw.ribbon.outline,
            outlineTitle: raw.ribbon.outlineTitle,
            scrollSync: raw.ribbon.scrollSync,
            scrollSyncTitle: raw.ribbon.scrollSyncTitle,
            search: raw.ribbon.search,
            split: raw.ribbon.split,
            textOnly: raw.ribbon.textOnly,
            previewOnly: raw.ribbon.previewOnly,
            pin: raw.ribbon.pin,
            unpin: raw.ribbon.unpin,
            collapse: raw.ribbon.collapse,
            expand: raw.ribbon.expand,
            groups: raw.ribbon.groups,
            labels: {
                ...raw.ribbon.labels,


                heading: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param level - 表示する見出しレベル1から6。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (level: number) => text('ribbon.labels.heading', { level }),
                exportHtml: raw.ribbon.labels.exportHtml,
                embedImages: raw.ribbon.labels.embedImages,
                convertLinkedMarkdown: raw.ribbon.labels.convertLinkedMarkdown,
                showOutlineSidebar: raw.ribbon.labels.showOutlineSidebar,
                saveWithoutDialog: raw.ribbon.labels.saveWithoutDialog
            },
            featureDescriptions: raw.ribbon.labels.featureDescriptions,
            codeLanguages: raw.ribbon.codeLanguages,
            snippets: raw.ribbon.snippets,
            settings: {
                ...raw.ribbon.settings,
            }
        },
        app: {
            startup: raw.app.startup,
            outline: raw.app.outline,
            hideOutline: raw.app.hideOutline,
            showOutline: raw.app.showOutline,
            outlineWidth: raw.app.outlineWidth,
            copySectionLink: raw.app.copySectionLink,
            sectionAnchorLink: raw.app.sectionAnchorLink,
            sectionLinkMenu: raw.app.sectionLinkMenu,
            copyWorkspaceSectionLink: raw.app.copyWorkspaceSectionLink,
            workspaceSectionLinkUnavailable: raw.app.workspaceSectionLinkUnavailable,
            sectionLinkCopied: raw.app.sectionLinkCopied,
            noHeadings: raw.app.noHeadings,
            searchAndReplace: raw.app.searchAndReplace,
            searchText: raw.app.searchText,
            replacementText: raw.app.replacementText,
            replacement: raw.app.replacement,
            previousMatch: raw.app.previousMatch,
            nextMatch: raw.app.nextMatch,
            replaceAll: raw.app.replaceAll,
            close: raw.app.close,
            splitBoundary: raw.app.splitBoundary,
            selectionFormatting: raw.app.selectionFormatting,
            diagnosticsTitle: raw.app.diagnosticsTitle,
            diagnosticHelp: raw.app.diagnosticHelp,
            noProblems: raw.app.noProblems,
            severity: raw.app.severity,


            line: /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param line - 表示する行番号（1始まり）。
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             */ (line: number) => text('app.line', { line }),
            printSettings: raw.app.printSettings,
            printSettingsHelp: raw.app.printSettingsHelp,
            paper: raw.app.paper,
            orientation: raw.app.orientation,
            portrait: raw.app.portrait,
            landscape: raw.app.landscape,
            header: raw.app.header,
            footer: raw.app.footer,
            margins: raw.app.margins,
            top: raw.app.top,
            right: raw.app.right,
            bottom: raw.app.bottom,
            left: raw.app.left,
            withoutDialog: raw.app.withoutDialog,
            typography: raw.app.typography,
            fontFamily: raw.app.fontFamily,
            bodyFontSize: raw.app.bodyFontSize,
            headingFontSizes: raw.app.headingFontSizes,
            codeFontSize: raw.app.codeFontSize,
            lineHeight: raw.app.lineHeight,
            paragraphSpacing: raw.app.paragraphSpacing,
            outputReplacementRules: raw.app.outputReplacementRules,
            outputReplacementHelp: raw.app.outputReplacementHelp,
            outputReplacementPattern: raw.app.outputReplacementPattern,
            outputReplacementText: raw.app.outputReplacementText,
            addOutputReplacementRule: raw.app.addOutputReplacementRule,
            removeOutputReplacementRule: raw.app.removeOutputReplacementRule,
            removeOutputReplacementRuleShort: raw.app.removeOutputReplacementRuleShort,
            invalidOutputReplacementPattern: raw.app.invalidOutputReplacementPattern,
            outputReplacementTimeout: raw.app.outputReplacementTimeout,
            outputReplacementFailed: raw.app.outputReplacementFailed,
            marpPreview: {
                title: raw.app.marpPreview.title,
                loading: raw.app.marpPreview.loading,
                failed: raw.app.marpPreview.failed,
                detectionFailed: raw.app.marpPreview.detectionFailed,
                slideLabel: (index: number) => text('app.marpPreview.slideLabel', { index })
            },
            status: {
                modeSplit: raw.app.status.modeSplit,
                modePreview: raw.app.status.modePreview,


                lines: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param count - 文書内の行数。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (count: number) => text('app.status.lines', { count }),


                textCharacters: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param count - 編集本文の文字数。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (count: number) => text('app.status.textCharacters', { count }),


                markdownCharacters: /**
                 * 表示文言の変更または利用者の操作意図を記録し、後続処理へ渡す。
                 * @param count - Markdown本文の文字数。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (count: number) => text('app.status.markdownCharacters', { count }),


                zoom: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param percent - ステータスに表示するズーム倍率（百分率）。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (percent: number) => text('app.status.zoom', { percent }),
                syncing: raw.app.status.syncing,
                synced: raw.app.status.synced
            },
            inspector: raw.app.inspector,
            imagePreview: raw.app.imagePreview,
            link: raw.app.link,
            previewImageContextMenu: raw.app.previewImageContextMenu,
            textColor: raw.app.textColor,
            imageControls: raw.app.imageControls,
            pdfPreview: {
                zoomOut: raw.app.pdfPreview.zoomOut,
                zoomIn: raw.app.pdfPreview.zoomIn,
                unavailable: raw.app.pdfPreview.unavailable,
                generating: raw.app.pdfPreview.generating,
                drawing: raw.app.pdfPreview.drawing,
                preparing: raw.app.pdfPreview.preparing,
                loading: raw.app.pdfPreview.loading,
                webviewUnavailable: raw.app.pdfPreview.webviewUnavailable,
                failed: (detail: string) => text('app.pdfPreview.failed', { detail }),
                pageError: raw.app.pdfPreview.pageError,
                pageLabel: (page: number) => text('app.pdfPreview.pageLabel', { page })
            },
            tableEditor: {
                title: raw.app.tableEditor.title,
                close: raw.app.tableEditor.close,
                addRow: raw.app.tableEditor.addRow,
                deleteRow: raw.app.tableEditor.deleteRow,
                addColumn: raw.app.tableEditor.addColumn,
                deleteColumn: raw.app.tableEditor.deleteColumn,
                alignLeft: raw.app.tableEditor.alignLeft,
                alignCenter: raw.app.tableEditor.alignCenter,
                alignRight: raw.app.tableEditor.alignRight,
                clearAlignment: raw.app.tableEditor.clearAlignment,
                copyTsv: raw.app.tableEditor.copyTsv,
                copyColumn: raw.app.tableEditor.copyColumn,
                copyRow: raw.app.tableEditor.copyRow,
                cancel: raw.app.tableEditor.cancel,
                apply: raw.app.tableEditor.apply,
                navigationHint: raw.app.tableEditor.navigationHint,
                sourceEditorRequired: raw.app.tableEditor.sourceEditorRequired,
                tableRequired: raw.app.tableEditor.tableRequired,


                rowColumnLimit: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param rows - 表編集で許可する最大行数。
                 * @param columns - 表編集で許可する最大列数。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (rows: number, columns: number) => text('app.tableEditor.rowColumnLimit', { rows, columns }),
                copied: raw.app.tableEditor.copied,
                sourceEditorClosed: raw.app.tableEditor.sourceEditorClosed,
                documentChanged: raw.app.tableEditor.documentChanged,
                resizeColumn: raw.app.tableEditor.resizeColumn,
                resizeRow: raw.app.tableEditor.resizeRow,
                resizeEditor: raw.app.tableEditor.resizeEditor,
                modified: raw.app.tableEditor.modified,
                discard: raw.app.tableEditor.discard,
                selection: raw.app.tableEditor.selection,
                cells: raw.app.tableEditor.cells,
                selectAll: raw.app.tableEditor.selectAll,
                dragRow: raw.app.tableEditor.dragRow,
                dragColumn: raw.app.tableEditor.dragColumn,
                moveRowUp: raw.app.tableEditor.moveRowUp,
                moveRowDown: raw.app.tableEditor.moveRowDown,
                moveColumnLeft: raw.app.tableEditor.moveColumnLeft,
                moveColumnRight: raw.app.tableEditor.moveColumnRight,
                sortAscending: raw.app.tableEditor.sortAscending,
                sortDescending: raw.app.tableEditor.sortDescending
            },
            help: raw.app.help,
            toast: {


                imagesSaved: /**
                 * 表示文言の入力を検証し、表示または保存に使う形式へ変換する。
                 * @param count - 保存した画像ファイル数。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (count: number) => text('app.toast.imagesSaved', { count }),


                pdfResourceWarnings: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param count - PDF出力前に検出したローカルリソース警告数。
                 * @param detail - 警告の概要として通知に追加する文字列。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (count: number, detail: string) => text('app.toast.pdfResourceWarnings', { count, detail }),


                preflightSummary: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param errors - 事前検査で検出したエラーの件数。
                 * @param warnings - 事前検査で検出した警告の件数。
                 * @param infos - 事前検査で検出した情報項目の件数。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (errors: number, warnings: number, infos: number) => text('app.toast.preflightSummary', { errors, warnings, infos }),


                imageSaveFailed: /**
                 * 表示文言の入力を検証し、表示または保存に使う形式へ変換する。
                 * @param detail - 画像保存失敗の理由として通知に追加する詳細。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (detail: string) => text('app.toast.imageSaveFailed', { detail }),


                pdfExportFailed: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param detail - PDF出力失敗の理由として通知に追加する詳細。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (detail: string) => text('app.toast.pdfExportFailed', { detail }),


                resourceCheckFailed: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param detail - ローカルリソース検査失敗の理由として通知に追加する詳細。
                 * @param duringPdf - PDF出力中の検査ならtrue。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (detail: string, duringPdf: boolean) => text('app.toast.resourceCheckFailed', { prefix: duringPdf ? `${raw.host.pdfProgress} ` : '', detail }),


                operationFailed: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param detail - 操作失敗の理由として通知に追加する詳細。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (detail: string) => text('app.toast.operationFailed', { detail }),


                pdfExported: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param path - 読み書きするファイルまたはリソースの場所。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (path: string) => text('app.toast.pdfExported', { path }),


                htmlExported: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param path - 読み書きするファイルまたはリソースの場所。
                 * @param count - 書き出したHTML文書数。

                 */ (path: string, count: number) => text('app.toast.htmlExported', { path, count }),


                htmlExportFailed: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param detail - HTML出力失敗の理由として通知に追加する詳細。

                 */ (detail: string) => text('app.toast.htmlExportFailed', { detail }),
                tableCellRequired: raw.app.toast.tableCellRequired,
                cannotPasteTsv: raw.app.toast.cannotPasteTsv,
                tableCopied: raw.app.toast.tableCopied,


                cannotCopyTsv: /**
                 * 表示文言の条件を判定する。
                 * @param detail - TSVをコピーできなかった理由の補足。未指定なら空選択用の文言を使う。
                 * @returns TSVをコピーできなかった理由を示すローカライズ済みメッセージ。
                 */ (detail?: string) => detail ? text('app.toast.cannotCopyTsv', { detail }) : raw.app.toast.cannotCopyTsvEmpty,
                workspaceTrustRequired: raw.app.toast.workspaceTrustRequired,


                pdfStartedWithDiagnostics: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param count - PDF出力前に検出した警告数。
                 * @param detail - 診断内容の概要として通知に追加する文字列。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (count: number, detail: string) => text('app.toast.pdfStartedWithDiagnostics', { count, detail }),


                pdfFallbackToMarkdown: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param detail - Markdownへのフォールバック理由。指定時は進捗文言の前へ付ける。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (detail?: string) => text('app.toast.pdfFallbackToMarkdown', { prefix: detail ? `${detail} ` : '' })
            },
            errors: {
                ackMismatch: raw.app.errors.ackMismatch,


                pendingOperationChain: /**
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 * @param opId - 完了を待っている操作の識別子。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (opId: string) => text('app.errors.pendingOperationChain', { opId }),
                clipboardUnavailable: raw.app.errors.clipboardUnavailable,
                bmpConversion: raw.app.errors.bmpConversion,


                imageSize: /**
                 * 表示文言の入力を検証し、表示または保存に使う形式へ変換する。
                 * @param maxSizeMb - 許可する画像ファイルの最大サイズ（MB）。
                 * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
                 */ (maxSizeMb: number) => text('app.errors.imageSize', { maxSizeMb })
            }
        },
        renderer: {
            ...raw.renderer,
            mermaidRendering: text('renderer.mermaidRendering'),
            mermaidDiagramLabel: (description: string) => text('renderer.mermaidDiagramLabel', { description })
        },
        diagnostics: {


            unclosedFence: /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param marker - 表示文言で受け渡す文字列。
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             */ (marker: string) => text('diagnostics.unclosedFence', { marker }),


            duplicateHeading: /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param id - 重複が検出された見出しanchor ID。
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             */ (id: string) => text('diagnostics.duplicateHeading', { id }),
            invalidTableSeparator: raw.diagnostics.invalidTableSeparator,
            emptyImageAlt: raw.diagnostics.emptyImageAlt,


            localImageCheck: /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param source - ローカル画像として検査する参照文字列。
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             */ (source: string) => text('diagnostics.localImageCheck', { source }),
            emptyTableHeader: raw.diagnostics.emptyTableHeader,


            tableColumnMismatch: /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param header - Markdown表ヘッダー行の列数。
             * @param count - 区切り行または本文行で見つかった列数。
             * @param kind - 列数が一致しない行の種別。
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             */ (header: number, count: number, kind: 'separator' | 'body') => text('diagnostics.tableColumnMismatch', { header, count, kind: raw.diagnostics.tableKind[kind] }),


            missingReference: /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param label - エラーメッセージに埋め込む未定義参照ラベル。
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             */ (label: string) => text('diagnostics.missingReference', { label }),


            localResource: /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param kind - 検査対象が画像参照かリンク参照かを示す種別。
             * @param missing - 参照先が存在しない場合true。
             * @param source - 診断対象のローカルリソース参照。
             * @param detail - 参照先検査の結果または失敗理由を補う詳細文。
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             */ (kind: 'image' | 'link', missing: boolean, source: string, detail: string) => {
                    const suffix = kind === 'image' ? (missing ? 'imageMissing' : 'imageCheckFailed') : (missing ? 'linkMissing' : 'linkCheckFailed');
                    return text(`diagnostics.localResource.${suffix}`, { source, detail });
                }
        },
        host: {
            pdfTrustRequired: raw.host.pdfTrustRequired,
            pdfProgress: raw.host.pdfProgress,


            pdfExported: /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param path - 読み書きするファイルまたはリソースの場所。
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             */ (path: string) => text('host.pdfExported', { path }),
            htmlTrustRequired: raw.host.htmlTrustRequired,
            htmlProgress: raw.host.htmlProgress,


            htmlExported: /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param path - 読み書きするファイルまたはリソースの場所。
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             */ (path: string) => text('host.htmlExported', { path }),
            open: raw.host.open,
            saveCanceled: raw.host.saveCanceled,
            imageDocumentMustBeSaved: raw.host.imageDocumentMustBeSaved,


            unsupportedImage: /**
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             * @param mime - 未対応と判定された貼り付け画像のMIMEタイプ。
             * 引数を補間し、利用者へ状態や結果を伝えるローカライズ済み文言を組み立てる。
             */ (mime: string) => text('host.unsupportedImage', { mime }),
            invalidImageDirectory: raw.host.invalidImageDirectory,
            pdfBrowserUnavailable: raw.host.pdfBrowserUnavailable,
            errorPrefix: raw.host.errorPrefix,
            clientIdMismatch: raw.host.clientIdMismatch,
            copilotChatUnavailable: raw.host.copilotChatUnavailable,
            copilotSelectionChanged: raw.host.copilotSelectionChanged,
            clipboardSvgInvalid: raw.host.clipboardSvgInvalid,
            copilotChatEditorUnavailable: raw.host.copilotChatEditorUnavailable
        },
        editor: raw.editor,
        internal: raw.internal
    };
}

/**
 * 選択した言語の文言辞書を返し、未登録キーは日本語、英語、キー名の順に補う。
 * @param language - 優先する表示言語。未指定またはautoならVS Codeの言語を参照する。
 * @param vscodeLanguage - 明示設定がない場合に使うVS Codeの表示言語。
 * @returns 表示文言と、引数を補間するメッセージ関数を含む辞書。
 */
export function getMessages(language: SupportedLanguage | string | undefined, vscodeLanguage?: string): Messages {
    return MESSAGE_CATALOG[resolveLanguage(language, vscodeLanguage)];
}


/**
 * 対応する全言語の表示文言を保持する辞書。
 */
export const MESSAGE_CATALOG: Record<SupportedLanguage, Messages> = Object.fromEntries(
    SUPPORTED_LANGUAGES.map(
        /**
         * 各言語のメッセージ群を生成し、言語コードとの組にする。
         * @param language - メッセージ群を生成する言語コード。
         * @returns 言語コードとMessagesの組。

         */
        (language) => [language, createMessages(language)])
) as Record<SupportedLanguage, Messages>;
