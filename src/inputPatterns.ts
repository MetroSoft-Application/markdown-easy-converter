/**
 * @fileoverview CLI（Node.js側）で、コマンドラインの入力指定をファイル一覧へ展開する。
 * シェルがワイルドカードを展開しないWindowsでも同じ指定で動くよう、CLI自身で`*`、`?`、`**`を解釈する。
 * 副作用はディレクトリの読み取りだけ。不変条件: 既存のファイル名は、記号を含んでいても常にそのまま扱う。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isRelativePathOutside } from './localFiles';

/** 入力指定の展開結果。 */
export interface ExpandedInputs {
    /** 変換するファイルの絶対パス。重複を除き、指定順を保つ。 */
    files: string[];
    /**
     * 各指定の基準ディレクトリ。ワイルドカードより前の部分、またはファイルの親ディレクトリ。
     * 一致したファイルが増減しても`--out-dir`内の階層が変わらないよう、これを基に相対位置を決める。
     */
    bases: string[];
}

/** ワイルドカードを含む指定かを判定する。`[`や`{`は通常のファイル名の互換性を保つため解釈しない。 */
const GLOB_CHARACTER = /[*?]/;

/** ワイルドカードの展開で採用する文書の拡張子。画像など文書以外のファイルを変換対象にしないため。 */
const DOCUMENT_EXTENSION = /\.(?:md|markdown|textile)$/i;

/**
 * 1区間のワイルドカードを正規表現へ変換する。
 * @param segment - パス区切りを含まないパターン。
 * @returns 区間全体に一致する正規表現。大文字小文字の区別はOSのファイルシステムの慣例に合わせる。
 */
function segmentToRegExp(segment: string): RegExp {
    const source = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
}

/**
 * ワイルドカードで自動的にたどらないディレクトリかを判定する。
 * 依存パッケージや`.git`内の文書を誤って大量に変換しないため。
 * @param name - ディレクトリ名。
 * @returns `node_modules`または`.`で始まる名前の場合にtrue。
 */
function isSkippedDirectory(name: string): boolean {
    return name === 'node_modules' || name.startsWith('.');
}

/**
 * ディレクトリを走査し、残りのパターン区間に一致する文書を集める。
 * ディレクトリへのシンボリックリンクは循環を避けるためたどらない。読めないディレクトリは一致なしとして扱う。
 * @param directory - 走査するディレクトリ。
 * @param segments - パス区切りで分割したパターン。
 * @param index - 現在照合する区間の位置。
 * @param matches - 一致したファイルの絶対パスを追加する集合。`**`の重複訪問は集合で吸収する。
 */
async function collectMatches(
    directory: string, segments: readonly string[], index: number, matches: Set<string>
): Promise<void> {
    const segment = segments[index];
    if (segment === '**' && index < segments.length - 1) await collectMatches(directory, segments, index + 1, matches);
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const expression = segment === '**' ? undefined : segmentToRegExp(segment);
    // `*`は隠しファイルに一致させない。パターン自身が`.`で始まる場合だけ対象にする。
    // ただし`.h*`のようにワイルドカードを含む区間は、隠しディレクトリの中へは入らない。
    const includeHidden = segment.startsWith('.');
    for (const entry of entries) {
        const target = path.join(directory, entry.name);
        if (!includeHidden && entry.name.startsWith('.')) continue;
        if (segment === '**') {
            if (entry.isDirectory() && !isSkippedDirectory(entry.name)) await collectMatches(target, segments, index, matches);
            if (index === segments.length - 1 && await isFile(entry, target)) matches.add(target);
            continue;
        }
        if (!expression?.test(entry.name)) continue;
        if (index === segments.length - 1) {
            if (await isFile(entry, target)) matches.add(target);
        } else if (entry.isDirectory() && (!GLOB_CHARACTER.test(segment) || !isSkippedDirectory(entry.name))) {
            // `node_modules`と明示した場合だけ入る。`*`で依存パッケージの文書を変換しないため。
            await collectMatches(target, segments, index + 1, matches);
        }
    }
}

/**
 * ディレクトリ項目がファイル（ファイルへのシンボリックリンクを含む）かを判定する。
 * @param entry - ディレクトリ項目。
 * @param target - 項目の絶対パス。
 * @returns ファイルの場合にtrue。リンク先がない場合はfalse。
 */
