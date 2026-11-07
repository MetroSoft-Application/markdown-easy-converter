/**
 * @fileoverview CLI（Node.js側）で、文書が参照するローカルファイルを読み込んでよいかを判定する。
 * 文書は信頼できない入力として扱い、画像参照を経由して任意のファイルが生成物へ混入することを防ぐ。
 * 副作用はファイルの読み取り（realpath と先頭バイト）だけで、判定結果の通知は呼び出し側が行う。
 * 不変条件: 読み込む範囲を制限するときは、ネットワークパスへ接続する前に拒否する。
 * ローカルのシンボリックリンクの先がネットワークパスの場合も、リンクを1段ずつ読むことで接続せずに検出する。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** ローカル画像の読み込み方針と、読み込まなかった場合の通知先。 */
export interface LocalImagePolicy {
    /** 設定時は、この実ディレクトリの外にあるファイルを読み込まない。未設定時は場所を制限しない。 */
    restrictRoot?: string;
    /** 読み込まなかった画像などの警告を受け取る。未設定時は標準エラーへ出力する。 */
    onWarning?: (message: string) => void;
    /**
     * ディレクトリごとのネットワーク到達の判定結果。1回の変換の間だけ共有する。
     * 同じディレクトリの画像が多い文書で`lstat`を繰り返すと変換が目に見えて遅くなるため、呼び出し側が用意する。
     */
    networkDirectoryCache?: Map<string, Promise<boolean>>;
    /**
     * ディレクトリごとの通常ファイル名の一覧。1回の変換の間だけ共有する。
     * 大量の画像の存在確認でシステムコールを繰り返さないよう、一覧を1回だけ読む。
     */
    directoryListingCache?: Map<string, Promise<Set<string>>>;
}

/**
 * ファイル名を一覧の照合用に正規化する。Windowsのファイルシステムの慣例に合わせて大文字小文字を区別しない。
 * @param name - ファイル名。
 * @returns 照合用の文字列。
 */
function listingKey(name: string): string {
    return process.platform === 'win32' ? name.toLowerCase() : name;
}

/**
 * ファイルがディレクトリの一覧に通常ファイルとして載っているかを判定する。
 * 載っていない場合は「存在しない」とは限らない（リンクや表記の揺れなど）ので、呼び出し側で個別に確認する。
 * @param filePath - 解決済みのローカルファイルパス。親ディレクトリがネットワーク上にないことを確認済みであること。
 * @param cache - ディレクトリごとの一覧。
 * @returns 一覧に載っている場合にtrue。ディレクトリを読めない場合はfalse。
 */
async function isListedRegularFile(filePath: string, cache: Map<string, Promise<Set<string>>>): Promise<boolean> {
    const directory = path.dirname(filePath);
    let listing = cache.get(directory);
    if (!listing) {
        listing = fs.readdir(directory, { withFileTypes: true }).then(
            (entries) => new Set(entries.filter((entry) => entry.isFile()).map((entry) => listingKey(entry.name))),
            () => new Set<string>());
        cache.set(directory, listing);
    }
    return (await listing).has(listingKey(path.basename(filePath)));
}

/** ラスター画像の形式判定に読み込むバイト数。BMPのDIBヘッダーサイズまで読める長さ。 */
const IMAGE_SIGNATURE_BYTES = 32;

/**
 * BMPのDIBヘッダーのサイズの最大値。OS/2 2.xには可変長のヘッダーがあるため、個別の値ではなく範囲で判定する。
 * テキストのこの位置の4バイトは巨大な値になるため、`BM`で始まるだけのテキストと区別できる。
 */
const MAX_BMP_DIB_HEADER_BYTES = 124;

/** BMPのDIBヘッダーのサイズの最小値。 */
const MIN_BMP_DIB_HEADER_BYTES = 12;

/** AVIFの`ftyp`ボックスとして受け入れる最大サイズ。テキストの先頭4バイトは巨大な値になるため区別できる。 */
const MAX_FTYP_BOX_BYTES = 4096;

