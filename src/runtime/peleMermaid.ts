/**
 * @fileoverview PeleをWorker内で実行し、SVG・画像・リンク領域をプレビュー用に整える。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import {
    DEFAULT_MERMAID_FONT_SIZE,
    normalizeMermaidFontSize,
    type MermaidInteraction
} from '../shared/protocol';

/** 出力エンジンのPele描画で得るSVGまたはPNGと操作領域。 */
export interface PeleMermaidResult {
    svg: string;
    pngBase64?: string;
    interactions: MermaidInteraction[];
    ariaLabel: string;
    hasImages?: boolean;
}

/** Pele描画時に適用するフォント、文字サイズ、画像解決処理。 */
export interface PeleRenderOptions {
    fontFamily: string;
    /** Mermaidラベルへ適用する文字サイズ。省略時は旧動作互換の16px。 */
    fontSize?: number;
    resourceScope?: string;
    renderTimeoutMs?: number;
    resolveImages?: (sources: string[], signal?: AbortSignal) => Promise<Record<string, string>>;
}

/** Pele Workerの初期化に失敗したことを表すエラー。 */
export class PeleRendererUnavailableError extends Error {
    /**
     * @param message - 初期化に失敗した理由。
     * @param options - 元の例外などの追加情報。
     */
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'PeleRendererUnavailableError';
    }
}

/**
 * 特定のMermaid図を描画できないことを表すエラー。構文エラー、ソース長・SVGサイズの上限超過、不正なSVG、
 * SVG要素の欠落、図ごとの描画タイムアウト、描画ページを作り直した後の再試行でも続いた描画失敗が該当する。
 * キャンセルや描画ページを用意できないブラウザー・Workerの障害とは区別し、呼び出し側が図単位でエラー表示へ置き換えて
 * 文書の出力を続けられるようにする。messageはソース本文や依存関係の詳細を含まない安全な文言に限る。
 */
export class MermaidDiagramError extends Error {
    /**
     * @param message - 図を描画できなかった理由。ソース本文を含めない。
     * @param options - 元の例外などの追加情報。causeは診断用で、出力やmessageへは含めない。
     */
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'MermaidDiagramError';
    }
}

/** レンダー結果キャッシュの件数上限。 */
const CACHE_LIMIT = 12;
/** キャッシュ済みSVG/PNG文字列の合計容量上限。 */
const CACHE_BYTE_LIMIT = 24 * 1024 * 1024;
/** Worker描画要求に許す時間。 */
const RENDER_TIMEOUT_MS = 180_000;
/** この長さ以上のSVGをPNGプレビューへ縮小する閾値。 */
const LARGE_SVG_LIMIT = 80_000;
/** レンダー結果として保持できるSVG文字列の最大長。 */
const MAX_FINAL_SVG_CHARS = 12_000_000;
/** Mermaid描画結果キャッシュ。 */
const cache = new Map<string, PeleMermaidResult>();
/** 同じ描画キーの同時要求をまとめる処理表。 */
const inFlight = new Map<string, RenderTask>();
/** キャッシュ済み結果の文字列容量。 */
let cacheBytes = 0;
/** Worker操作を直列化するPromise末尾。 */
let queueTail: Promise<void> = Promise.resolve();
/** 描画ページのライフサイクルを所有するブラウザーコンテキスト。 */
let browserContext: BrowserContext | undefined;
/** Workerを実行する共有ページ。 */
let rendererPage: Page | undefined;
/** 同時初期化を一度にまとめるページ取得Promise。 */
let pagePromise: Promise<Page> | undefined;
/** Workerスクリプト読込の重複を避けるキャッシュ。 */
let workerScriptCache = new Map<string, Promise<string>>();
/** Workerへ送信する要求IDの採番値。 */
let sequence = 0;

/** キュー内で実行中のMermaid描画とキャンセル・完了状態。 */
interface RenderTask {
    key: string;
    promise: Promise<PeleMermaidResult>;
    controller: AbortController;
    consumers: number;
    started: boolean;
    settled: boolean;
    cancelled: boolean;
}

/**
 * PeleでMermaidソースを描画し、必要な場合は画像をインライン化して操作領域を計測する。
 * @param source - Mermaid図のソース。
 * @param theme - 適用するPele配色。
 * @param workerPath - Pele Worker bundleのファイルパス。
 * @param acquireBrowser - 描画に使うPlaywrightブラウザーを取得する処理。
 * @param signal - 呼び出し元からのキャンセル通知。
 * @param options - 表示フォントと画像解決処理。
 * @returns SVG、必要時のPNG、操作領域、アクセシブル名。
 */
