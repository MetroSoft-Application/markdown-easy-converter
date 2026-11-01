/**
 * @fileoverview 文字色操作を本文上の変更へ変換し、削除範囲をまたぐ位置と選択範囲を正しく写像する。
 */
/**
 * 文字色で解析・表示・保存する本文。
 */
export const TEXT_COLOR_HEX = {
    red: "#d32f2f",
    orange: "#e65100",
    yellow: "#9a6700",
    green: "#2e7d32",
    blue: "#1565c0",
    purple: "#7b1fa2",
    gray: "#616161",
} as const;

/**
 * 文字色指定として利用できる固定色名の文字列型です。
 */
export type TextColorId = keyof typeof TEXT_COLOR_HEX;
/**
 * 文字色の現在状態または履歴を保持するデータ形状。
 */
export type TextColorSelectionState = TextColorId | "mixed" | undefined;

/**
 * 文字色で解析・表示・保存する本文。
 */
export const TEXT_COLOR_IDS = Object.keys(TEXT_COLOR_HEX) as TextColorId[];

/**
 * 文字色操作で対象となる本文の選択範囲です。
 */
export interface TextColorSelection {

    /**
     * 色付き範囲の先頭を示す本文内UTF-16オフセットです。
     */
    from: number;

    /**
     * 色付き範囲の末尾を示す本文内UTF-16オフセットです。
     */
    to: number;
}

/**
 * 文字色マークアップを挿入・除去する本文編集範囲です。
 */
export interface TextColorEdit {

    /**
     * 表示・解析・変換の対象となる本文。
     */
    text: string;

    /**
     * 本文内の色書式対象範囲をUTF-16オフセットで表す。
     */
    selection: TextColorSelection;
}

/**
 * 色指定された本文区間の開始・終了位置と色値です。
 */
interface ColorSpan {

    /**
     * 解析済み色付き範囲の先頭UTF-16オフセットです。
     */
    from: number;

    /**
     * 解析済み色付き範囲の末尾UTF-16オフセットです。
     */
    to: number;

    /**
     * 適用する文字色の定義ID。
     */
    color: TextColorId;
}

/**
 * 解析後の本文区間と、その区間に適用する文字色情報です。
 */
interface ParsedSpan extends ColorSpan {

    /**
     * 重なった色範囲を解決する際の解析順です。
     */
    order: number;
}

/**
 * 入れ子の文字色マークアップ1層分の範囲と色です。
 */
interface Layer {

    /**
     * マークアップ層の先頭UTF-16オフセットです。
     */
    from: number;

    /**
     * マークアップ層の末尾UTF-16オフセットです。
     */
    to: number;

    /**
     * 適用する文字色の定義ID。
     */
    color?: TextColorId;

    /**
     * 入れ子レイヤーを合成する際の解析順です。
     */
    order: number;
}

/**
 * 解析中に現在開いている文字色マークアップ層の状態です。
 */
interface ActiveLayer {

    /**
     * スタック上の開始タグとレイヤーを対応付ける連番です。
     */
    id: number;

    /**
     * ネストや重なり順を保つ文字色範囲と色。
     */
    layer: Layer;
}

/**
 * 文字色マークアップから得た本文と色付き区間の一覧です。
 */
interface ParsedMarkup {

    /**
     * 表示・解析・変換の対象となる本文。
     */
    text: string;

    /**
     * Markdown本文から抽出した文字色spanの一覧。
     */
    spans: ParsedSpan[];

    /**
     * タグ除去によって本文から消えた範囲一覧。
     */
    removed: TextColorSelection[];
}

/**
 * 入れ子マークアップ解析時に保持する開始タグと位置です。
 */
interface StackEntry {

    /**
     * 適用する文字色の定義ID。
     */
    color?: TextColorId;

    /**
     * 対応する開始タグの本文内UTF-16オフセットです。
     */
    from?: number;

    /**
     * 色レイヤーへ割り当てた解析順です。
     */
    order?: number;

    /**
     * 文字色のremovedを切り替えるフラグ。
     */
    removed: boolean;
}


/**
 * 文字色の入力形式を検出する正規表現。
 */
const COLOR_ATTRIBUTE_PATTERN =
    /\bdata-mve-text-color\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i;

/**
 * インラインコード境界とエスケープを判定するバッククォート。
 */
const TICK = String.fromCharCode(96);

/**
 * 指定範囲へ文字色spanを適用・切替・解除し、選択範囲を保った本文編集を作る。
 * @param source - 文字色span記法を含み、選択範囲の色を適用または解除するMarkdown本文。
 * @param selection - 色付け対象を示す本文上のUTF-16開始・終了範囲。
 * @param color - 選択範囲へ適用する文字色ID。undefinedなら色を解除する。
 * @returns 文字色マークアップを含む更新本文と、タグなし本文の選択範囲。
 */
export function applyTextColorFormatting(
    source: string,
    selection: TextColorSelection,
    color: TextColorId | undefined,
): TextColorEdit {
    const parsed = parseColorMarkup(source);
    const cleanSelection = mapSelection(selection, parsed.removed, source.length, parsed.text.length);
    const colorable = collectColorableRanges(parsed.text);
    let spans = restrictToRanges(normalizeSpans(parsed.spans, parsed.text.length), colorable);
    const paintRanges = intersectRanges(colorable, cleanSelection);
    if (paintRanges.length) spans = paintRangesOnSpans(spans, paintRanges, color);
    return serializeColorMarkup(parsed.text, spans, cleanSelection);
}

/**
 * 選択範囲を覆う文字色spanが単色か混在しているかを判定する。
 * @param source - 現在の文字色span記法を検出するMarkdown本文。
 * @param selection - 現在の書式を判定する本文上のUTF-16選択範囲。
 * @returns 選択範囲に一貫して適用されている色。範囲外・混在時はundefined。
 */
