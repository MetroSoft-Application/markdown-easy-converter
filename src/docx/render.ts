/**
 * @fileoverview 描画済みHTMLからDOCXを作る。実行境界: Node（CLI）。Chromiumは共有ブラウザーを使う。
 *
 * 流れ: PDFと同じ印刷用HTML（buildStandaloneHtml、ローカル画像の埋め込み方針も同じ）を、
 * JavaScript無効・2倍解像度のコンテキストへ読み込み、印刷本文幅で組版する。
 * そのページで抽出スクリプト（dist/docx-extract.js）を評価して中間モデルを得て、
 * Wordが直接扱えない要素はスクリーンショットでPNG化し、ooxml.tsでパッケージにまとめる。
 *
 * 不変条件: ページ内のスクリプトは実行しない（PDFと同じ安全条件）。全体の期限・キャンセルはPDFと同じ
 * withRenderControlで制御し、コンテキストは成功・失敗・中断のいずれでも閉じる。ファイルへは書き込まない。
 */
import { promises as fs } from 'node:fs';
import type { BrowserContext, Page } from 'playwright-core';
import { normalizePdfOptions } from '../shared/protocol';
import {
    acquirePdfBrowser, buildStandaloneHtml, closePdfContext, limitRemoteImageRequests, pdfPrintViewport, withRenderControl,
    type PdfExportRequest
} from '../pdf';
import type { DocxModel } from './model';
import { buildDocx, type DocxMedia } from './ooxml';

/** DOCX出力の要求。PDFと同じ本文・CSS・設定・画像方針を使う。Marpのページ寸法指定は使わない。 */
export interface DocxExportRequest extends Omit<PdfExportRequest, 'preferCssPageSize'> {
    /** ビルド済みの抽出スクリプト（docx-extract.js）の絶対パス。 */
    extractScriptPath: string;
}

/** DOCX出力の結果。 */
export interface DocxExportResult {
    /** DOCXファイルのバイト列。 */
    docx: Buffer;
    /** 変換できなかった要素などの警告。呼び出し側が標準エラー・`--json`の結果へ渡す。 */
    warnings: string[];
}

/** 外部画像の各要求を待つ時間。PDFと同じ値。 */
const DOCX_ASSET_TIMEOUT_MS = 5_000;
/** HTML構築から完了までの既定の期限。PDFと同じ値。 */
const DOCX_RENDER_TIMEOUT_MS = 60_000;
/** 画像のスクリーンショットの解像度（CSSピクセルあたりの画素数）。印刷で粗く見えない最小限の倍率。 */
const RASTER_SCALE = 2;

/** 抽出スクリプトの内容。同じプロセスで複数の文書を変換するときに読み直さない。 */
let extractScript: { path: string; source: string } | undefined;

/**
 * 描画済みHTMLからDOCXを作る。
 * @param request - 本文・CSS・設定・画像方針・期限・キャンセル。
 * @returns DOCXのバイト列と警告。
 * @throws Error - 期限切れ・キャンセル・ブラウザーの障害・抽出の失敗。画像1枚の失敗は警告にとどめる。
 */
export async function renderDocx(request: DocxExportRequest): Promise<DocxExportResult> {
    const renderTimeoutMs = request.renderTimeoutMs ?? DOCX_RENDER_TIMEOUT_MS;
    const deadlineAt = Date.now() + renderTimeoutMs;
    let context: BrowserContext | undefined;
    let closePromise: Promise<void> | undefined;
    /** コンテキストを一度だけ閉じる。中断時と終了時の両方から呼ばれる。 */
    const closeContext = (): Promise<void> => {
        if (!context) return Promise.resolve();
        closePromise ??= closePdfContext(context);
        return closePromise;
    };
    /** 中断時に描画中の処理を止める。 */
    const abortContext = (): void => { void closeContext(); };
    /**
     * 1つの処理段階を、PDFと同じ期限・キャンセルの規則で実行する。エラー文言は「DOCX …」にする。
     * @param operation - 段階の処理。
     * @param stage - 期限切れの文言に入れる段階名。
     * @param lateCleanup - 中断後に完了した処理の資源を解放する処理。
     * @returns 処理の結果。
     */
    const control = <T>(operation: () => Promise<T>, stage: string, lateCleanup?: (value: T) => void): Promise<T> =>
        withRenderControl(operation, request.signal, deadlineAt, stage, abortContext, lateCleanup, 'DOCX');
    const html = await control(() => buildStandaloneHtml(request), 'HTML build');
    const script = await control(() => readExtractScript(request.extractScriptPath), 'script load');
    const browser = await control(
        () => acquirePdfBrowser(request.language, request.browserPath, request.browserTimeoutMs), 'browser launch');
    request.signal?.addEventListener('abort', abortContext, { once: true });
    try {
        context = await control(
            () => browser.newContext({ javaScriptEnabled: false, deviceScaleFactor: RASTER_SCALE }),
            'browser context', (lateContext) => { void closePdfContext(lateContext); });
        const page = await control(() => context!.newPage(), 'new page');
        await control(() => page.route('**/*', limitRemoteImageRequests(DOCX_ASSET_TIMEOUT_MS)), 'route setup');
        // 印刷本文幅で組版し、画像の表示寸法・表の列幅をPDFと同じ条件で測る。
        await control(() => page.setViewportSize(pdfPrintViewport(normalizePdfOptions(request.options))), 'print viewport');
        await control(() => page.setContent(html, {
            waitUntil: 'domcontentloaded', timeout: Math.max(10_000, renderTimeoutMs / 6)
        }), 'DOM load');
        await control(() => page.emulateMedia({ media: 'print' }), 'print media');
        // 画像・フォントの読み込みは有限時間だけ待つ。応答しないリモート画像は上のルート処理が打ち切る。
        await control(() => page.waitForLoadState('load', { timeout: DOCX_ASSET_TIMEOUT_MS }).catch(() => undefined), 'asset load');
        await control(() => page.evaluate('document.fonts.ready.then(() => true)'), 'font load');
        const model = await control(
            () => page.evaluate(`${script}
;mveDocxExtract.extractDocxModel()`) as Promise<DocxModel>, 'content extraction');
        const warnings = [...model.warnings];
        const media = await control(() => collectMedia(page, model, warnings), 'image capture');
        const docx = buildDocx({
            model, media,
            options: normalizePdfOptions(request.options),
            theme: request.editorTheme ?? 'dark',
            title: request.title,
            language: request.language
        });
        return { docx, warnings };
    } finally {
        request.signal?.removeEventListener('abort', abortContext);
        await closeContext();
    }
}