export function renderPeleMermaid(
    source: string,
    theme: 'default' | 'dark' | 'neutral',
    workerPath: string,
    acquireBrowser: () => Promise<Browser>,
    signal: AbortSignal | undefined,
    options: PeleRenderOptions
): Promise<PeleMermaidResult> {
    if (signal?.aborted) return Promise.reject(new Error('Mermaid rendering was cancelled.'));
    const renderingNow = localDayStart(Date.now());
    const fontSize = normalizeMermaidFontSize(options.fontSize ?? DEFAULT_MERMAID_FONT_SIZE);
    const renderOptions = { ...options, fontSize };
    const key = `${theme}\0${options.fontFamily}\0${fontSize}\0${options.resourceScope ?? ''}\0${renderingNow}\0${source}`;
    const cached = readCache(key);
    if (cached) return Promise.resolve(cached);

    let task = inFlight.get(key);
    if (task?.cancelled || task?.settled) task = undefined;
    if (!task) {
        const created: RenderTask = {
            key,
            promise: Promise.resolve(undefined as unknown as PeleMermaidResult),
            controller: new AbortController(),
            consumers: 0,
            started: false,
            settled: false,
            cancelled: false
        };
        created.promise = enqueue(async () => {
            if (created.cancelled || created.controller.signal.aborted) throw new Error('Mermaid rendering was cancelled.');
            created.started = true;
            const result = await withTimeout(
                renderQueued(
                    source,
                    theme,
                    workerPath,
                    acquireBrowser,
                    created.controller.signal,
                    renderOptions,
                    renderingNow
                ),
                options.renderTimeoutMs ?? RENDER_TIMEOUT_MS,
                () => {
                    created.cancelled = true;
                    created.controller.abort();
                    return resetRendererPage();
                }
            );
            if (!result.hasImages) writeCache(key, result);
            return result;
        });
        task = created;
        inFlight.set(key, created);
        void created.promise.finally(() => {
            created.settled = true;
            if (inFlight.get(key) === created) inFlight.delete(key);
        }).catch(() => undefined);
    }
    return consumeTask(task, signal);
}

/**
 * Mermaidを含む文書の初回描画前に共有ブラウザーと空の描画ページを準備する。
 * @param workerPath - Pele Worker bundleのファイルパス。
 * @param acquireBrowser - 描画ブラウザーを取得する処理。
 */
export async function preparePeleRenderer(
    workerPath: string,
    acquireBrowser: () => Promise<Browser>
): Promise<void> {
    await acquireRendererPage(workerPath, acquireBrowser);
}

/**
 * Mermaid Workerの待機列を直列で処理する。
 * @param operation - 実行する描画処理。
 * @returns 描画処理の結果。
 */
function enqueue(operation: () => Promise<PeleMermaidResult>): Promise<PeleMermaidResult> {
    const result = queueTail.then(operation);
    queueTail = result.then(() => undefined, () => undefined);
    return result;
}

/**
 * キュー上でWorker描画、画像解決、DOM計測、必要時のPNG化を行う。
 * @param source - Mermaid図のソース。
 * @param theme - 適用するPele配色。
 * @param workerPath - Pele Worker bundleのファイルパス。
 * @param acquireBrowser - 描画に使うPlaywrightブラウザーを取得する処理。
 * @param signal - 呼び出し元からのキャンセル通知。
 * @param options - 表示フォントと画像解決処理。
 * @returns 描画済みの図。
 */