export function detectTextColorFormatting(
    source: string,
    selection: TextColorSelection,
): TextColorSelectionState {
    const parsed = parseColorMarkup(source);
    const cleanSelection = mapSelection(selection, parsed.removed, source.length, parsed.text.length);
    if (cleanSelection.from === cleanSelection.to) return undefined;
    const colorable = collectColorableRanges(parsed.text);
    const ranges = intersectRanges(colorable, cleanSelection);
    if (!ranges.length) return undefined;
    const spans = restrictToRanges(normalizeSpans(parsed.spans, parsed.text.length), colorable);
    const states = new Set<TextColorId | "default">();
    let start = 0;
    for (const range of ranges) {
        while (start < spans.length && spans[start].to <= range.from) start += 1;
        let cursor = range.from;
        for (let index = start; index < spans.length; index += 1) {
            const span = spans[index];
            if (span.from >= range.to) break;
            const from = Math.max(range.from, span.from);
            const to = Math.min(range.to, span.to);
            if (from > cursor) states.add("default");
            if (to > from) states.add(span.color);
            cursor = Math.max(cursor, to);
            if (states.size > 1) return "mixed";
        }
        if (cursor < range.to) states.add("default");
        if (states.size > 1) return "mixed";
    }
    const state = states.values().next().value as TextColorId | "default" | undefined;
    return state === "default" ? undefined : state;
}

/**
 * 指定色の文字色spanを開始するHTMLタグを作る。
 * @param color - span開始タグへ記録する文字色ID。
 * @returns data属性とインライン色を含むspan開始タグ。
 */
export function textColorOpenTag(color: TextColorId): string {
    return '<span data-mve-text-color="' + color + '" style="color:' + TEXT_COLOR_HEX[color] + '">';
}

/**
 * 文字色から不要または危険な情報を除去する。
 * @param value - MVE文字色spanを除去するHTMLまたはMarkdown本文。
 * @returns MVE文字色span属性を取り除いた本文。
 */
export function stripMveTextColorMarkup(value: string): string {
    const parts: string[] = [];
    const stack: Array<{
        /**
         * 文字色のremovedを切り替えるフラグ。
         */
        removed: boolean
    }> = [];
    const preserved = collectPreservedMarkupRanges(value);
    let preservedIndex = 0;
    let cursor = 0;


    const isPreserved = /**
   * 文字色の条件を判定する。
   * @param from - 判定するspanタグの開始UTF-16オフセット。
   * @param to - 判定するspanタグの終了UTF-16オフセット（排他的）。
   * @returns 条件が成立したかを示す真偽値。
   */ (from: number, to: number) => {
            while (preservedIndex < preserved.length && preserved[preservedIndex].to <= from) preservedIndex += 1;
            const range = preserved[preservedIndex];
            return Boolean(range && range.from < to && range.to > from);
        };
    for (const { tag, from, to } of scanSpanTags(value)) {
        parts.push(value.slice(cursor, from));
        const selfClosing = /\/\s*>$/.test(tag);
        if (isPreserved(from, to) || isEscaped(value, from)) {
            parts.push(tag);
        } else if (/^<\/span\b/i.test(tag)) {
            const entry = stack.pop();
            if (!entry?.removed) parts.push(tag);
        } else if (readTextColorId(tag) && !selfClosing) {
            stack.push({ removed: true });
        } else {
            parts.push(tag);
            if (!selfClosing) stack.push({ removed: false });
        }
        cursor = to;
    }
    parts.push(value.slice(cursor));
    return parts.join("");
}

/**
 * Markdown内の文字色span記法を解析し、本文と対応する色範囲を返す。
 * @param source - data-mve-text-color span記法を含むMarkdown本文。
 * @returns 文字色記法を除いた本文、色範囲、除去済み記法の位置情報。
 */
function parseColorMarkup(source: string): ParsedMarkup {
    const parts: string[] = [];
    const spans: ParsedSpan[] = [];
    const removed: TextColorSelection[] = [];
    const stack: StackEntry[] = [];
    const preserved = collectPreservedMarkupRanges(source);
    let preservedIndex = 0;
    let rawCursor = 0;
    let cleanLength = 0;
    let order = 0;


    const append = /**
   * @param value - 出力へ追加する文字色マークアップ外の本文片。
   * @returns 文字色のappendが生成する結果。
   */ (value: string) => {
            if (!value) return;
            parts.push(value);
            cleanLength += value.length;
        };


    const isPreserved = /**
   * 文字色の条件を判定する。
   * @param from - 判定するspanタグの開始UTF-16オフセット。
   * @param to - 判定するspanタグの終了UTF-16オフセット（排他的）。
   * @returns 条件が成立したかを示す真偽値。
   */ (from: number, to: number) => {
            while (preservedIndex < preserved.length && preserved[preservedIndex].to <= from) preservedIndex += 1;
            const range = preserved[preservedIndex];
            return Boolean(range && range.from < to && range.to > from);
        };

    for (const { tag, from, to } of scanSpanTags(source)) {
        append(source.slice(rawCursor, from));
        if (isPreserved(from, to) || isEscaped(source, from)) {
            append(tag);
        } else if (/^<\/span\b/i.test(tag)) {
            const entry = stack.pop();
            if (entry?.removed) {
                removed.push({ from, to });
                if (entry.color && entry.from !== undefined) {
                    spans.push({ from: entry.from, to: cleanLength, color: entry.color, order: entry.order ?? order++ });
                }
            } else {
                append(tag);
            }
        } else {
            const color = readTextColorId(tag);
            const selfClosing = /\/\s*>$/.test(tag);
            if (color && !selfClosing) {
                removed.push({ from, to });
                stack.push({ color, from: cleanLength, order: order++, removed: true });
            } else {
                append(tag);
                if (!selfClosing) stack.push({ removed: false });
            }
        }
        rawCursor = to;
    }
    append(source.slice(rawCursor));
    for (const entry of stack) {
        if (entry.removed && entry.color && entry.from !== undefined) {
            spans.push({ from: entry.from, to: cleanLength, color: entry.color, order: entry.order ?? order++ });
        }
    }
    return { text: parts.join(""), spans, removed: mergeRanges(removed) };
}