/**
 * ファイル先頭のバイト列が、Chromiumが形式を自動判定して表示できるラスター画像の署名かを判定する。
 * `BM`や`GIF8`のような短い文字列だけで判定すると、その文字列で始まるテキストの混入を許すため、構造まで確認する。
 * @param header - ファイル先頭のバイト列。
 * @param avifExtension - `.avif`の場合にtrue。AVIFの主ブランドは`mif1`などもあり得るため、拡張子があれば`ftyp`の構造だけで認める。
 * @returns PNG、JPEG、GIF、WebP、BMP、ICO（カーソルを含む）、AVIFの署名に一致する場合にtrue。
 */
function hasImageSignature(header: Buffer, avifExtension: boolean): boolean {
    /** 指定範囲を1バイト1文字の文字列にして、バイナリの署名と比較できるようにする。 */
    const ascii = (start: number, end: number): string => header.toString('latin1', start, end);
    const gif = ascii(0, 6);
    if (ascii(0, 8) === '\x89PNG\r\n\x1a\n' || ascii(0, 3) === '\xff\xd8\xff' || gif === 'GIF87a' || gif === 'GIF89a') return true;
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' && ascii(12, 15) === 'VP8') return true;
    if (ascii(0, 4) === '\x00\x00\x01\x00' || ascii(0, 4) === '\x00\x00\x02\x00') return true;
    if (header.length < 18) return false;
    const dibSize = header.readUInt32LE(14);
    if (ascii(0, 2) === 'BM' && dibSize >= MIN_BMP_DIB_HEADER_BYTES && dibSize <= MAX_BMP_DIB_HEADER_BYTES) return true;
    const ftypSize = header.readUInt32BE(0);
    return ascii(4, 8) === 'ftyp' && ftypSize >= 12 && ftypSize <= MAX_FTYP_BOX_BYTES
        && (avifExtension || ascii(8, 11) === 'avi');
}

/**
 * DOCTYPE宣言の終端を探す。内部サブセットの`[...]`や引用符の中の`>`では終わらない。
 * @param text - 文書全体。
 * @param start - `<!DOCTYPE`の開始位置。
 * @returns 宣言の直後の位置。閉じていない場合は-1。
 */
function findDoctypeEnd(text: string, start: number): number {
    let quote: string | undefined;
    let inSubset = false;
    for (let index = start; index < text.length; index += 1) {
        const character = text[index];
        if (quote) {
            if (character === quote) quote = undefined;
        } else if (text.startsWith('<!--', index)) {
            // 内部サブセットのコメント内のアポストロフィを引用符として扱わない。
            const close = text.indexOf('-->', index);
            if (close < 0) return -1;
            index = close + 2;
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '[') {
            inSubset = true;
        } else if (character === ']') {
            inSubset = false;
        } else if (character === '>' && !inSubset) {
            return index + 1;
        }
    }
    return -1;
}

/**
 * SVG文書の最初の要素が`svg`かを判定する。
 * 本文のどこかに`<svg`を含むだけのHTMLやテキストを画像として扱わないよう、XML宣言、処理命令、コメント、
 * DOCTYPEだけを読み飛ばす。正規表現の繰り返しを避け、巨大なコメントでも線形時間で走査する。
 * @param text - 文書全体。BOMとNUL文字は除去済み。
 * @returns 最初の要素が`svg`または名前空間プレフィックス付きの`svg`の場合にtrue。
 */
function startsWithSvgElement(text: string): boolean {
    let position = 0;
    for (; ;) {
        while (position < text.length && /\s/.test(text[position])) position += 1;
        let end: number;
        if (text.startsWith('<?', position)) {
            const close = text.indexOf('?>', position);
            end = close < 0 ? -1 : close + 2;
        } else if (text.startsWith('<!--', position)) {
            const close = text.indexOf('-->', position);
            end = close < 0 ? -1 : close + 3;
        } else if (/^<!doctype/i.test(text.slice(position, position + 9))) {
            end = findDoctypeEnd(text, position);
        } else {
            break;
        }
        if (end < 0) return false;
        position = end;
    }
    return /^<(?:[\w.-]+:)?svg[\s>/]/i.test(text.slice(position, position + 256));
}

/**
 * ローカルファイルの内容が画像かを判定する。
 * 拡張子を信用しないのは、`.png`へ改名したテキストや、`x.png`という名前で秘密鍵を指すシンボリックリンクを
 * 埋め込まないため。逆に拡張子がなくても内容が画像なら従来どおり埋め込める。
 * SVGはテキストで署名がなく、従来も`.svg`以外ではブラウザーが表示できなかったため、拡張子も条件にする。
 * @param filePath - 解決済みのローカルファイルパス。リンクの場合はリンク先の内容を判定する。
 * @returns 画像と判定した場合にtrue。
 * @throws ファイルを開けない場合はファイルシステムのエラーを伝播する。
 */
