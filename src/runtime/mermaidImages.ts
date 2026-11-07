/**
 * @fileoverview Mermaid図の画像を検証し、Workerや出力側から参照できるdata URIへ変換する。
 */
import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { isIP, type LookupFunction } from 'node:net';
import { request as httpsRequest } from 'node:https';

/** Mermaid図ごとに取得する画像の件数上限。 */
export const MAX_IMAGE_COUNT = 8;
/** Mermaid図1件から読み込む画像1枚の最大バイト数。 */
export const MAX_MERMAID_IMAGE_BYTES = 2 * 1024 * 1024;
/** HTTP応答から保持する画像1件の上限。 */
const MAX_IMAGE_BYTES = MAX_MERMAID_IMAGE_BYTES;
/** 1つのMermaid図で取得する画像データの合計上限。 */
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
/** 画像ヘッダー検査で許可する1画像の画素数上限。 */
const MAX_IMAGE_PIXELS = 16_000_000;
/** 1つのMermaid図に含まれる全画像の画素数上限。 */
const MAX_TOTAL_IMAGE_PIXELS = 32_000_000;
/** 巨大な画像寸法によるデコード負荷を避ける上限。 */
const MAX_IMAGE_DIMENSION = 8192;
/** 外部画像要求全体のタイムアウト。 */
const NETWORK_TIMEOUT_MS = 4_000;
/** DNS解決を待つ時間の上限。 */
const DNS_TIMEOUT_MS = 4_000;
/** 外部画像キャッシュの有効期間。 */
const REMOTE_CACHE_TTL_MS = 30_000;
/** 外部画像キャッシュの件数上限。 */
const REMOTE_CACHE_LIMIT = 32;

/** 画像データとして受け入れるラスター形式。 */
type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** バイト列・形式・寸法検査を通過した画像。 */
interface ValidatedImage {
    bytes: Buffer;
    mime: ImageMime;
    pixels: number;
}

/** 有効期限と総容量の管理に用いるキャッシュ項目。 */
interface CachedImage {
    dataUri: string;
    expiresAt: number;
    byteLength: number;
    pixels: number;
}

/** 外部画像キャッシュ。キーは正規化したURL、値は検証済み画像と期限。 */
const remoteImageCache = new Map<string, CachedImage>();
/** キャッシュ済み画像バイト列の合計。上限超過時の古い項目削除に使う。 */
let remoteImageCacheBytes = 0;

/**
 * Mermaidから参照されたローカル画像と外部画像を検証し、元のURLごとのdata URIを返す。
 * @param sources - PeleがSVGへ出力した画像参照。
 * @param readLocal - 許可範囲内のローカル画像を読む処理。
 * @param signal - 呼び出し元からのキャンセル通知。
 * @returns 検証できた画像参照とdata URIの対応表。
 */
export async function resolveMermaidImageSources(
    sources: string[],
    readLocal: (source: string) => Promise<Uint8Array | undefined>,
    signal?: AbortSignal
): Promise<Record<string, string>> {
    throwIfAborted(signal);
    const result: Record<string, string> = {};
    const uniqueSources = [...new Set(sources)].slice(0, MAX_IMAGE_COUNT);
    let totalBytes = 0;
    let totalPixels = 0;

    for (let offset = 0; offset < uniqueSources.length; offset += 4) {
        throwIfAborted(signal);
        const batch = await Promise.all(uniqueSources.slice(offset, offset + 4).map(async (source) => {
            try {
                const image = /^https?:/i.test(source)
                    ? await getRemoteImage(source, signal)
                    : await readLocal(source).then((bytes) => bytes ? validateImage(Buffer.from(bytes)) : undefined);
                throwIfAborted(signal);
                return image ? { source, image } : undefined;
            } catch {
                throwIfAborted(signal);
                // 読み込めない画像は空の表示領域にし、図全体の描画は継続する。
                return undefined;
            }
        }));
        throwIfAborted(signal);
        for (const item of batch) {
            if (!item
                || totalBytes + item.image.bytes.byteLength > MAX_TOTAL_IMAGE_BYTES
                || totalPixels + item.image.pixels > MAX_TOTAL_IMAGE_PIXELS) continue;
            totalBytes += item.image.bytes.byteLength;
            totalPixels += item.image.pixels;
            result[item.source] = `data:${item.image.mime};base64,${item.image.bytes.toString('base64')}`;
        }
    }

    return result;
}

