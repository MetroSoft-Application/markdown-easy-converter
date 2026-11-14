/**
 * @fileoverview KaTeXが出力したMathMLを、Wordのネイティブ数式（OMML）の文字列へ変換する。
 * 実行境界: ブラウザー内（docx-extract.js）。DOMのElementを読むだけで、DOMを変更しない。
 * 対応はKaTeXが出力する要素の部分集合に限り、未対応の要素を含む式は`UnsupportedMathError`を投げる。
 * 呼び出し側はその式だけを画像へ切り替えるため、ここで推測による近似出力はしない。
 * 出力は`m:oMath`（行内）または`m:oMathPara`（独立）の要素文字列で、名前空間宣言は文書側が持つ。
 */

/** 変換できないMathML要素を含む式。メッセージは利用者向けの警告にそのまま使える短い英文とする。 */
export class UnsupportedMathError extends Error {
    /** @param element - 対応していない要素名。 */
    constructor(element: string) {
        super(`unsupported MathML element <${element}>`);
        this.name = 'UnsupportedMathError';
    }
}

/** 総和・積分など、直後の項を被演算子として取るn項演算子。OMMLではm:naryで表す。 */
const NARY_OPERATORS = new Set([
    '∑', '∏', '∐', '∫', '∬', '∭', '∮', '∯', '∰', '⋃', '⋂', '⋁', '⋀', '⨁', '⨂', '⨀', '⨄', '⨆'
]);

/**
 * n項演算子の被演算子を打ち切る演算子。`\sum a_i = b`の`= b`を総和の中へ入れないための区切りで、
 * 関係演算子と加減・区切り記号に限る。
 */
const OPERAND_TERMINATORS = new Set([
    '=', '<', '>', '≤', '≥', '≠', '≈', '≡', '∼', '≃', '≅', '∝', '→', '←', '↔', '⇒', '⇐', '⇔',
    '∈', '∉', '⊂', '⊃', '⊆', '⊇', ',', ';', '+', '−', '-', '±', '∓'
]);

/** 上付きのアクセント記号。m:accで表す。上線・波括弧は別の構造（m:bar、m:groupChr）で扱う。 */
const ACCENT_CHARACTERS = new Set([
    '^', 'ˆ', '̂', '~', '˜', '̃', '¨', '̈', '˙', '̇', '´', '̀', '`', 'ˇ', '̌', '˘', '̆', '→', '⃗', '←', '⃖', '↔', '⃡', '°', '˚'
]);

/** 上線・下線として扱う記号。KaTeXの`\overline`・`\underline`は伸縮するこれらの記号を使う。 */
const BAR_CHARACTERS = new Set(['‾', '¯', '_', '―', '─', '̅', '̲']);

/** 上下の波括弧など、式全体にかかるグループ記号。m:groupChrで表す。 */
const GROUP_CHARACTERS = new Set(['⏞', '⏟', '⏜', '⏝', '⎴', '⎵']);

/** 表示されない演算子（関数適用、不可視の乗算・区切り・加算）。Wordの数式では不要なため出力しない。 */
const INVISIBLE_OPERATORS = /^[\u2061-\u2064]+$/;

/**
 * KaTeXのMathML（`<math>`要素）をOMMLへ変換する。
 * @param math - `.katex-mathml`内の`math`要素。
 * @param display - 独立した数式段落として出力するときtrue。
 * @returns `m:oMath`、または`display`のとき`m:oMathPara`で包んだ要素文字列。
 * @throws UnsupportedMathError - 対応していない要素を含む場合。
 */
export function mathmlToOmml(math: Element, display: boolean): string {
    const content = `<m:oMath>${convertSequence(elementChildren(math))}</m:oMath>`;
    return display ? `<m:oMathPara>${content}</m:oMathPara>` : content;
}

/**
 * 要素の子要素だけを返す。KaTeXの`<math>`には、サニタイズで`annotation`タグが外れたTeX原文の
 * テキストノードが残るため、テキストノードは常に無視する。
 * @param element - 子要素を列挙する要素。
 * @returns 子要素の配列。
 */
function elementChildren(element: Element): Element[] {
    return Array.from(element.children);
}

