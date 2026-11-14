/**
 * @fileoverview DOCX（OOXMLパッケージ）用の最小限のZIP書き出し。実行境界: Node（CLI）。
 * 依存パッケージを増やさないよう、圧縮はNode標準のzlib（deflate raw）だけを使う。
 * 同じ入力から同じバイト列を出すため、各エントリーの更新日時はZIPで表せる最小値（1980-01-01 00:00）に固定する。
 * ZIP64は扱わないため、エントリー数65535件・各サイズ4GiBを超える場合は例外を投げる。
 */
import { deflateRawSync } from 'node:zlib';

/** パッケージへ書き込む1ファイル。 */
export interface ZipEntry {
    /** パッケージ内のパス（`/`区切り、先頭に`/`を付けない）。 */
    name: string;
    /** 内容。文字列はUTF-8で書き込む。 */
    data: string | Uint8Array;
}

/** CRC-32（IEEE 802.3）の表。初回の計算時に作る。 */
let crcTable: Uint32Array | undefined;

/**
 * CRC-32を計算する。Node 22.0/22.1にはzlib.crc32がないため自前で計算する。
 * @param data - 対象のバイト列。
 * @returns 符号なし32ビットのCRC。
 */
function crc32(data: Uint8Array): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let index = 0; index < 256; index += 1) {
            let value = index;
            for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
            crcTable[index] = value >>> 0;
        }
    }
    let crc = 0xFFFFFFFF;
    for (let index = 0; index < data.length; index += 1) crc = crcTable[(crc ^ data[index]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** ZIPの日付欄で表せる最小の日付（1980-01-01）。 */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
/** ZIPの時刻欄の00:00:00。 */
const DOS_TIME = 0;
/** ZIP64を使わずに表せる上限。 */
const ZIP32_LIMIT = 0xFFFFFFFF;

/**
 * エントリーを順にZIPへまとめる。既に圧縮済みの画像（PNG・JPEG・GIF）は無圧縮で格納し、時間を節約する。
 * @param entries - 書き込むファイル。OOXMLでは`[Content_Types].xml`を先頭に置く。
 * @returns ZIPのバイト列。
 * @throws Error - 同名のエントリーがある場合、またはZIP64が必要な大きさの場合。
 */
export function createZip(entries: readonly ZipEntry[]): Buffer {
    if (entries.length > 0xFFFF) throw new Error('DOCX package has too many parts.');
    const names = new Set<string>();
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        if (names.has(entry.name)) throw new Error(`Duplicate DOCX package part: ${entry.name}`);
        names.add(entry.name);
        const name = Buffer.from(entry.name, 'utf8');
        const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
        const store = /\.(?:png|jpe?g|gif)$/i.test(entry.name);
        const body = store ? raw : deflateRawSync(raw);
        if (raw.length > ZIP32_LIMIT || body.length > ZIP32_LIMIT || offset > ZIP32_LIMIT) {
            throw new Error('DOCX package is too large.');
        }
        const crc = crc32(raw);
        const method = store ? 0 : 8;
        // ビット11: ファイル名がUTF-8であることを示す。
        const flags = 0x0800;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034B50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014B50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, name, body);
        centrals.push(central, name);
        offset += local.length + name.length + body.length;
    }
    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    if (offset > ZIP32_LIMIT || centralSize > ZIP32_LIMIT) throw new Error('DOCX package is too large.');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054B50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}