/**
 * HTMLタグから対応する固定文字色IDを読み取る。
 * @param tag - 文字色ID属性を読み取るspan開始タグ全体。
 * @returns 許可された文字色ID。色指定が認識できない場合はundefined。
 */
function readTextColorId(tag: string): TextColorId | undefined {
    const match = COLOR_ATTRIBUTE_PATTERN.exec(tag);
    const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").toLowerCase();
    return Object.prototype.hasOwnProperty.call(TEXT_COLOR_HEX, value)
        ? value as TextColorId
        : undefined;
}

/**
 * 文字色の入力を走査し、該当する範囲または要素を順に返す。
 * @param value - MVE文字色spanタグを検索するHTMLまたはMarkdown本文。
 * @returns 文字色タグを走査するジェネレーター。
 */
function* scanSpanTags(value: string): Generator<{
    /**
     * 文字色で扱うtagの文字列。
     */
    tag: string;
    /**
     * HTMLタグ範囲の開始位置を示す行内UTF-16オフセットです。
     */
    from: number;
    /**
     * HTMLタグ範囲の終了位置を示す行内UTF-16オフセットです。
     */
    to: number
}> {
    let cursor = 0;
    while (cursor < value.length) {
        const from = value.indexOf("<", cursor);
        if (from < 0) return;
        const nameStart = value[from + 1] === "/" ? from + 2 : from + 1;
        const nameEnd = nameStart + 4;
        if (value.slice(nameStart, nameEnd).toLowerCase() !== "span" || isWordCharacter(value[nameEnd])) {
            cursor = from + 1;
            continue;
        }
        const end = value.indexOf(">", nameEnd);
        if (end < 0) return;
        const to = end + 1;
        yield { tag: value.slice(from, to), from, to };
        cursor = to;
    }
}

/**
 * 文字色の条件を判定する。
 * @param value - 英字、数字、アンダースコアのいずれかかを調べる1文字。
 * @returns 条件が成立したかを示す真偽値。
 */
function isWordCharacter(value: string | undefined): boolean {
    return Boolean(value && /[A-Za-z0-9_]/.test(value));
}

/**
 * タグ削除前の選択範囲を、タグなし本文のオフセットへ写像する。
 * @param selection - タグ除去前の本文上にある選択範囲。
 * @param removed - 文字色マークアップ除去で本文から削除した区間一覧。
 * @param sourceLength 元の本文のUTF-16文字数。
 * @param cleanLength 色付け用マークアップを除いた本文のUTF-16文字数。
 * @returns タグなし本文に対応する選択範囲。
 */
function mapSelection(
    selection: TextColorSelection,
    removed: readonly TextColorSelection[],
    sourceLength: number,
    cleanLength: number,
): TextColorSelection {

    const map = /**
     * 元本文の位置を、除去範囲を反映した本文位置へ写像する。
     * @param offset - 元本文内の選択オフセット。
     * @returns 除去範囲を補正した本文位置。
     */ (offset: number) => {
        const safe = Math.max(0, Math.min(sourceLength, offset));
        let removedLength = 0;
        for (const range of removed) {
            if (safe >= range.to) {
                removedLength += range.to - range.from;
            } else {
                if (safe > range.from) return range.from - removedLength;
                break;
            }
        }
        return safe - removedLength;
    };
    const from = Math.max(0, Math.min(cleanLength, Math.min(map(selection.from), map(selection.to))));
    const to = Math.max(0, Math.min(cleanLength, Math.max(map(selection.from), map(selection.to))));
    return { from, to };
}

/**
 * 本文範囲内へ制限し、重複を統合して文字色spanを正規化する。
 * @param parsed - 本文から解析した文字色span一覧。
 * @param length - span端点を制限する正規化後本文のUTF-16長。
 * @returns 本文範囲内へ制限し、重複範囲を統合した文字色span一覧。
 */
function normalizeSpans(parsed: readonly ParsedSpan[], length: number): ColorSpan[] {
    return resolveLayers(parsed
        .map(
            /**
             * 各spanからfromを取り出して一覧化する。
             * @param span - spanのfromを参照する走査対象。
             * @returns fromを取り出した変換結果の一覧。
             */
            (span) => ({
                from: Math.max(0, Math.min(length, span.from)),
                to: Math.max(0, Math.min(length, span.to)),
                color: span.color,
                order: span.order,
            }))
        .filter(
            /**
             * toの条件を満たすspanだけを残す。
             * @param span - spanのtoを参照する走査対象。

             */
            (span) => span.to > span.from));
}

/**
 * 指定色を選択範囲へ反映した文字色span一覧を返す。
 * @param spans - 既存本文から解析した文字色span一覧。
 * @param ranges - 新しい色を重ねる本文上の選択範囲一覧。
 * @param color - 選択範囲へ適用する文字色ID。undefinedなら色を解除する。
 * @returns 選択範囲へ指定色を反映した文字色span一覧。
 */
function paintRangesOnSpans(
    spans: readonly ColorSpan[],
    ranges: readonly TextColorSelection[],
    color: TextColorId | undefined,
): ColorSpan[] {
    return resolveLayers([
        ...spans.map(
            /**
             * spansの各要素を変換して一覧化する。
             * @param span - 描画順を付け直す既存文字色span。
             * @param index - spanの安定した描画順を与える0始まり番号。

             */
            (span, index) => ({ ...span, order: index })),
        ...ranges.map(
            /**
             * rangesの各要素を変換して一覧化する。
             * @param range - 色を追加する本文上の選択範囲。
             * @param index - 既存span数の後に続く0始まり描画順番号。

             */
            (range, index) => ({ ...range, color, order: spans.length + index })),
    ]);
}