/**
 * 外部画像をDNS検査後にIP固定で取得し、リダイレクトや非公開ネットワークへの接続を拒否する。
 * @param source - HTTPまたはHTTPSの画像URL。
 * @returns 画像本体と検証済みMIME。条件に合わない参照はundefined。
 */
async function getRemoteImage(source: string, signal?: AbortSignal): Promise<ValidatedImage | undefined> {
    throwIfAborted(signal);
    const url = new URL(source);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined;
    url.hash = '';
    const cached = readRemoteCache(url.toString());
    if (cached) {
        const bytes = Buffer.from(cached.dataUri.slice(cached.dataUri.indexOf(',') + 1), 'base64');
        const mime = cached.dataUri.slice(5, cached.dataUri.indexOf(';')) as ImageMime;
        return { bytes, mime, pixels: cached.pixels };
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!hostname) return undefined;

    const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await withTimeout(
            new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
                lookup(hostname, { all: true, verbatim: true }, (error, values) => {
                    if (error) reject(error);
                    else resolve(values);
                });
            }),
            DNS_TIMEOUT_MS,
            signal
        );
    throwIfAborted(signal);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) return undefined;

    const selected = addresses[0];
    const pinnedLookup: LookupFunction = (
        _host: string,
        options,
        callback
    ) => {
        if (options.all) {
            callback(null, [{ address: selected.address, family: selected.family }]);
        } else {
            callback(null, selected.address, selected.family);
        }
    };
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const image = await requestImage(transport, {
        protocol: url.protocol,
        hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        servername: url.protocol === 'https:' && !isIP(hostname) ? hostname : undefined,
        lookup: pinnedLookup,
        signal
    });
    throwIfAborted(signal);
    cacheRemoteImage(url.toString(), image);
    return image;
}

/** 公開IPへ固定した要求先とTLS検証用の元ホスト情報。 */
interface ImageRequestOptions {
    protocol: string;
    hostname: string;
    port?: string;
    path: string;
    servername?: string;
    lookup: LookupFunction;
    signal?: AbortSignal;
}

/**
 * リダイレクトなし・上限付きの単一HTTP要求で画像を取得する。
 * @param transport - HTTPまたはHTTPSの標準要求関数。
 * @param options - DNS固定、TLS SNI、URL pathの要求情報。
 * @returns 内容と画像形式を検証した画像データ。
 */
function requestImage(
    transport: typeof httpRequest | typeof httpsRequest,
    options: ImageRequestOptions
): Promise<ValidatedImage> {
    return new Promise<ValidatedImage>((resolve, reject) => {
        if (options.signal?.aborted) {
            reject(new Error('Mermaid image resolution was cancelled.'));
            return;
        }
        let settled = false;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let request!: ReturnType<typeof httpRequest>;
        const cleanup = () => {
            if (deadline) clearTimeout(deadline);
            options.signal?.removeEventListener('abort', onAbort);
        };
        const settle = (action: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            action();
        };
        const settleReject = (error: unknown) => settle(() => reject(error));
        const settleResolve = (image: ValidatedImage) => settle(() => resolve(image));
        const onAbort = () => {
            request.destroy();
            settleReject(new Error('Mermaid image resolution was cancelled.'));
        };
        request = transport({
            protocol: options.protocol,
            hostname: options.hostname,
            port: options.port,
            path: options.path,
            method: 'GET',
            agent: false,
            lookup: options.lookup,
            servername: options.servername,
            headers: { accept: 'image/png,image/jpeg,image/gif,image/webp' }
        }, (response) => {
            const status = response.statusCode ?? 0;
            const contentLength = Number(response.headers['content-length']);
            const contentType = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
            if (status !== 200 || (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES)) {
                response.destroy();
                settleReject(new Error('Remote image response was rejected.'));
                return;
            }
            if (!contentType || !isImageMime(contentType)) {
                response.destroy();
                settleReject(new Error('Remote image content type was rejected.'));
                return;
            }
            const chunks: Buffer[] = [];
            let byteLength = 0;
            response.on('data', (chunk: Buffer | Uint8Array) => {
                const buffer = Buffer.from(chunk);
                byteLength += buffer.byteLength;
                if (byteLength > MAX_IMAGE_BYTES) {
                    const error = new Error('Remote image exceeded the size limit.');
                    response.destroy(error);
                    settleReject(error);
                    return;
                }
                chunks.push(buffer);
            });
            response.on('error', settleReject);
            response.on('end', () => {
                try {
                    const image = validateImage(Buffer.concat(chunks));
                    if (!image || image.mime !== contentType) throw new Error('Remote image data was rejected.');
                    settleResolve(image);
                } catch (error) {
                    settleReject(error);
                }
            });
        });
        request.on('error', settleReject);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        deadline = setTimeout(() => {
            const error = new Error('Remote image request timed out.');
            request.destroy(error);
            settleReject(error);
        }, NETWORK_TIMEOUT_MS);
        request.setTimeout(NETWORK_TIMEOUT_MS, () => {
            const error = new Error('Remote image request timed out.');
            request.destroy(error);
            settleReject(error);
        });
        request.end();
    });
}

