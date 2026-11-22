# Changelog

## 0.1.0

- Initial release.

## 0.1.1

- Mermaid diagrams that fail to render no longer abort the export.

## 0.1.2

- Markdown and configuration files with a UTF-8 BOM are now read correctly.

## 0.1.3

- Adds batch conversion, stdin/stdout, custom CSS, `--strict`, and `--json`.
- Fixes document titles, rendered front matter, and embedding of non-image files.

## 0.2.0

- Adds `--format docx` for editable Word documents with native equations.
- Fixes `--force` reruns wrongly refused on ReFS volumes.

## 0.3.0

- Adds `--watch` and `--format md|textile` to convert between Markdown and Textile.
- Adds `mve-convert.json` auto-detection and per-document PDF settings in front matter.