/**
 * 重なった文字色レイヤーを開始・終了位置順に走査し、最前面の色区間へまとめる。
 * @param layers 重なり順を保って合成する文字色レイヤー一覧。
 * @returns 隣接・重複する区間を統合した色span一覧。
 */
function resolveLayers(layers: readonly Layer[]): ColorSpan[] {
    const events: Array<{
        /**
         * 開始・終了イベントを置くMarkdown本文内のUTF-16オフセットです。
         */
        position: number;
        /**
         * 文字色のopenを切り替えるフラグ。
         */
        open: boolean;
        /**
         * 文字色の状態を示すフラグ。
         */
        active: ActiveLayer
    }> = [];
    for (const [id, layer] of layers.entries()) {
        if (layer.to <= layer.from) continue;
        const active = { id, layer };
        events.push({ position: layer.from, open: true, active });
        events.push({ position: layer.to, open: false, active });
    }
    events.sort(
        /**
         * 2つの値を比較して並び順を決める。
         * @param left - 比較対象の左側の値。
         * @param right - 比較対象の右側の値。
         * @returns 2つの要素の順序を示す数値。
         */
        (left, right) => left.position - right.position || Number(left.open) - Number(right.open));
    const active = new Set<number>();
    const heap: ActiveLayer[] = [];
    const result: ColorSpan[] = [];
    let cursor = events[0]?.position ?? 0;
    let index = 0;
    while (index < events.length) {
        const position = events[index].position;
        const top = peekActiveLayer(heap, active);
        if (top?.layer.color && position > cursor) result.push({ from: cursor, to: position, color: top.layer.color });
        while (index < events.length && events[index].position === position && !events[index].open) {
            active.delete(events[index].active.id);
            index += 1;
        }
        while (index < events.length && events[index].position === position) {
            active.add(events[index].active.id);
            pushActiveLayer(heap, events[index].active);
            index += 1;
        }
        cursor = position;
    }
    return mergeColorSpans(result);
}

/**
 * active集合で無効化されていないレイヤーの先頭を参照する。
 * @param heap - 描画優先度順に並んだ文字色レイヤーのヒープ。
 * @param active - 現在有効な文字色レイヤーのID集合。ヒープ先頭レイヤーの有効性判定に使う。
 * @returns 有効な先頭レイヤー。すべて無効化されている場合はundefined。
 */
function peekActiveLayer(heap: ActiveLayer[], active: ReadonlySet<number>): ActiveLayer | undefined {
    while (heap.length && !active.has(heap[0].id)) popActiveLayer(heap);
    return heap[0];
}

/**
 * 最大優先度のレイヤーを先頭にするヒープへ新しい色レイヤーを追加する。
 * @param heap - 文字色レイヤーを優先度順に管理するヒープ。
 * @param value - ヒープへ挿入する文字色レイヤー。
 */
function pushActiveLayer(heap: ActiveLayer[], value: ActiveLayer): void {
    heap.push(value);
    let child = heap.length - 1;
    while (child > 0) {
        const parent = Math.floor((child - 1) / 2);
        if (compareActiveLayers(heap[parent], value) >= 0) break;
        heap[child] = heap[parent];
        child = parent;
    }
    heap[child] = value;
}

/**
 * 無効化されたレイヤーを除き、優先度順ヒープの先頭レイヤーを取り除く。
 * @param heap - 優先度順に積んだ現在または旧active layerのmax-heap。
 * @returns 取り除いたレイヤー。有効なレイヤーが残っていない場合はundefined。
 */
function popActiveLayer(heap: ActiveLayer[]): ActiveLayer | undefined {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
        let parent = 0;
        while (true) {
            const left = parent * 2 + 1;
            const right = left + 1;
            let child = parent;
            if (left < heap.length && compareActiveLayers(heap[left], last) > 0) child = left;
            if (right < heap.length && compareActiveLayers(heap[right], child === parent ? last : heap[left]) > 0) child = right;
            if (child === parent) break;
            heap[parent] = heap[child];
            parent = child;
        }
        heap[parent] = last;
    }
    return top;
}

/**
 * 文字色の2つの値を比較する。
 * @param left - 描画順を比較する文字色レイヤー。orderが同じ場合はIDで順序を決める。
 * @param right - 描画順を比較する文字色レイヤー。orderが同じ場合はIDで順序を決める。

 */
function compareActiveLayers(left: ActiveLayer, right: ActiveLayer): number {
    return left.layer.order - right.layer.order || left.id - right.id;
}

/**
 * 重なりまたは接触する色spanを整理し、同じ色の区間を統合する。
 * @param spans - 重複または隣接する色範囲を統合する入力span一覧。
 * @returns 重複・隣接する範囲を統合した色span一覧。
 */
function mergeColorSpans(spans: readonly ColorSpan[]): ColorSpan[] {
    const sorted = spans.slice().filter(
        /**
         * toの条件を満たすspanだけを残す。
         * @param span - spanのtoを参照する走査対象。

         */
        (span) => span.to > span.from)
        .sort(
            /**
             * 2つの値を比較して並び順を決める。
             * @param left - 比較対象の左側の値。
             * @param right - 比較対象の右側の値。
             * @returns 2つの要素の順序を示す数値。
             */
            (left, right) => left.from - right.from || left.to - right.to);
    const result: ColorSpan[] = [];
    for (const span of sorted) {
        const previous = result.at(-1);
        if (previous && previous.color === span.color && previous.to >= span.from) {
            previous.to = Math.max(previous.to, span.to);
        } else {
            result.push({ ...span });
        }
    }
    return result;
}