/**
 * Raster画像のシグネチャと寸法を検証して、デコード負荷の上限を適用する。
 * @param bytes - 読み込んだ画像候補。
 * @returns 対応する画像形式。形式または寸法が不正な場合はundefined。
 */
function validateImage(bytes: Buffer): ValidatedImage | undefined {
    if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) return undefined;
    const dimensions = readImageDimensions(bytes);
    if (!dimensions || !dimensions.width || !dimensions.height
        || dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION
        || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) return undefined;
    return { bytes, mime: dimensions.mime, pixels: dimensions.width * dimensions.height };
}

/** 画像ヘッダーから読み取った許可形式と寸法。 */
interface ImageDimensions {
    width: number;
    height: number;
    mime: ImageMime;
}

/**
 * 対応するPNG、JPEG、GIF、WebPのヘッダーから画素数を読み取る。
 * @param bytes - MIMEを判定するバイナリ画像。
 * @returns 画像形式と寸法。未対応形式や不完全なデータはundefined。
 */
function readImageDimensions(bytes: Buffer): ImageDimensions | undefined {
    if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), mime: 'image/png' };
    }
    if (bytes.length >= 10 && (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a')) {
        return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), mime: 'image/gif' };
    }
    if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
        const kind = bytes.toString('ascii', 12, 16);
        if (kind === 'VP8X') {
            const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
            const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
            return { width, height, mime: 'image/webp' };
        }
        if (kind === 'VP8L' && bytes[20] === 0x2f) {
            const bits = bytes.readUInt32LE(21);
            return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, mime: 'image/webp' };
        }
        if (kind === 'VP8 ' && bytes.length >= 30) {
            return {
                width: bytes.readUInt16LE(26) & 0x3fff,
                height: bytes.readUInt16LE(28) & 0x3fff,
                mime: 'image/webp'
            };
        }
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < bytes.length) {
            if (bytes[offset] !== 0xff) {
                offset += 1;
                continue;
            }
            const marker = bytes[offset + 1];
            const length = bytes.readUInt16BE(offset + 2);
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7), mime: 'image/jpeg' };
            }
            if (length < 2) return undefined;
            offset += 2 + length;
        }
    }
    return undefined;
}

/**
 * MIME許可リストと照合する。
 * @param value - Content-Typeヘッダーから得たMIME。
 * @returns ラスター画像として許可する形式かどうか。
 */
function isImageMime(value: string): value is ImageMime {
    return value === 'image/png' || value === 'image/jpeg' || value === 'image/gif' || value === 'image/webp';
}

/**
 * IPv4、IPv6の非公開・予約・ループバック・リンクローカル宛を除外する。
 * @param address - DNSで解決したIPアドレス。
 * @returns 公開宛先として許可できる場合はtrue。
 */