async function renderQueued(
    source: string,
    theme: 'default' | 'dark' | 'neutral',
    workerPath: string,
    acquireBrowser: () => Promise<Browser>,
    signal: AbortSignal | undefined,
    options: PeleRenderOptions,
    renderingNow: number
): Promise<PeleMermaidResult> {
    if (signal?.aborted) throw new Error('Mermaid rendering was cancelled.');
    if (source.length > 50_000) throw new MermaidDiagramError('Mermaid source exceeds the 50000 character limit.');
    let page = await acquireRendererPage(workerPath, acquireBrowser);
    if (signal?.aborted) {
        await resetRendererPage();
        throw new Error('Mermaid rendering was cancelled.');
    }
    const requestId = `mve-pele-${++sequence}`;
    const renderWithWorker = (targetPage: Page) => targetPage.evaluate(async (payload) => {
        const workerState = window as typeof window & { __mvePeleWorker?: Worker; __mvePeleWorkerError?: string };
        if (workerState.__mvePeleWorkerError) throw new Error(workerState.__mvePeleWorkerError);
        const worker = workerState.__mvePeleWorker;
        if (!worker) throw new Error('Pele Worker is not initialized.');
        const rendered = await new Promise<{ svg: string; links: Array<{ id: string; href: string; internal: boolean }>; error?: string }>((resolve, reject) => {
            const cleanup = () => {
                worker.removeEventListener('message', onMessage);
                worker.removeEventListener('error', onError);
            };
            const onMessage = (event: MessageEvent) => {
                if (event.data?.id !== payload.requestId) return;
                cleanup();
                if (event.data.error) resolve({ svg: '', links: [], error: event.data.error });
                else resolve({ svg: event.data.svg, links: event.data.links ?? [] });
            };
            const onError = (event: ErrorEvent) => {
                cleanup();
                reject(new Error(event.message || 'Pele Worker failed.'));
            };
            worker.addEventListener('message', onMessage);
            worker.addEventListener('error', onError);
            try {
                worker.postMessage({
                    id: payload.requestId,
                    source: payload.source,
                    theme: payload.theme,
                    fontFamily: payload.fontFamily,
                    fontSize: payload.fontSize,
                    now: payload.renderingNow
                });
            } catch (error) {
                cleanup();
                reject(error);
            }
        });
        if (rendered.error) return { ...rendered, images: [] };
        const document = new DOMParser().parseFromString(rendered.svg, 'image/svg+xml');
        // 図の内容に起因する失敗は例外にせずNode側へ返し、MermaidDiagramErrorとして図単位で扱わせる。
        if (document.querySelector('parsererror')) return { svg: '', links: [], images: [], error: 'Pele returned invalid SVG.' };
        const images = Array.from(document.querySelectorAll('image')).map((image) =>
            image.getAttribute('href')
            ?? image.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
            ?? ''
        ).filter(Boolean);
        return { ...rendered, images };
    }, {
        requestId,
        source,
        theme,
        fontFamily: options.fontFamily,
        fontSize: normalizeMermaidFontSize(options.fontSize ?? DEFAULT_MERMAID_FONT_SIZE),
        renderingNow
    });

    let rendered: Awaited<ReturnType<typeof renderWithWorker>> | undefined;
    for (let attempt = 0; attempt < 2 && !rendered; attempt++) {
        if (signal?.aborted) throw new Error('Mermaid rendering was cancelled.');
        try {
            rendered = await renderWithWorker(page);
        } catch (error) {
            await resetRendererPage();
            if (signal?.aborted) throw new Error('Mermaid rendering was cancelled.');
            // 作り直したページでも失敗した場合、ブラウザーとWorkerは用意できているため図に起因する失敗として扱う。
            // ページを用意できない障害はacquireRendererPageがPeleRendererUnavailableErrorなどで中断させる。
            if (attempt === 1) throw new MermaidDiagramError('Mermaid diagram rendering failed after a retry.', { cause: error });
            page = await acquireRendererPage(workerPath, acquireBrowser);
            if (signal?.aborted) {
                await resetRendererPage();
                throw new Error('Mermaid rendering was cancelled.');
            }
        }
    }
    if (!rendered) throw new Error('Pele Worker did not return a rendering result.');
    if (rendered.error) throw new MermaidDiagramError(rendered.error);
    if (signal?.aborted) throw new Error('Mermaid rendering was cancelled.');
    const imageData = rendered.images.length && options.resolveImages
        ? await options.resolveImages(rendered.images, signal)
        : {};
    if (signal?.aborted) throw new Error('Mermaid rendering was cancelled.');
    const result = await page.evaluate((payload) => {
        const svgDocument = new DOMParser().parseFromString(payload.svg, 'image/svg+xml');
        const imageElements = Array.from(svgDocument.querySelectorAll('image'));
        for (const image of imageElements) {
            const source = image.getAttribute('href')
                ?? image.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
                ?? '';
            const dataUri = payload.imageData[source];
            if (!dataUri || !dataUri.startsWith('data:image/')) {
                image.remove();
                continue;
            }
            image.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
            image.setAttribute('href', dataUri);
        }
        const svg = new XMLSerializer().serializeToString(svgDocument.documentElement);
        // ブラウザー内の例外は型を失うため、図の内容に起因する失敗は戻り値で返しNode側でMermaidDiagramErrorにする。
        if (svg.length > payload.maxSvgChars) return { diagramError: 'Pele SVG with images exceeds the 12000000 character limit.' };
        const container = document.createElement('div');
        container.id = payload.containerId;
        container.style.cssText = 'width:1200px;background:transparent';
        container.innerHTML = svg;
        document.body.append(container);
        const svgNode = container.querySelector('svg');
        if (!svgNode) {
            container.remove();
            return { diagramError: 'Pele did not return an SVG element.' };
        }
        const rootRect = svgNode.getBoundingClientRect();
        const linksById = new Map(payload.links.map((link) => [link.id, link]));
        for (const anchor of Array.from(svgNode.querySelectorAll('a'))) {
            if (linksById.get(anchor.id)?.internal) anchor.setAttribute('data-mve-internal-link', 'true');
        }
        const toInteraction = (element: Element, type: 'text' | 'link', href?: string, internal = false) => {
            const text = element.textContent?.trim() ?? '';
            const rect = element.getBoundingClientRect();
            if (!text || rootRect.width <= 0 || rootRect.height <= 0 || rect.width <= 0 || rect.height <= 0) return undefined;
            return {
                type,
                text,
                href,
                internal: type === 'link' ? internal : undefined,
                left: (rect.left - rootRect.left) / rootRect.width,
                top: (rect.top - rootRect.top) / rootRect.height,
                width: rect.width / rootRect.width,
                height: rect.height / rootRect.height
            };
        };
        const textInteractions = Array.from(svgNode.querySelectorAll('text, foreignObject'))
            .filter((element) => element.tagName.toLowerCase() !== 'text' || !element.closest('foreignObject'))
            .map((element) => toInteraction(element, 'text'))
            .filter((item): item is NonNullable<typeof item> => item !== undefined);
        const linkInteractions = Array.from(svgNode.querySelectorAll('a'))
            .map((element) => {
                const link = linksById.get(element.id);
                const href = link?.href
                    ?? element.getAttribute('href')
                    ?? element.getAttribute('xlink:href')
                    ?? undefined;
                return toInteraction(element, 'link', href, link?.internal ?? false);
            })
            .filter((item): item is NonNullable<typeof item> => item !== undefined && Boolean(item.href));
        const ariaLabel = svgNode.querySelector('title')?.textContent?.trim()
            ?? svgNode.getAttribute('aria-label')
            ?? textInteractions.slice(0, 20).map((item) => item.text).join(', ');
        return { svg, interactions: [...textInteractions, ...linkInteractions], ariaLabel };
    }, {
        svg: rendered.svg,
        imageData,
        links: rendered.links,
        containerId: `${requestId}-container`,
        maxSvgChars: MAX_FINAL_SVG_CHARS
    });
    if (typeof result.diagramError === 'string') throw new MermaidDiagramError(result.diagramError);

    try {
        const finalResult: PeleMermaidResult = {
            ...(result.svg.length < LARGE_SVG_LIMIT
            ? result
            : {
                ...result,
                pngBase64: await captureLargeSvgPng(page, requestId)
            }),
            hasImages: rendered.images.length > 0
        };
        return finalResult;
    } finally {
        await page.evaluate((id) => document.getElementById(id)?.remove(), `${requestId}-container`).catch(() => undefined);
    }
}