/**
 * 兄弟要素の並びを変換する。n項演算子は後続の項を被演算子として取り込む。
 * @param nodes - 同じ階層の要素の並び。
 * @returns 連結したOMML。
 */
function convertSequence(nodes: readonly Element[]): string {
    let result = '';
    for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        const nary = naryParts(node);
        if (!nary) {
            result += convert(node);
            continue;
        }
        // 被演算子は次の関係演算子・加減記号の手前まで。区切りがなければ並びの最後まで。
        let end = index + 1;
        while (end < nodes.length && !isOperandTerminator(nodes[end])) end += 1;
        result += convertNary(nary, nodes.slice(index + 1, end));
        index = end - 1;
    }
    return result;
}

/** n項演算子の記号と上下の添字。 */
interface NaryParts {
    /** 演算子の文字。 */
    character: string;
    /** 添字を真上・真下に置く（munder系）ときtrue、右肩（msub系）のときfalse。 */
    underOver: boolean;
    /** 下の添字。なければundefined。 */
    lower?: Element;
    /** 上の添字。なければundefined。 */
    upper?: Element;
}

/**
 * 要素がn項演算子（単独の`mo`、または添字付きの`mo`）なら、その構成要素を返す。
 * @param node - 判定する要素。
 * @returns n項演算子の構成要素。該当しなければundefined。
 */
function naryParts(node: Element): NaryParts | undefined {
    const name = node.localName;
    if (name === 'mo') {
        const character = (node.textContent ?? '').trim();
        return NARY_OPERATORS.has(character) ? { character, underOver: false } : undefined;
    }
    const scripted: Record<string, { underOver: boolean; lower?: number; upper?: number }> = {
        msub: { underOver: false, lower: 1 },
        msup: { underOver: false, upper: 1 },
        msubsup: { underOver: false, lower: 1, upper: 2 },
        munder: { underOver: true, lower: 1 },
        mover: { underOver: true, upper: 1 },
        munderover: { underOver: true, lower: 1, upper: 2 }
    };
    const layout = scripted[name];
    if (!layout) return undefined;
    const children = elementChildren(node);
    const base = children[0];
    if (!base || base.localName !== 'mo') return undefined;
    const character = (base.textContent ?? '').trim();
    if (!NARY_OPERATORS.has(character)) return undefined;
    return {
        character,
        underOver: layout.underOver,
        lower: layout.lower === undefined ? undefined : children[layout.lower],
        upper: layout.upper === undefined ? undefined : children[layout.upper]
    };
}

/**
 * n項演算子の被演算子の終わりを示す要素か判定する。
 * @param node - 判定する要素。
 * @returns 関係演算子・加減・区切りの`mo`ならtrue。
 */
function isOperandTerminator(node: Element): boolean {
    return node.localName === 'mo' && OPERAND_TERMINATORS.has((node.textContent ?? '').trim());
}

/**
 * n項演算子をm:naryへ変換する。添字がない側はWordの空枠を出さないよう非表示にする。
 * @param parts - 演算子と添字。
 * @param operand - 被演算子の要素の並び。
 * @returns m:nary要素。
 */
function convertNary(parts: NaryParts, operand: readonly Element[]): string {
    const properties = `<m:chr m:val="${escapeXml(parts.character)}"/>`
        + `<m:limLoc m:val="${parts.underOver ? 'undOvr' : 'subSup'}"/>`
        + (parts.lower ? '' : '<m:subHide m:val="1"/>')
        + (parts.upper ? '' : '<m:supHide m:val="1"/>');
    return `<m:nary><m:naryPr>${properties}</m:naryPr>`
        + `<m:sub>${parts.lower ? convert(parts.lower) : ''}</m:sub>`
        + `<m:sup>${parts.upper ? convert(parts.upper) : ''}</m:sup>`
        + `<m:e>${convertSequence(operand)}</m:e></m:nary>`;
}

/**
 * 1つのMathML要素をOMMLへ変換する。
 * @param node - 変換する要素。
 * @returns OMML。表示しない要素は空文字列。
 * @throws UnsupportedMathError - 対応していない要素の場合。
 */