async function isImageFile(filePath: string): Promise<boolean> {
    const extension = path.extname(filePath).toLowerCase();
    const file = await fs.open(filePath, 'r');
    try {
        if (extension === '.svg') {
            // 先頭のコメントがどれだけ長くても判定できるよう全体を読む。埋め込むなら同じ量を読むので負担は増えない。
            // UTF-8とUTF-16のBOMを除き、UTF-16でも判定できるようNUL文字を除く。
            const content = (await file.readFile()).toString('latin1');
            return startsWithSvgElement(content.replace(/\0/g, '').replace(/^(?:\xef\xbb\xbf|\xff\xfe|\xfe\xff)/, ''));
        }
        const buffer = Buffer.alloc(IMAGE_SIGNATURE_BYTES);
        const { bytesRead } = await file.read(buffer, 0, IMAGE_SIGNATURE_BYTES, 0);
        return hasImageSignature(buffer.subarray(0, bytesRead), extension === '.avif');
    } finally {
        await file.close();
    }
}

/**
 * Windowsのネットワークパス（UNC）やデバイスパスかを判定する。
 * これらへのアクセスは外部ホストへの接続と認証情報の送信を起こす可能性がある。
 * @param filePath - 解決済みのファイルパス。
 * @returns Windowsで`\\`または`//`から始まる場合にtrue。POSIXでは常にfalse。
 */
function isNetworkPath(filePath: string): boolean {
    return process.platform === 'win32' && /^[\\/]{2}/.test(filePath);
}

/** シンボリックリンクをたどる回数の上限。循環で止まらなくなることを防ぐ。 */
const MAX_LINK_DEPTH = 32;

/**
 * パスがネットワークへ到達するかを、接続を起こさずに判定する。
 * `realpath`はリンクを解決する時点で接続してしまうため、ローカル側の区間を`lstat`と`readlink`で1段ずつたどる。
 * 親ディレクトリから順に判定し、その結果を再利用する。
 * リンクをたどった先（`depth`が1以上）はキャッシュを使わない。`x -> x/sub`のようなリンクで、
 * 判定中の自分自身の結果を待ち続けることを防ぐため。
 * @param target - 判定するパス。
 * @param cache - ディレクトリごとの判定結果。省略時は再利用しない。
 * @param depth - たどったリンクの数。
 * @returns ネットワークパス、またはそこへ解決されるリンクの場合にtrue。POSIXでは常にfalse。
 *   存在しないパスや読めないリンクはfalseを返し、後続のファイル操作のエラーへ委ねる。
 */
async function reachesNetworkPath(target: string, cache?: Map<string, Promise<boolean>>, depth = 0): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    if (isNetworkPath(target)) return true;
    if (depth >= MAX_LINK_DEPTH) return false;
    const parent = path.dirname(target);
    if (parent === target) return false;
    if (await (depth === 0 ? directoryReachesNetwork(parent, cache) : reachesNetworkPath(parent, cache, depth))) return true;
    try {
        if (!(await fs.lstat(target)).isSymbolicLink()) return false;
        return await reachesNetworkPath(path.resolve(parent, await fs.readlink(target)), cache, depth + 1);
    } catch {
        return false;
    }
}

/**
 * ディレクトリがネットワークへ到達するかを、判定結果を再利用して返す。
 * 同じディレクトリの画像が多い文書で、画像ごとに`lstat`しないようにするための入口。
 * @param directory - 判定するディレクトリ。
 * @param cache - ディレクトリごとの判定結果。省略時は再利用しない。
 * @returns ネットワークへ到達する場合にtrue。
 */
function directoryReachesNetwork(directory: string, cache?: Map<string, Promise<boolean>>): Promise<boolean> {
    const cached = cache?.get(directory);
    if (cached) return cached;
    const result = reachesNetworkPath(directory, cache);
    cache?.set(directory, result);
    return result;
}

/**
 * ネットワークパスの接続先（`\\host\share`）を、比較できるよう小文字で取り出す。
 * @param networkPath - ネットワークパス。
 * @returns サーバー名と共有名。
 */