/**
 * 大きなSVGのPNG画像を取得する。SVGは描画済みのため、撮影に失敗しても図の失敗にはせずPNGなしで続ける。
 * @param page - SVGを配置済みの描画ページ。
 * @param requestId - 撮影するSVGを含むコンテナIDの接頭辞。
 * @returns PNGのBase64文字列。撮影に失敗した場合はundefined。
 */
async function captureLargeSvgPng(page: Page, requestId: string): Promise<string | undefined> {
    try {
        return (await page.locator(`#${requestId}-container svg`).screenshot({
            type: 'png',
            animations: 'disabled'
        })).toString('base64');
    } catch {
        return undefined;
    }
}

/**
 * 現地日付の午前0時をPeleの相対日付解決に使う。
 * @param timestamp - 現在時刻。
 * @returns 同じ現地日の開始時刻。
 */
function localDayStart(timestamp: number): number {
    const date = new Date(timestamp);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Workerを許可する隔離ページを再利用して取得する。
 * @param workerPath - Worker bundleのファイルパス。
 * @param acquireBrowser - 描画ブラウザーの取得処理。
 * @returns Worker実行用のページ。
 */
async function acquireRendererPage(workerPath: string, acquireBrowser: () => Promise<Browser>): Promise<Page> {
    if (rendererPage && !rendererPage.isClosed()) return rendererPage;
    if (pagePromise) return pagePromise;
    pagePromise = (async () => {
        try {
            const browser = await acquireBrowser();
            const context = await browser.newContext({ javaScriptEnabled: true });
            browserContext = context;
            await context.route('**/*', (route) => route.abort('blockedbyclient'));
            const page = await context.newPage();
            await page.setContent('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' blob:; worker-src blob:; img-src data: blob:; style-src \'unsafe-inline\'; font-src data:"></head><body></body></html>');
            const workerSource = await readWorkerSource(workerPath);
            await page.evaluate(async (source) => {
                const workerState = window as typeof window & { __mvePeleWorker?: Worker; __mvePeleWorkerError?: string };
                const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
                const persistentWorker = new Worker(blobUrl);
                workerState.__mvePeleWorker = persistentWorker;
                workerState.__mvePeleWorkerError = undefined;
                persistentWorker.addEventListener('error', (event) => {
                    workerState.__mvePeleWorkerError = event.message || 'Pele Worker failed.';
                });
                try {
                    await new Promise<void>((resolve, reject) => {
                        const timeout = window.setTimeout(() => {
                            cleanup();
                            reject(new Error('Pele Worker initialization timed out.'));
                        }, 15_000);
                        const cleanup = () => {
                            window.clearTimeout(timeout);
                            persistentWorker.removeEventListener('message', onMessage);
                            persistentWorker.removeEventListener('error', onError);
                        };
                        const onMessage = (event: MessageEvent) => {
                            if (event.data?.ready !== true) return;
                            cleanup();
                            resolve();
                        };
                        const onError = (event: ErrorEvent) => {
                            cleanup();
                            reject(new Error(event.message || 'Pele Worker failed to initialize.'));
                        };
                        persistentWorker.addEventListener('message', onMessage);
                        persistentWorker.addEventListener('error', onError);
                    });
                } catch (error) {
                    persistentWorker.terminate();
                    URL.revokeObjectURL(blobUrl);
                    delete workerState.__mvePeleWorker;
                    delete workerState.__mvePeleWorkerError;
                    throw error;
                }
            }, workerSource);
            rendererPage = page;
            return page;
        } catch (error) {
            await resetRendererPage();
            throw new PeleRendererUnavailableError('Pele renderer could not be initialized.', { cause: error });
        }
    })().finally(() => { pagePromise = undefined; });
    return pagePromise;
}

/**
 * Worker bundleの本文をパスごとに遅延読込して共有する。
 * @param workerPath - Worker bundleのファイルパス。
 * @returns Workerへ渡すJavaScript本文。
 */
function readWorkerSource(workerPath: string): Promise<string> {
    let source = workerScriptCache.get(workerPath);
    if (!source) {
        source = readFile(path.resolve(workerPath), 'utf8');
        workerScriptCache.set(workerPath, source);
    }
    return source;
}

/**
 * キャンセル時に共有描画Pageを破棄し、次回要求で再生成できる状態へ戻す。
 */
async function resetRendererPage(): Promise<void> {
    rendererPage = undefined;
    const context = browserContext;
    browserContext = undefined;
    if (context) await context.close().catch(() => undefined);
}

/**
 * Mermaid Worker、Page、SVGキャッシュを解放する。
 */
export async function closePeleRenderer(): Promise<void> {
    for (const task of inFlight.values()) {
        task.cancelled = true;
        task.controller.abort();
    }
    await resetRendererPage();
    cache.clear();
    cacheBytes = 0;
    inFlight.clear();
    workerScriptCache = new Map();
    queueTail = Promise.resolve();
}

/**
 * 描画Promiseを時間制限付きで待つ。時間切れの場合はonTimeoutで描画ページを破棄し、処理の終了を待ってから
 * MermaidDiagramErrorで失敗させる。次の図は作り直したページで描画できるため、文書全体は中断しない。
 * @param operation - 実行中の処理。
 * @param timeoutMs - 時間制限。
 * @param onTimeout - タイムアウト時の終了処理。
 * @returns 描画結果。
 */
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, onTimeout: () => Promise<void>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTriggered = false;
    // 時間切れ時はonTimeoutで描画ページを破棄して次の図を描けるため、文書全体ではなくその図の失敗として扱う。
    const timeoutError = new MermaidDiagramError(`Pele rendering timed out after ${timeoutMs}ms.`);
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            timeoutTriggered = true;
            void (async () => {
                try {
                    await onTimeout();
                } catch {
                    // The operation still must settle before the render queue can advance.
                }
                await operation.catch(() => undefined);
                reject(timeoutError);
            })();
        }, timeoutMs);
    });
    try {
        const result = await Promise.race([operation, timeout]);
        if (timeoutTriggered) {
            await timeout.catch(() => undefined);
            throw timeoutError;
        }
        return result;
    } catch (error) {
        if (timeoutTriggered) {
            await timeout.catch(() => undefined);
            throw timeoutError;
        }
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * 共通描画を購読し、最後の呼び出し元がキャンセルした場合にWorkerを停止する。
 * @param task - 共有描画処理。
 * @param signal - 呼び出し元からのキャンセル通知。
 * @returns 呼び出し元に返す描画結果。
 */
function consumeTask(task: RenderTask, signal?: AbortSignal): Promise<PeleMermaidResult> {
    task.consumers += 1;
    let settled = false;
    const release = () => {
        if (settled) return;
        settled = true;
        task.consumers = Math.max(0, task.consumers - 1);
        if (task.consumers === 0 && !task.settled) {
            task.cancelled = true;
            task.controller.abort();
            if (task.started) void resetRendererPage();
        }
    };
    return new Promise<PeleMermaidResult>((resolve, reject) => {
        const abort = () => {
            release();
            reject(new Error('Mermaid rendering was cancelled.'));
        };
        if (signal?.aborted) {
            abort();
            return;
        }
        signal?.addEventListener('abort', abort, { once: true });
        task.promise.then(
            (result) => {
                if (settled) return;
                signal?.removeEventListener('abort', abort);
                release();
                resolve(result);
            },
            (error) => {
                if (settled) return;
                signal?.removeEventListener('abort', abort);
                release();
                reject(error);
            }
        );
    });
}

/**
 * 成功結果のLRUキャッシュを読み、最近使用した項目を末尾へ移す。
 * @param key - ソース・テーマ・フォントを含むキャッシュキー。
 * @returns キャッシュ済み結果。
 */
function readCache(key: string): PeleMermaidResult | undefined {
    const result = cache.get(key);
    if (!result) return undefined;
    cache.delete(key);
    cache.set(key, result);
    return result;
}

/**
 * 画像を含まない描画結果を件数・容量制限付きで保存する。
 * @param key - キャッシュキー。
 * @param result - 保存する描画結果。
 */
function writeCache(key: string, result: PeleMermaidResult): void {
    const bytes = (result.svg.length + result.ariaLabel.length + (result.pngBase64?.length ?? 0)) * 2
        + result.interactions.reduce((sum, item) => sum + (item.text.length + (item.href?.length ?? 0)) * 2 + 64, 0);
    const previous = cache.get(key);
    if (previous) cacheBytes -= resultBytes(previous);
    cache.set(key, result);
    cacheBytes += bytes;
    while (cache.size > CACHE_LIMIT || cacheBytes > CACHE_BYTE_LIMIT) {
        const oldest = cache.keys().next().value as string | undefined;
        if (!oldest) break;
        const removed = cache.get(oldest);
        cache.delete(oldest);
        if (removed) cacheBytes -= resultBytes(removed);
    }
}

/**
 * キャッシュ項目の概算メモリー量を返す。
 * @param result - 計算対象。
 * @returns UTF-16文字列領域を基準とするバイト数。
 */
function resultBytes(result: PeleMermaidResult): number {
    return (result.svg.length + result.ariaLabel.length + (result.pngBase64?.length ?? 0)) * 2
        + result.interactions.reduce((sum, item) => sum + (item.text.length + (item.href?.length ?? 0)) * 2 + 64, 0);
}