/**
 * 色spanを許可されたMarkdown本文範囲との共通部分に切り詰める。
 * @param spans - 本文内で許可範囲に切り取る色span一覧。
 * @param ranges - 色付け可能とする本文範囲一覧。
 * @returns 許可範囲内に残った色span一覧。
 */
function restrictToRanges(
    spans: readonly ColorSpan[],
    ranges: readonly TextColorSelection[],
): ColorSpan[] {
    const result: ColorSpan[] = [];
    let start = 0;
    for (const span of spans) {
        while (start < ranges.length && ranges[start].to <= span.from) start += 1;
        for (let index = start; index < ranges.length && ranges[index].from < span.to; index += 1) {
            const from = Math.max(span.from, ranges[index].from);
            const to = Math.min(span.to, ranges[index].to);
            if (to > from) result.push({ from, to, color: span.color });
        }
    }
    return mergeColorSpans(result);
}

/**
 * 範囲一覧を指定選択範囲との交差部分へ切り詰める。
 * @param ranges - 選択範囲との共通部分を求める元範囲一覧。
 * @param selection - 本文上で交差範囲を求める選択範囲。
 * @returns 選択範囲と重なる区間一覧。
 */
function intersectRanges(
    ranges: readonly TextColorSelection[],
    selection: TextColorSelection,
): TextColorSelection[] {
    const result: TextColorSelection[] = [];
    for (const range of ranges) {
        if (range.to <= selection.from) continue;
        if (range.from >= selection.to) break;
        const from = Math.max(range.from, selection.from);
        const to = Math.min(range.to, selection.to);
        if (to > from) result.push({ from, to });
    }
    return result;
}

/**
 * コードやリンクなどを除いたMarkdown本文のうち色付けできる範囲を集める。
 * @param source - 色付け可能な本文範囲を抽出するMarkdown本文。
 * @returns 色付け可能な本文範囲の一覧。
 */
function collectColorableRanges(source: string): TextColorSelection[] {
    const frontMatterEnd = findFrontMatterEnd(source);
    const inlineProtected = collectInlineProtectedRanges(source);
    let inlineProtectedIndex = 0;
    const ranges: TextColorSelection[] = [];
    let lineStart = 0;
    let fence: {
        /**
         * 文字色で扱うcharacterの文字列。
         */
        character: string;
        /**
         * 開始フェンスを構成する連続したバッククォートまたはチルダの数です。
         */
        length: number
    } | undefined;
    while (lineStart <= source.length) {
        const newline = source.indexOf("\n", lineStart);
        const lineEnd = newline < 0 ? source.length : newline;
        const line = source.slice(lineStart, lineEnd);
        const logical = line.slice(blockQuoteContentStart(line));
        const marker = readFence(logical);
        if (marker) {
            if (!fence) fence = marker;
            else if (marker.character === fence.character && marker.length >= fence.length && !marker.rest.trim()) fence = undefined;
        } else if (!fence && !(frontMatterEnd > 0 && lineStart < frontMatterEnd) && !isUncolorableWholeLine(logical)) {
            const projected = projectRangesToLine(inlineProtected, lineStart, lineEnd, inlineProtectedIndex);
            inlineProtectedIndex = projected.nextIndex;
            const protectedRanges = [
                ...collectProtectedLineRanges(line),
                ...projected.ranges,
            ];
            for (const range of subtractRanges({ from: 0, to: line.length }, mergeRanges(protectedRanges))) {
                const trimmed = trimWhitespace(line, range);
                if (trimmed.to > trimmed.from) ranges.push({ from: lineStart + trimmed.from, to: lineStart + trimmed.to });
            }
        }
        if (newline < 0) break;
        lineStart = lineEnd + 1;
    }
    return ranges;
}

/**
 * front matter、コードフェンス、inline codeなど編集対象外の範囲を集める。
 * @param source - 保護するfront matter、コードブロック、inline codeを含むMarkdown本文。
 * @returns Markdown構文により保護する本文範囲。
 */
function collectPreservedMarkupRanges(source: string): TextColorSelection[] {
    const ranges: TextColorSelection[] = [...inlineCodeRanges(source)];
    const frontMatterEnd = findFrontMatterEnd(source);
    if (frontMatterEnd) ranges.push({ from: 0, to: frontMatterEnd });
    let lineStart = 0;
    let fence: {
        /**
         * 文字色で扱うcharacterの文字列。
         */
        character: string;
        /**
         * 開始フェンスを構成する連続したバッククォートまたはチルダの数です。
         */
        length: number
    } | undefined;
    while (lineStart <= source.length) {
        const newline = source.indexOf("\n", lineStart);
        const lineEnd = newline < 0 ? source.length : newline;
        const line = source.slice(lineStart, lineEnd);
        if (!(frontMatterEnd > 0 && lineStart < frontMatterEnd)) {
            const logical = line.slice(blockQuoteContentStart(line));
            const marker = readFence(logical);
            if (fence || marker) {
                ranges.push({ from: lineStart, to: lineEnd });
                if (!fence && marker) fence = marker;
                else if (fence && marker && marker.character === fence.character && marker.length >= fence.length && !marker.rest.trim()) fence = undefined;
            } else if (isIndentedCodeLine(logical)) {
                ranges.push({ from: lineStart, to: lineEnd });
            }
        }
        if (newline < 0) break;
        lineStart = lineEnd + 1;
    }
    return mergeRanges(ranges);
}

/**
 * 先頭のYAML front matterが閉じる位置を探す。
 * @param source - 先頭のYAML front matterの終了位置を検索するMarkdown本文。
 * @returns front matter終端オフセット。未検出時は0。
 */
function findFrontMatterEnd(source: string): number {
    if (!source.startsWith("---\n")) return 0;
    let start = 4;
    while (start <= source.length) {
        const newline = source.indexOf("\n", start);
        const end = newline < 0 ? source.length : newline;
        if (source.slice(start, end).trim() === "---" || source.slice(start, end).trim() === "...") return newline < 0 ? source.length : end + 1;
        if (newline < 0) return source.length;
        start = end + 1;
    }
    return source.length;
}