/**
 * 抽出スクリプトを読み込む。
 * @param scriptPath - docx-extract.jsの絶対パス。
 * @returns スクリプトの内容。
 */
async function readExtractScript(scriptPath: string): Promise<string> {
    if (extractScript?.path !== scriptPath) extractScript = { path: scriptPath, source: await fs.readFile(scriptPath, 'utf8') };
    return extractScript.source;
}

/**
 * 画像の実体を集める。data URLは署名を確認してそのまま使い、それ以外は要素のスクリーンショットにする。
 * 1枚の失敗で文書全体を失敗させず、代替テキストにして警告する。
 * @param page - 抽出に使ったページ。`data-mve-docx-raster`属性の付いた要素を撮影する。
 * @param model - 抽出結果。
 * @param warnings - 警告の追加先。
 * @returns `model.images`と同じ添字の画像。取得できなかった画像はundefined。
 */
async function collectMedia(page: Page, model: DocxModel, warnings: string[]): Promise<Array<DocxMedia | undefined>> {
    const media: Array<DocxMedia | undefined> = [];
    for (const image of model.images) {
        const embedded = image.dataUrl ? decodeImageDataUrl(image.dataUrl) : undefined;
        if (embedded) {
            media.push(embedded);
            continue;
        }
        try {
            const target = page.locator(`[data-mve-docx-raster="${image.rasterId}"]`);
            // 対象が見つからない場合は、スクリーンショットの待機時間（1件5秒）を使わずにすぐ代替テキストへ切り替える。
            if (await target.count() !== 1) throw new Error('the element to capture was not found');
            const data = await target.screenshot({ type: 'png', animations: 'disabled', timeout: DOCX_ASSET_TIMEOUT_MS });
            media.push({ data, extension: 'png' });
        } catch (error) {
            warnings.push(`An image could not be captured and was replaced by its alternative text (${firstLine(error)}).`);
            media.push(undefined);
        }
    }
    return media;
}

/**
 * Base64のdata URLを画像のバイト列へ戻し、中身の署名から形式を判定する。宣言された形式は信用しない。
 * @param dataUrl - `data:image/...;base64,`形式のURL。
 * @returns 画像と拡張子。PNG・JPEG・GIF・BMPの署名でなければundefined。
 */
function decodeImageDataUrl(dataUrl: string): DocxMedia | undefined {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return undefined;
    const data = Buffer.from(dataUrl.slice(comma + 1), 'base64');
    if (data.length >= 8 && data.readUInt32BE(0) === 0x89504E47) return { data, extension: 'png' };
    if (data.length >= 3 && data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return { data, extension: 'jpeg' };
    if (data.length >= 6 && /^GIF8[79]a$/.test(data.toString('latin1', 0, 6))) return { data, extension: 'gif' };
    if (data.length >= 14 && data.toString('latin1', 0, 2) === 'BM') return { data, extension: 'bmp' };
    return undefined;
}

/**
 * 例外の1行目を返す。Playwrightの例外は呼び出し履歴を複数行で含むため。
 * @param error - 例外。
 * @returns 1行目の文言。
 */
function firstLine(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).split('\n')[0];
}