async function isFile(entry: { isFile(): boolean; isSymbolicLink(): boolean }, target: string): Promise<boolean> {
    if (entry.isFile()) return true;
    if (!entry.isSymbolicLink()) return false;
    return fs.stat(target).then((stat) => stat.isFile(), () => false);
}

/**
 * ワイルドカードを含む1つの指定を、文書ファイルの一覧へ展開する。
 * @param pattern - ワイルドカードを含む指定。
 * @param cwd - 相対指定の基準ディレクトリ。
 * @returns 辞書順に並べた絶対パス（出力順を環境によらず一定にする）と、ワイルドカードより前のディレクトリ。
 */
async function expandPattern(pattern: string, cwd: string): Promise<{ files: string[]; base: string }> {
    const normalized = process.platform === 'win32' ? pattern.replace(/\\/g, '/') : pattern;
    const absolute = path.resolve(cwd, normalized);
    const { root } = path.parse(absolute);
    const segments = absolute.slice(root.length).split(path.sep);
    const firstWildcard = segments.findIndex((segment) => GLOB_CHARACTER.test(segment));
    const base = path.join(root, ...segments.slice(0, firstWildcard));
    const matches = new Set<string>();
    await collectMatches(base, segments.slice(firstWildcard), 0, matches);
    return { files: [...matches].filter((file) => DOCUMENT_EXTENSION.test(file)).sort(), base };
}

/**
 * 入力指定の一覧を、変換するファイルの絶対パス一覧へ展開する。
 * ワイルドカードを含まない指定と、その名前のファイルが実在する指定は、パターンとして解釈せずそのまま返す。
 * 存在しないファイルの扱いは、単一入力と同じく変換時のエラーへ委ねるため。
 * @param patterns - コマンドラインの入力指定。
 * @param cwd - 相対指定の基準ディレクトリ。
 * @returns 変換するファイルと、各指定の基準ディレクトリ。
 * @throws ワイルドカードの指定に一致する文書が1つもない場合。
 */
export async function expandInputPatterns(patterns: readonly string[], cwd: string): Promise<ExpandedInputs> {
    const files = new Set<string>();
    const bases: string[] = [];
    for (const pattern of patterns) {
        const absolute = path.resolve(cwd, pattern);
        const literal = !GLOB_CHARACTER.test(pattern)
            || await fs.stat(absolute).then((stat) => stat.isFile(), () => false);
        if (literal) {
            files.add(absolute);
            bases.push(path.dirname(absolute));
            continue;
        }
        const expanded = await expandPattern(pattern, cwd);
        if (!expanded.files.length) throw new Error(`No documents matched: ${pattern}`);
        for (const match of expanded.files) files.add(match);
        bases.push(expanded.base);
    }
    return { files: [...files], bases };
}

/**
 * ディレクトリ一覧の共通の祖先を求める。
 * @param directories - 絶対パスのディレクトリ一覧。1件以上。
 * @returns すべてを含む最も深いディレクトリ。
 * @throws 共通の祖先がない場合（Windowsで別ドライブにある場合）。先頭の`Invalid`により終了コード2になる。
 */
export function commonDirectory(directories: readonly string[]): string {
    let common = directories[0];
    for (const directory of directories) {
        while (isRelativePathOutside(path.relative(common, directory))) {
            const parent = path.dirname(common);
            if (parent === common) throw new Error('Invalid --out-dir: inputs do not share a common directory.');
            common = parent;
        }
    }
    return common;
}

/**
 * `--out-dir`指定時の出力パスを、基準ディレクトリからの相対位置を保って決める。
 * @param base - `commonDirectory`で求めた基準ディレクトリ。
 * @param input - 出力先を求める入力。
 * @param outDir - 出力ディレクトリの絶対パス。
 * @param extension - 先頭の`.`を含む出力拡張子。
 * @returns 出力パス。
 */
export function outputPathInDirectory(base: string, input: string, outDir: string, extension: string): string {
    const relative = path.relative(base, input);
    return path.join(outDir, relative.slice(0, relative.length - path.extname(relative).length) + extension);
}
