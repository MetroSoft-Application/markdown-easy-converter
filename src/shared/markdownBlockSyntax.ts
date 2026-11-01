/**
 * @fileoverview プレビュー描画と見出しリンク解決で共有するMarkdownブロック構文。
 */

/** 数式ブロックの解析規則。 */
export function mathBlockSyntax() {
    return {
        name: 'mathBlock',
        level: 'block' as const,
        start(source: string): number | undefined {
            const found = source.indexOf('$$');
            return found >= 0 ? found : undefined;
        },
        tokenizer(source: string) {
            const match = /^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$(?:\n|$)/.exec(source);
            if (!match) return undefined;
            return { type: 'mathBlock', raw: match[0], text: match[1].trim() };
        }
    };
}

/** 目次マーカーの解析規則。 */
export function tableOfContentsSyntax() {
    return {
        name: 'tableOfContents',
        level: 'block' as const,
        start(source: string): number | undefined {
            const match = /^\[toc]\s*$/im.exec(source);
            return match?.index;
        },
        tokenizer(source: string) {
            const match = /^\[toc]\s*(?:\r\n|\r|\n|$)/i.exec(source);
            if (!match) return undefined;
            return { type: 'tableOfContents', raw: match[0], text: '' };
        }
    };
}

/** 脚注定義の解析規則。 */
export function footnoteDefinitionSyntax() {
    return {
        name: 'footnoteDefinition',
        level: 'block' as const,
        start(source: string): number | undefined {
            const match = /^\[\^[^\]]+]\s*:/m.exec(source);
            return match?.index;
        },
        tokenizer(source: string) {
            const match = /^\[\^([^\]]+)]\s*:\s*([^\r\n]+)(?:\r\n|\r|\n|$)/.exec(source);
            if (!match) return undefined;
            return { type: 'footnoteDefinition', raw: match[0], text: match[2], id: match[1] };
        }
    };
}