function convert(node: Element): string {
    const children = elementChildren(node);
    switch (node.localName) {
        case 'mrow':
            return convertRow(node, children);
        case 'mstyle':
        case 'mpadded':
        case 'mtd':
            return convertSequence(children);
        case 'semantics':
            // 最初の子が表示用の式で、残りはannotation（TeX原文など）。
            return children[0] ? convert(children[0]) : '';
        case 'annotation':
        case 'annotation-xml':
        case 'mphantom':
            return '';
        case 'mi':
            return run(node.textContent ?? '', identifierStyle(node));
        case 'mn':
            return run(node.textContent ?? '', variantStyle(node.getAttribute('mathvariant')) ?? '');
        case 'mo': {
            const text = node.textContent ?? '';
            if (INVISIBLE_OPERATORS.test(text)) return '';
            return run(text, '<m:sty m:val="p"/>');
        }
        case 'mtext':
        case 'ms':
        case 'merror':
            return run(node.textContent ?? '', '<m:sty m:val="p"/>');
        case 'mspace':
            return run(spaceFor(node.getAttribute('width')), '<m:sty m:val="p"/>');
        case 'msup':
            requireChildren(node, children, 2);
            return `<m:sSup><m:e>${convert(children[0])}</m:e><m:sup>${convert(children[1])}</m:sup></m:sSup>`;
        case 'msub':
            requireChildren(node, children, 2);
            return `<m:sSub><m:e>${convert(children[0])}</m:e><m:sub>${convert(children[1])}</m:sub></m:sSub>`;
        case 'msubsup':
            requireChildren(node, children, 3);
            return `<m:sSubSup><m:e>${convert(children[0])}</m:e><m:sub>${convert(children[1])}</m:sub>`
                + `<m:sup>${convert(children[2])}</m:sup></m:sSubSup>`;
        case 'mfrac': {
            requireChildren(node, children, 2);
            const thickness = (node.getAttribute('linethickness') ?? '').trim();
            // linethickness=0 は \binom などの線のない分数。
            const noBar = /^0+(?:\.0*)?(?:[a-z]+)?$/i.test(thickness);
            return `<m:f>${noBar ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : ''}`
                + `<m:num>${convert(children[0])}</m:num><m:den>${convert(children[1])}</m:den></m:f>`;
        }
        case 'msqrt':
            return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${convertSequence(children)}</m:e></m:rad>`;
        case 'mroot':
            requireChildren(node, children, 2);
            return `<m:rad><m:deg>${convert(children[1])}</m:deg><m:e>${convert(children[0])}</m:e></m:rad>`;
        case 'mover':
            requireChildren(node, children, 2);
            return convertOver(node, children[0], children[1]);
        case 'munder':
            requireChildren(node, children, 2);
            return convertUnder(children[0], children[1]);
        case 'munderover':
            requireChildren(node, children, 3);
            return `<m:limUpp><m:e>${convertUnder(children[0], children[1])}</m:e>`
                + `<m:lim>${convert(children[2])}</m:lim></m:limUpp>`;
        case 'mtable':
            return convertTable(node, children);
        case 'menclose':
            return convertEnclose(node, children);
        case 'mfenced': {
            const open = node.getAttribute('open') ?? '(';
            const close = node.getAttribute('close') ?? ')';
            return delimiter(open, close, convertSequence(children));
        }
        default:
            throw new UnsupportedMathError(node.localName);
    }
}

/**
 * `mrow`を変換する。先頭と末尾がfence属性付きの`mo`（`\left`・`\right`）なら伸縮する括弧m:dにする。
 * KaTeXは通常の括弧を`stretchy="false"`で出すため、fence属性のない括弧は文字のまま残す。
 * @param node - mrow要素。
 * @param children - その子要素。
 * @returns OMML。
 */
function convertRow(node: Element, children: readonly Element[]): string {
    const first = children[0];
    const last = children[children.length - 1];
    if (children.length >= 2 && isFence(first) && isFence(last)) {
        return delimiter(first.textContent ?? '', last.textContent ?? '', convertSequence(children.slice(1, -1)));
    }
    return convertSequence(children);
}

/**
 * 伸縮する括弧として指定された`mo`か判定する。
 * @param node - 判定する要素。
 * @returns fence="true"の`mo`ならtrue。
 */
function isFence(node: Element | undefined): boolean {
    return node?.localName === 'mo' && node.getAttribute('fence') === 'true';
}

/**
 * 括弧で囲んだ式（m:d）を作る。`\left.`のように片側がない括弧は空文字で表す。
 * @param open - 開き括弧の文字。
 * @param close - 閉じ括弧の文字。
 * @param content - 括弧内のOMML。
 * @returns m:d要素。
 */
function delimiter(open: string, close: string, content: string): string {
    return `<m:d><m:dPr><m:begChr m:val="${escapeXml(open.trim())}"/><m:endChr m:val="${escapeXml(close.trim())}"/></m:dPr>`
        + `<m:e>${content}</m:e></m:d>`;
}

/**
 * `mover`を、アクセント・上線・グループ記号・上限（m:limUpp）のいずれかへ変換する。
 * @param node - mover要素。accent属性を参照する。
 * @param base - 本体。
 * @param over - 上に置く要素。
 * @returns OMML。
 */
function convertOver(node: Element, base: Element, over: Element): string {
    const mark = over.localName === 'mo' ? (over.textContent ?? '').trim() : '';
    if (BAR_CHARACTERS.has(mark)) {
        return `<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${convert(base)}</m:e></m:bar>`;
    }
    if (GROUP_CHARACTERS.has(mark)) {
        return `<m:groupChr><m:groupChrPr><m:chr m:val="${escapeXml(mark)}"/><m:pos m:val="top"/><m:vertJc m:val="bot"/></m:groupChrPr>`
            + `<m:e>${convert(base)}</m:e></m:groupChr>`;
    }
    if (mark && (node.getAttribute('accent') === 'true' || ACCENT_CHARACTERS.has(mark)) && [...mark].length === 1) {
        return `<m:acc><m:accPr><m:chr m:val="${escapeXml(mark)}"/></m:accPr><m:e>${convert(base)}</m:e></m:acc>`;
    }
    return `<m:limUpp><m:e>${convert(base)}</m:e><m:lim>${convert(over)}</m:lim></m:limUpp>`;
}

/**
 * `munder`を、下線・グループ記号・下限（m:limLow、`\lim_{x\to 0}`など）のいずれかへ変換する。
 * @param base - 本体。
 * @param under - 下に置く要素。
 * @returns OMML。
 */
function convertUnder(base: Element, under: Element): string {
    const mark = under.localName === 'mo' ? (under.textContent ?? '').trim() : '';
    if (BAR_CHARACTERS.has(mark)) {
        return `<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr><m:e>${convert(base)}</m:e></m:bar>`;
    }
    if (GROUP_CHARACTERS.has(mark)) {
        return `<m:groupChr><m:groupChrPr><m:chr m:val="${escapeXml(mark)}"/></m:groupChrPr><m:e>${convert(base)}</m:e></m:groupChr>`;
    }
    return `<m:limLow><m:e>${convert(base)}</m:e><m:lim>${convert(under)}</m:lim></m:limLow>`;
}

/**
 * `mtable`（行列、`aligned`などの揃え）をm:mへ変換する。各列の揃えはcolumnalign属性を写す。
 * `mlabeledtr`の先頭セル（式番号）は出力しない。列数が足りない行は空セルで埋める。
 * @param node - mtable要素。
 * @param rows - 行要素（mtr、mlabeledtr）。
 * @returns m:m要素。
 * @throws UnsupportedMathError - 行以外の子要素がある場合。
 */
function convertTable(node: Element, rows: readonly Element[]): string {
    const cellRows = rows.map((row) => {
        if (row.localName !== 'mtr' && row.localName !== 'mlabeledtr') throw new UnsupportedMathError(row.localName);
        const cells = elementChildren(row);
        return row.localName === 'mlabeledtr' ? cells.slice(1) : cells;
    });
    const columnCount = Math.max(1, ...cellRows.map((cells) => cells.length));
    const alignments = (node.getAttribute('columnalign') ?? '').trim().split(/\s+/).filter(Boolean);
    // `aligned`・`align`（右揃えと左揃えの列が交互）は、Wordが同じ式を保存するときと同じ揃え付きの数式配列にする。
    // 各セルの境目（LaTeXの`&`）を揃えの位置（m:aln）にする。行列（m:m）では列の間が空き、Word以外で演算子が崩れる。
    if (columnCount >= 2 && alignments.length >= 2
        && alignments.every((value, index) => value === (index % 2 === 0 ? 'right' : 'left'))) {
        const rowsXml = cellRows.map((cells) => `<m:e>${cells.map((cell, index) =>
            index === 0 ? convert(cell) : withAlignmentPoint(convert(cell))).join('')}</m:e>`).join('');
        return `<m:eqArr>${rowsXml}</m:eqArr>`;
    }
    const columns = Array.from({ length: columnCount }, (_, index) => {
        // columnalignは列数より短い場合、最後の値を繰り返す。
        const value = alignments[Math.min(index, alignments.length - 1)] ?? 'center';
        const justification = value === 'left' ? 'left' : value === 'right' ? 'right' : 'center';
        return `<m:mc><m:mcPr><m:count m:val="1"/><m:mcJc m:val="${justification}"/></m:mcPr></m:mc>`;
    }).join('');
    const body = cellRows.map((cells) => {
        const entries = Array.from({ length: columnCount }, (_, index) =>
            `<m:e>${cells[index] ? convert(cells[index]) : ''}</m:e>`).join('');
        return `<m:mr>${entries}</m:mr>`;
    }).join('');
    return `<m:m><m:mPr><m:mcs>${columns}</m:mcs></m:mPr>${body}</m:m>`;
}

/**
 * 数式配列の揃えの位置（m:aln）を、セルの最初の文字列（m:r）に付ける。
 * m:rPrの子はlit、(nor | scr, sty)、brk、alnの順のため、alnは末尾に置く。
 * 先頭が文字列でない（分数などで始まる）セルには、揃えの位置だけを持つ空の文字列を前に置く。
 * @param omml - セルのOMML。
 * @returns 揃えの位置を付けたOMML。
 */
function withAlignmentPoint(omml: string): string {
    if (omml.startsWith('<m:r><m:rPr>')) return omml.replace('</m:rPr>', '<m:aln/></m:rPr>');
    if (omml.startsWith('<m:r>')) return `<m:r><m:rPr><m:aln/></m:rPr>${omml.slice('<m:r>'.length)}`;
    return `<m:r><m:rPr><m:aln/></m:rPr><m:t></m:t></m:r>${omml}`;
}

/**
 * `menclose`を枠（m:borderBox）へ変換する。斜線（`\cancel`など）は枠を隠して斜線だけを引く。
 * @param node - menclose要素。
 * @param children - 囲まれる要素。
 * @returns m:borderBox要素。
 * @throws UnsupportedMathError - 枠と斜線以外のnotationの場合。
 */
function convertEnclose(node: Element, children: readonly Element[]): string {
    const notations = (node.getAttribute('notation') ?? 'longdiv').trim().split(/\s+/);
    const content = `<m:e>${convertSequence(children)}</m:e>`;
    if (notations.every((notation) => notation === 'box' || notation === 'roundedbox')) {
        return `<m:borderBox>${content}</m:borderBox>`;
    }
    const strikes: Record<string, string> = {
        updiagonalstrike: '<m:strikeBLTR m:val="1"/>',
        downdiagonalstrike: '<m:strikeTLBR m:val="1"/>',
        horizontalstrike: '<m:strikeH m:val="1"/>',
        verticalstrike: '<m:strikeV m:val="1"/>'
    };
    if (!notations.every((notation) => notation in strikes)) throw new UnsupportedMathError(`menclose notation="${notations.join(' ')}"`);
    const hidden = '<m:hideTop m:val="1"/><m:hideBot m:val="1"/><m:hideLeft m:val="1"/><m:hideRight m:val="1"/>';
    // m:borderBoxPrの子はスキーマ順（strikeH, strikeV, strikeBLTR, strikeTLBR）に並べる。notationの記述順には従わない。
    const order = ['horizontalstrike', 'verticalstrike', 'updiagonalstrike', 'downdiagonalstrike'];
    const lines = order.filter((notation) => notations.includes(notation)).map((notation) => strikes[notation]).join('');
    return `<m:borderBox><m:borderBoxPr>${hidden}${lines}</m:borderBoxPr>${content}</m:borderBox>`;
}

/**
 * 子要素の数がMathMLの規定どおりか確かめる。
 * @param node - 検査する要素。
 * @param children - その子要素。
 * @param count - 必要な数。
 * @throws UnsupportedMathError - 数が違う場合。不正な構造を推測で出力しない。
 */
function requireChildren(node: Element, children: readonly Element[], count: number): void {
    if (children.length !== count) throw new UnsupportedMathError(`${node.localName} with ${children.length} children`);
}

/**
 * 識別子（`mi`）の書式。1文字は数式の既定（斜体）、複数文字（`sin`など）とmathvariant=normalは立体にする。
 * @param node - mi要素。
 * @returns m:rPrの中身。既定の斜体なら空文字列。
 */
function identifierStyle(node: Element): string {
    const variant = variantStyle(node.getAttribute('mathvariant'));
    if (variant !== undefined) return variant;
    return [...(node.textContent ?? '')].length > 1 ? '<m:sty m:val="p"/>' : '';
}

/**
 * mathvariantを書体（m:scr）と太字・斜体（m:sty）へ写す。
 * @param variant - mathvariant属性の値。
 * @returns m:rPrの中身。属性がない、または未知の値ならundefined。
 */
function variantStyle(variant: string | null): string | undefined {
    if (!variant) return undefined;
    const map: Record<string, { script?: string; style: string }> = {
        normal: { style: 'p' },
        bold: { style: 'b' },
        italic: { style: 'i' },
        'bold-italic': { style: 'bi' },
        'double-struck': { script: 'double-struck', style: 'p' },
        script: { script: 'script', style: 'p' },
        'bold-script': { script: 'script', style: 'b' },
        fraktur: { script: 'fraktur', style: 'p' },
        'bold-fraktur': { script: 'fraktur', style: 'b' },
        'sans-serif': { script: 'sans-serif', style: 'p' },
        'bold-sans-serif': { script: 'sans-serif', style: 'b' },
        'sans-serif-italic': { script: 'sans-serif', style: 'i' },
        'sans-serif-bold-italic': { script: 'sans-serif', style: 'bi' },
        monospace: { script: 'monospace', style: 'p' }
    };
    const entry = map[variant];
    if (!entry) return undefined;
    // OMMLのm:rPrは、m:scrをm:styより前に置く順序が規定されている。
    return `${entry.script ? `<m:scr m:val="${entry.script}"/>` : ''}<m:sty m:val="${entry.style}"/>`;
}

/**
 * `mspace`の幅（em）を近い幅の空白文字へ写す。負の幅（`\!`）は詰められないため出力しない。
 * @param width - width属性の値。
 * @returns 空白文字。幅がない・0以下なら空文字列。
 */
function spaceFor(width: string | null): string {
    const match = /^(-?\d*\.?\d+)em$/.exec((width ?? '').trim());
    const em = match ? Number(match[1]) : 0;
    if (!(em > 0)) return '';
    if (em >= 1) return '\u2003';
    if (em >= 0.5) return '\u2002';
    if (em >= 0.25) return '\u2005';
    return '\u2009';
}

/**
 * 数式の文字列（m:r）を作る。
 * @param text - 表示する文字。空なら要素を作らない。
 * @param properties - m:rPrの中身。
 * @returns m:r要素。
 */
function run(text: string, properties: string): string {
    if (!text) return '';
    return `<m:r>${properties ? `<m:rPr>${properties}</m:rPr>` : ''}<m:t xml:space="preserve">${escapeXml(text)}</m:t></m:r>`;
}

/**
 * XMLの文字データ・属性値として安全な文字列にする。XML 1.0で使えない制御文字は除く。
 * @param value - 元の文字列。
 * @returns エスケープ済みの文字列。
 */
export function escapeXml(value: string): string {
    return value
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
        .replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);
}