function networkShare(networkPath: string): string {
    return networkPath.replace(/\//g, '\\').split('\\').slice(2, 4).join('\\').toLowerCase();
}

/**
 * `path.relative`の結果が基準ディレクトリの外を指すかを判定する。
 * @param relative - `path.relative`の戻り値。
 * @returns 親への移動または別ドライブへの絶対パスの場合にtrue。`..foo`のような名前は内側として扱う。
 */
export function isRelativePathOutside(relative: string): boolean {
    return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
}

/**
 * 実体パスがルートディレクトリの内側にあるかを判定する。シンボリックリンクを解決してから比較する。
 * ルートと異なる共有を指すネットワークパスは、接続を起こさないよう実体を解決する前に外側と判定する。
 * ルート自体がネットワーク上にある場合は、同じ共有だけ解決を許可する。
 * @param root - 許可するルートディレクトリ。
 * @param target - 判定するファイルパス。
 * @param cache - ディレクトリごとのネットワーク到達の判定結果。省略時は再利用しない。
 * @returns ルート内にある場合にtrue。
 * @throws どちらかのパスが存在しない場合はファイルシステムのエラーを伝播する。
 */
export async function isPathInsideRoot(root: string, target: string, cache?: Map<string, Promise<boolean>>): Promise<boolean> {
    if (isNetworkPath(root) && isNetworkPath(target)) {
        if (networkShare(root) !== networkShare(target)) return false;
    } else if (await reachesNetworkPath(target, cache)) {
        return false;
    }
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    return !isRelativePathOutside(path.relative(realRoot, realTarget));
}

/**
 * 画像としてのローカルファイル参照を埋め込んでよいかを、内容を読み込む前に判定する。
 * @param filePath - 解決済みのローカルファイルパス。
 * @param policy - 読み込み方針。
 * @returns 埋め込めない理由（警告文の述語）。埋め込める場合はundefined。読み取れないファイルも理由として返す。
 */
export async function localImageRejection(filePath: string, policy: LocalImagePolicy): Promise<string | undefined> {
    try {
        if (policy.restrictRoot && !await isPathInsideRoot(policy.restrictRoot, filePath, policy.networkDirectoryCache)) {
            return 'was not embedded because it is outside the workspace root.';
        }
        return await isImageFile(filePath) ? undefined : 'was not embedded because it is not a supported image type.';
    } catch {
        return 'could not be read.';
    }
}

/**
 * 相対参照のまま出力する画像が存在しないことを警告する。内容は読まない。
 * 文書を開くだけで外部ホストへ接続しないようネットワークパスは確認せず、
 * 読み込み範囲の制限時はルートの外のファイルの有無を警告から推測できないよう確認しない。
 * @param filePath - 解決済みのローカルファイルパス。
 * @param source - 文書に書かれていた参照文字列。
 * @param policy - 読み込み方針と通知先。
 */
export async function warnIfLocalImageMissing(filePath: string, source: string, policy: LocalImagePolicy): Promise<void> {
    // 一覧を読む前に親ディレクトリのネットワーク到達を確認する。通常ファイルならリンクでもないので確認はここで終わる。
    // ファイル自体がネットワークを指すリンクの場合、fs.accessはWindowsではリンク先をたどらないため接続しない。
    if (await directoryReachesNetwork(path.dirname(filePath), policy.networkDirectoryCache)) return;
    if (!policy.restrictRoot && policy.directoryListingCache
        && await isListedRegularFile(filePath, policy.directoryListingCache)) return;
    try {
        if (policy.restrictRoot && !await isPathInsideRoot(policy.restrictRoot, filePath, policy.networkDirectoryCache)) return;
        await fs.access(filePath);
    } catch {
        warnLocalFile(policy, source, 'could not be read.');
    }
}

/**
 * ローカルファイルの問題を警告として通知する。
 * JSON.stringifyで引用するのは、文書由来の制御文字が端末の表示を乱さないようにするため。
 * @param policy - 通知先を持つ読み込み方針。
 * @param source - 文書に書かれていた参照文字列。
 * @param reason - `localImageRejection`が返す警告文の述語。
 */
export function warnLocalFile(policy: LocalImagePolicy, source: string, reason: string): void {
    (policy.onWarning ?? console.warn)(`Local file ${JSON.stringify(source)} ${reason}`);
}