/**
 * コードフェンスの種類、長さ、終了条件を行から読み取る。
 * @param line コードフェンスの記号・長さ・後続文字を読み取るMarkdown行。
 * @returns 開始記号、長さ、終了記号の情報。フェンス行でなければundefined。
 */
function readFence(line: string): {
    /**
     * 文字色で扱うcharacterの文字列。
     */
    character: string;
    /**
     * 開始フェンスを構成する連続したバッククォートまたはチルダの数です。
     */
    length: number;
    /**
     * 文字色で扱うrestの文字列。
     */
    rest: string
} | undefined {
    let start = 0;
    while (start < line.length && start < 4 && line[start] === " ") start += 1;
    const character = line[start];
    if (character !== TICK && character !== "~") return undefined;
    let end = start;
    while (line[end] === character) end += 1;
    return end - start >= 3 ? { character, length: end - start, rest: line.slice(end) } : undefined;
}

/**
 * 文字色の条件を判定する。
 * @param line 空行、インデントコード、罫線、表区切りなど行全体を色付けしないか判定するMarkdown行。
 * @returns 条件が成立したかを示す真偽値。
 */
function isUncolorableWholeLine(line: string): boolean {
    if (!line.trim() || isIndentedCodeLine(line)) return true;
    if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})\s*$/.test(line)) return true;
    return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

/**
 * 文字色の条件を判定する。
 * @param line インデントコード行か判定するMarkdown行。
 * @returns 条件が成立したかを示す真偽値。
 */
function isIndentedCodeLine(line: string): boolean {
    if (!/^(?: {4}|\t)\S/.test(line)) return false;
    return !/^[ \t]+(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/.test(line);
}

/**
 * 1行からMarkdownリンクなど文字色の対象外となる構文範囲を集める。
 * @param line Markdown構文として色付け対象外にする範囲を検出する行。
 * @returns 行内の保護範囲一覧。
 */
function collectProtectedLineRanges(line: string): TextColorSelection[] {
    if (/^\s*\[[^\]\n]+\]:/.test(line.slice(blockQuoteContentStart(line)))) {
        return [{ from: 0, to: line.length }];
    }
    const ranges: TextColorSelection[] = [];
    const prefix = blockPrefixEnd(line);
    if (prefix) ranges.push({ from: 0, to: prefix });
    for (let index = 0; index < line.length; index += 1) if (line[index] === "|" && !isEscaped(line, index)) ranges.push({ from: index, to: index + 1 });
    ranges.push(...htmlTagRanges(line));
    ranges.push(...footnoteRanges(line));
    ranges.push(...matchRanges(line, /\[TOC\]/gi));
    ranges.push(...matchRanges(line, /\[![A-Z][A-Z0-9-]*\]/g));
    if (/ {2,}$/.test(line)) ranges.push({ from: Math.max(0, line.length - 2), to: line.length });
    if (/\\$/.test(line) && !isEscaped(line, line.length - 1)) ranges.push({ from: line.length - 1, to: line.length });
    return mergeRanges(ranges);
}

/**
 * inline codeとMarkdownリンク記号を色付け対象から除外する範囲を集める。
 * @param source - inline codeとMarkdown link構文の保護範囲を抽出するMarkdown本文。
 * @returns inline codeおよびリンク構文の範囲一覧。
 */
function collectInlineProtectedRanges(source: string): TextColorSelection[] {
    const ranges = inlineCodeRanges(source);
    addLinkSyntaxRanges(source, ranges);
    return mergeRanges(ranges);
}

/**
 * 文書全体の範囲一覧を指定行内の座標へ投影し、後続行を早期終了できる位置も返す。
 * @param ranges - 現在行のUTF-16座標へ投影する本文上の選択範囲一覧。
 * @param lineStart 色付け対象行の開始UTF-16オフセット。
 * @param lineEnd 色付け対象行の終了UTF-16オフセット。
 * @param startIndex 検査を再開するranges配列の0始まりインデックス。
 * @returns 行内に重なる範囲と、次行へ持ち越す走査開始位置。
 */
function projectRangesToLine(
    ranges: readonly TextColorSelection[],
    lineStart: number,
    lineEnd: number,
    startIndex: number,
): {
    /**
     * 本文上で色書式の対象または保護範囲となる区間一覧。
     */
    ranges: TextColorSelection[];
    /**
     * 次に走査する色範囲の配列インデックスです。
     */
    nextIndex: number
} {
    let index = startIndex;
    while (index < ranges.length && ranges[index].to <= lineStart) index += 1;
    const nextIndex = index;
    const result: TextColorSelection[] = [];
    for (; index < ranges.length; index += 1) {
        const range = ranges[index];
        if (range.from >= lineEnd) break;
        result.push({ from: Math.max(0, range.from - lineStart), to: Math.min(lineEnd - lineStart, range.to - lineStart) });
    }
    return { ranges: result, nextIndex };
}

/**
 * Markdown行内で色付け対象外となるHTMLタグ範囲を抽出する。
 * @param line HTMLタグの構文範囲を検出するMarkdown行。
 * @returns 行内HTMLタグの本文オフセット範囲。
 */
function htmlTagRanges(line: string): TextColorSelection[] {
    const ranges: TextColorSelection[] = [];
    let from = -1;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === "\\") {
            escaped = true;
            continue;
        }
        if (character === "<" && from < 0) from = index;
        else if (character === ">" && from >= 0) {
            ranges.push({ from, to: index + 1 });
            from = -1;
        }
    }
    return ranges;
}

/**
 * 脚注参照・定義の記法を色付け対象から除外する範囲として抽出する。
 * @param line 脚注参照・脚注定義の構文範囲を検出するMarkdown行。
 * @returns 行内脚注記法の本文オフセット範囲。
 */