function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) {
        const octets = address.split('.').map(Number);
        if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
        const [a, b, c] = octets;
        return !(a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 0 && c <= 2)
            || (a === 192 && b === 88 && c === 99)
            || (a === 192 && b === 168)
            || (a === 198 && (b === 18 || b === 19 || b === 51))
            || (a === 203 && b === 0 && c === 113));
    }
    if (family !== 6 || address.includes('%')) return false;
    const value = parseIpv6(address);
    if (value === undefined) return false;
    const inCidr = (network: string, length: number) => {
        const base = parseIpv6(network);
        if (base === undefined) return true;
        const shift = BigInt(128 - length);
        return value >> shift === base >> shift;
    };
    if (value === 0n || value === 1n) return false;
    if (inCidr('64:ff9b::', 96) || inCidr('64:ff9b:1::', 48)) return false;
    if (inCidr('fc00::', 7) || inCidr('fe80::', 10) || inCidr('ff00::', 8)) return false;
    if (inCidr('100::', 64) || inCidr('100:0:0:1::', 64)) return false;
    if (inCidr('2001:db8::', 32) || inCidr('2001::', 23) || inCidr('2001:2::', 48)
        || inCidr('2001:10::', 28) || inCidr('2001:20::', 28) || inCidr('2001:30::', 28)
        || inCidr('2002::', 16) || inCidr('3fff::', 20)) return false;
    if (!inCidr('2000::', 3)) return false;
    if (value >> 32n === 0xffffn) {
        const ipv4 = [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.');
        return isPublicAddress(ipv4);
    }
    return true;
}

/**
 * IPv6文字列を128bit整数へ展開する。
 * @param address - 検査するIPv6文字列。
 * @returns 展開値。不正形式はundefined。
 */
function parseIpv6(address: string): bigint | undefined {
    let normalized = address.toLowerCase();
    if (normalized.includes('.')) {
        const lastColon = normalized.lastIndexOf(':');
        const ipv4 = normalized.slice(lastColon + 1).split('.').map(Number);
        if (ipv4.length !== 4 || ipv4.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return undefined;
        normalized = `${normalized.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
    }
    const halves = normalized.split('::');
    if (halves.length > 2) return undefined;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
    const groups = [...left, ...Array(missing).fill('0'), ...right];
    if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
    return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

/**
 * リモート画像の期限切れ項目を除き、最近使用した項目を先頭へ移動する。
 * @param key - URLのキャッシュキー。
 * @returns 有効なキャッシュ項目。
 */
function readRemoteCache(key: string): CachedImage | undefined {
    const entry = remoteImageCache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
        remoteImageCache.delete(key);
        remoteImageCacheBytes -= entry.byteLength;
        return undefined;
    }
    remoteImageCache.delete(key);
    remoteImageCache.set(key, entry);
    return entry;
}

/**
 * 期限付き・容量制限付きキャッシュへリモート画像を保存する。
 * @param key - URLのキャッシュキー。
 * @param image - 保存する検証済み画像。
 */
function cacheRemoteImage(key: string, image: ValidatedImage): void {
    const dataUri = `data:${image.mime};base64,${image.bytes.toString('base64')}`;
    const byteLength = image.bytes.byteLength;
    const previous = remoteImageCache.get(key);
    if (previous) remoteImageCacheBytes -= previous.byteLength;
    remoteImageCache.delete(key);
    remoteImageCache.set(key, { dataUri, byteLength, pixels: image.pixels, expiresAt: Date.now() + REMOTE_CACHE_TTL_MS });
    remoteImageCacheBytes += byteLength;
    while (remoteImageCache.size > REMOTE_CACHE_LIMIT || remoteImageCacheBytes > MAX_TOTAL_IMAGE_BYTES * 2) {
        const oldest = remoteImageCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const removed = remoteImageCache.get(oldest);
        remoteImageCache.delete(oldest);
        if (removed) remoteImageCacheBytes -= removed.byteLength;
    }
}

/**
 * DNSなど停止できないPromiseを時間制限付きで待つ。
 * @param promise - 完了を待つ処理。
 * @param timeoutMs - 待ち時間の上限。
 * @param signal - 呼び出し元からのキャンセル通知。
 * @returns 完了値。
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('Mermaid image resolution was cancelled.'));
            return;
        }
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('Mermaid image DNS lookup timed out.'));
        }, timeoutMs);
        const onAbort = () => {
            cleanup();
            reject(new Error('Mermaid image resolution was cancelled.'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => { cleanup(); resolve(value); },
            (error) => { cleanup(); reject(error); }
        );
    });
}

/**
 * キャンセル済みの画像処理を中断する。
 * @param signal - 呼び出し元からのキャンセル通知。
 */
function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('Mermaid image resolution was cancelled.');
}
