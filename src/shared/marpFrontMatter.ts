/**
 * @fileoverview Markdown先頭のYAML front matterからMarp有効化を厳密に判定する。
 */
/**
 * YAML解析前にfront matterにMarpキー候補があるかを確認する。
 * @param markdown - 候補を確認するMarkdown本文。
 * @returns front matterがあり、YAML解析が必要な可能性がある場合にtrue。
 */
export function hasMarpFrontMatterCandidate(markdown: string): boolean {
  const yaml = getFrontMatter(markdown);
  return yaml !== undefined && (yaml.includes("marp") || yaml.includes("\\"));
}

/**
 * YAML front matter本文をMarp有効化として解析する関数の型。
 * @param yaml - front matterから取り出したYAML本文。
 * @returns ルート直下のmarpが真偽値trueの場合にtrue。
 */
export type MarpFrontMatterParser = (yaml: string) => boolean;

/**
 * 文書先頭のYAML front matterでMarpが真偽値として有効かを判定する。
 * @param markdown - 判定するMarkdown本文。
 * @param parseYamlFrontMatter - YAML本文を解析する関数。
 * @returns ルート直下のmarpがYAML真偽値trueの場合にtrue。
 */
export function isMarpMarkdown(
  markdown: string,
  parseYamlFrontMatter: MarpFrontMatterParser,
): boolean {
  const yaml = getFrontMatter(markdown);
  if (yaml === undefined) return false;

  try {
    return parseYamlFrontMatter(yaml);
  } catch {
    return false;
  }
}

/**
 * Marpが有効な文書から設定用front matterを除き、通常のMarkdown本文を返す。
 * @param markdown - front matterを含むMarkdown本文。
 * @param parseYamlFrontMatter - YAML本文をMarp設定として検証する関数。
 * @returns Marpが有効ならfront matterを除いた本文、それ以外は元の文字列。
 */
export function stripMarpFrontMatter(
  markdown: string,
  parseYamlFrontMatter: MarpFrontMatterParser,
): string {
  const frontMatter = getFrontMatterRange(markdown);
  if (!frontMatter || !hasMarpFrontMatterCandidate(markdown)
    || !isMarpMarkdown(markdown, parseYamlFrontMatter)) {
    return markdown;
  }
  return frontMatter.prefix + frontMatter.source.slice(frontMatter.bodyStart);
}

/**
 * 文書先頭のfront matterを取り出す。
 * @param markdown - front matterを取り出すMarkdown本文。
 * @returns front matterのYAML本文。区切りがない場合はundefined。
 */
function getFrontMatter(markdown: string): string | undefined {
  return getFrontMatterRange(markdown)?.yaml;
}

/**
 * 文書先頭にあるYAML front matterの本文位置と後続Markdown本文を特定する。
 * @param markdown - front matterを探すMarkdown本文。
 * @returns YAML本文、元の本文、BOM、本文開始位置。区切りが不正ならundefined。
 */
function getFrontMatterRange(markdown: string): {
  prefix: string;
  source: string;
  yaml: string;
  bodyStart: number;
} | undefined {
  const prefix = markdown.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const source = prefix ? markdown.slice(1) : markdown;
  const opening = /^---[ \t]*\r?\n/.exec(source);
  if (!opening) return undefined;

  const contentStart = opening[0].length;
  const closingPattern = /^(?:---|\.\.\.)[ \t]*\r?$/gm;
  closingPattern.lastIndex = contentStart;
  const closing = closingPattern.exec(source);
  if (!closing) return undefined;
  let bodyStart = closing.index + closing[0].length;
  if (source.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (source[bodyStart] === "\n") bodyStart += 1;
  return {
    prefix,
    source,
    yaml: source.slice(contentStart, closing.index),
    bodyStart,
  };
}