function footnoteRanges(line: string): TextColorSelection[] {
    const ranges: TextColorSelection[] = [];
    let cursor = 0;
    while (cursor < line.length) {
        const from = line.indexOf("[^", cursor);
        if (from < 0) break;
        const close = line.indexOf("]", from + 2);
        if (close < 0) break;
        const to = close + (line[close + 1] === ":" ? 2 : 1);
        ranges.push({ from, to });
        cursor = to;
    }
    return ranges;
}

/**
 * Markdownリンク・画像リンクの括弧とリンク先を保護範囲へ追加する。
 * @param line Markdownリンク・画像リンクの構文範囲を一覧へ追加する行。
 * @param ranges - Markdownリンク構文を色付け対象外として追加する範囲一覧。
 */
function addLinkSyntaxRanges(line: string, ranges: TextColorSelection[]): void {
    const bracketMatches = findBracketMatches(line);
    const parenthesisMatches = findParenthesisMatches(line);
    for (let from = 0; from < line.length; from += 1) {
        const image = line[from] === "!" && line[from + 1] === "[";
        const labelOpen = image ? from + 1 : from;
        if (line[labelOpen] !== "[" || isEscaped(line, labelOpen)) continue;
        const labelClose = bracketMatches.get(labelOpen);
        if (labelClose === undefined) continue;
        const afterLabel = labelClose + 1;
        let to = -1;
        if (line[afterLabel] === "(") to = parenthesisMatches.get(afterLabel) ?? -1;
        else if (line[afterLabel] === "[") to = bracketMatches.get(afterLabel) ?? -1;
        else {
            const whitespace = /^\s*/.exec(line.slice(afterLabel))?.[0].length ?? 0;
            const next = line[afterLabel + whitespace];
            if (next !== "(" && next !== "[" && next !== ":") to = labelClose;
        }
        if (to < 0) continue;
        if (image) ranges.push({ from, to: to + 1 });
        else {
            ranges.push({ from, to: labelOpen + 1 });
            ranges.push({ from: labelClose, to: to + 1 });
        }
        from = to;
    }
}

/**
 * Markdownの角括弧の開閉位置を対応づける。
 * @param value - Markdown内の角括弧の対応位置を検索するテキスト。
 * @returns 開き位置から閉じ位置への対応表。
 */
function findBracketMatches(value: string): ReadonlyMap<number, number> {
    const matches = new Map<number, number>();
    const opens: number[] = [];
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === "\\") {
            escaped = true;
            continue;
        }
        if (character === "[") opens.push(index);
        else if (character === "]") {
            const open = opens.pop();
            if (open !== undefined) matches.set(open, index);
        }
    }
    return matches;
}

/**
 * Markdownリンク先の丸括弧の開閉位置を対応づける。
 * @param value - Markdownリンク先にある丸括弧の対応位置を検索するテキスト。
 * @returns 開き位置から閉じ位置への対応表。
 */
function findParenthesisMatches(value: string): ReadonlyMap<number, number> {
    const matches = new Map<number, number>();
    const opens: number[] = [];
    let quote: string | undefined;
    let angleDestination = false;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === "\\") {
            escaped = true;
            continue;
        }
        if (quote) {
            if (character === quote) quote = undefined;
            continue;
        }
        if (angleDestination) {
            if (character === ">") angleDestination = false;
            continue;
        }
        if (opens.length === 1 && character === "<") {
            angleDestination = true;
            continue;
        }
        if (opens.length > 0 && (character === '"' || character === "'")) {
            quote = character;
            continue;
        }
        if (character === "(") opens.push(index);
        else if (character === ")") {
            const open = opens.pop();
            if (open !== undefined) matches.set(open, index);
        }
    }
    return matches;
}

/**
 * 引用・見出し・リストなどのブロック接頭辞の終端位置を求める。
 * @param line blockquote・見出し・リスト接頭辞の終端位置を求めるMarkdown行。
 * @returns 本文部分が始まる行内オフセット。
 */
function blockPrefixEnd(line: string): number {
    let position = line.match(/^[ \t]*/)?.[0].length ?? 0;
    while (true) {
        const quote = /^>\s?/.exec(line.slice(position));
        if (!quote) break;
        position += quote[0].length;
        position += line.slice(position).match(/^[ \t]*/)?.[0].length ?? 0;
    }
    const heading = /^#{1,6}(?:[ \t]+|$)/.exec(line.slice(position));
    if (heading) position += heading[0].length;
    const list = /^(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/.exec(line.slice(position));
    if (list) position += list[0].length;
    return position;
}

/**
 * 行頭の引用記号を除いた本文開始位置を求める。
 * @param line blockquote記号を除いた本文開始位置を求めるMarkdown行。
 * @returns 引用本文が始まる行内オフセット。
 */
function blockQuoteContentStart(line: string): number {
    let position = 0;
    while (true) {
        const indent = /^ {0,3}/.exec(line.slice(position))?.[0].length ?? 0;
        const quote = /^>[ \t]?/.exec(line.slice(position + indent));
        if (!quote) return position;
        position += indent + quote[0].length;
    }
}

/**
 * 対応するバッククォートで囲まれたinline codeの範囲を抽出する。
 * @param line インラインコード範囲を検出するMarkdown行。
 * @returns 行内inline code範囲の一覧。
 */
function inlineCodeRanges(line: string): TextColorSelection[] {
    const ranges: TextColorSelection[] = [];
    const opens = new Map<number, number>();
    for (let index = 0; index < line.length;) {
        if (line[index] !== TICK) {
            index += 1;
            continue;
        }
        let length = 1;
        while (line[index + length] === TICK) length += 1;
        const open = opens.get(length);
        if (open === undefined) opens.set(length, index);
        else {
            ranges.push({ from: open, to: index + length });
            opens.delete(length);
        }
        index += length;
    }
    return mergeRanges(ranges);
}

/**
 * 正規表現の一致箇所を行内オフセット範囲へ変換する。
 * @param line patternに一致する構文範囲を検出するMarkdown行。
 * @param pattern 対象行内で範囲を検出する正規表現。
 * @returns 正規表現に一致した本文範囲。
 */
function matchRanges(line: string, pattern: RegExp): TextColorSelection[] {
    pattern.lastIndex = 0;
    const ranges: TextColorSelection[] = [];
    for (let match = pattern.exec(line); match; match = pattern.exec(line)) ranges.push({ from: match.index, to: match.index + match[0].length });
    return ranges;
}

/**
 * 文字色の条件を判定する。
 * @param value - index直前のエスケープ状態を調べるMarkdown本文。
 * @param index - エスケープ状態を調べる本文内のUTF-16位置。
 * @returns 条件が成立したかを示す真偽値。
 */
function isEscaped(value: string, index: number): boolean {
    let count = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) count += 1;
    return count % 2 === 1;
}

/**
 * 色付け候補から前後空白と保護範囲を差し引く。
 * @param range 前後の空白を除去する色付け範囲。
 * @param protectedRanges - 色付け可能領域から差し引くコード・リンク等の保護範囲一覧。
 * @returns 保護範囲と前後空白を除いた区間一覧。
 */
function subtractRanges(range: TextColorSelection, protectedRanges: readonly TextColorSelection[]): TextColorSelection[] {
    const result: TextColorSelection[] = [];
    let cursor = range.from;
    for (const protectedRange of protectedRanges) {
        if (protectedRange.to <= cursor) continue;
        if (protectedRange.from >= range.to) break;
        if (protectedRange.from > cursor) result.push({ from: cursor, to: protectedRange.from });
        cursor = Math.max(cursor, protectedRange.to);
        if (cursor >= range.to) break;
    }
    if (cursor < range.to) result.push({ from: cursor, to: range.to });
    return result;
}

/**
 * 重複または隣接する本文範囲を統合する。
 * @param ranges - 重複または隣接する本文区間を統合する入力一覧。
 * @returns 統合済み本文範囲一覧。
 */
function mergeRanges(ranges: readonly TextColorSelection[]): TextColorSelection[] {
    const sorted = ranges.slice().filter(
        /**
         * toの条件を満たす範囲だけを残す。
         * @param range - 範囲のtoを参照する走査対象。

         */
        (range) => range.to > range.from)
        .sort(
            /**
             * 2つの値を比較して並び順を決める。
             * @param left - 比較対象の左側の値。
             * @param right - 比較対象の右側の値。
             * @returns 2つの要素の順序を示す数値。
             */
            (left, right) => left.from - right.from || left.to - right.to);
    const result: TextColorSelection[] = [];
    for (const range of sorted) {
        const previous = result.at(-1);
        if (previous && previous.to >= range.from) previous.to = Math.max(previous.to, range.to);
        else result.push({ ...range });
    }
    return result;
}

/**
 * 色付け範囲の先頭と末尾にある空白を取り除く。
 * @param line 色付け範囲の前後空白を切り詰める元のMarkdown行。
 * @param range - 前後の空白を切り詰める本文上の色付け範囲。
 * @returns 前後空白を除いた本文範囲。
 */
function trimWhitespace(line: string, range: TextColorSelection): TextColorSelection {
    let { from, to } = range;
    while (from < to && /\s/.test(line[from])) from += 1;
    while (to > from && /\s/.test(line[to - 1])) to -= 1;
    return { from, to };
}

/**
 * 文字色を出力または保存できる文字列へ整える。
 * @param source - 色spanタグを挿入するタグなしMarkdown本文。
 * @param spans - 本文へspanタグとして直列化する最終色範囲一覧。
 * @param selection - spanタグ挿入後も返すタグなし本文内のUTF-16選択範囲。
 * @returns 文字色マークアップを含む本文と、元本文上の選択範囲。
 */
function serializeColorMarkup(source: string, spans: readonly ColorSpan[], selection: TextColorSelection): TextColorEdit {
    const opens = new Map<number, string[]>();
    const closes = new Map<number, string[]>();
    for (const span of spans) {
        const open = opens.get(span.from) ?? [];
        open.push(textColorOpenTag(span.color));
        opens.set(span.from, open);
        const close = closes.get(span.to) ?? [];
        close.push("</span>");
        closes.set(span.to, close);
    }
    const positions = [...new Set([0, source.length, selection.from, selection.to, ...opens.keys(), ...closes.keys()])]
        .filter(
            /**
             * 内容のないpositionを除外する。
             * @param position - 直列化する本文内のUTF-16位置。

             */
            (position) => position >= 0 && position <= source.length)
        .sort(
            /**
             * 2つの値を比較して並び順を決める。
             * @param left - 比較対象の左側の値。
             * @param right - 比較対象の右側の値。
             * @returns 2つの要素の順序を示す数値。
             */
            (left, right) => left - right);
    const parts: string[] = [];
    let outputLength = 0;
    let cursor = 0;
    let mappedFrom = 0;
    let mappedTo = 0;


    const append = /**
   * @param value - 出力へ保持する文字色span外の本文片。
   * @returns 文字色のappendが生成する結果。
   */ (value: string) => {
            if (value) {
                parts.push(value);
                outputLength += value.length;
            }
        };
    for (const position of positions) {
        append(source.slice(cursor, position));
        if (position === selection.to) mappedTo = outputLength;
        for (const close of closes.get(position) ?? []) append(close);
        for (const open of opens.get(position) ?? []) append(open);
        if (position === selection.from) mappedFrom = outputLength;
        cursor = position;
    }
    append(source.slice(cursor));
    return { text: parts.join(""), selection: { from: mappedFrom, to: mappedTo } };
}
