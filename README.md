# Markdown Easy Convert

`mve-convert` is a command-line tool that converts Markdown and Textile documents to HTML or PDF. The input document is never modified.

- Headings, lists, task lists, tables, footnotes, and a `[toc]` table of contents
- Syntax-highlighted code blocks
- Math with KaTeX (`$...$` and `$$...$$`)
- Mermaid diagrams rendered to SVG
- Marp slide decks (PDF output only; HTML output renders the slide source as a regular document)
- HTML with an optional heading outline sidebar, embedded images, and recursive conversion of linked documents
- PDF paper sizes `A0`–`A6`, `B4`, and `B5`, with configurable margins, fonts, headers, and footers

## Requirements

- Node.js 22, 24, or 26
- Microsoft Edge, Google Chrome, or another Chromium-based browser

The browser is not installed with the package. By default, `mve-convert` looks for Edge and then Chrome. Use `--browser` to choose another executable.

## Install

```sh
npm install --global @metrosoft/markdown-easy-convert
mve-convert --help
```

## Quick start

```sh
# Writes document.html next to document.md
mve-convert document.md --format html

# Writes document.pdf next to document.md
mve-convert document.md --format pdf

# Chooses the output path and overwrites an existing file
mve-convert document.md --format pdf -o out/document.pdf --force
```

## Example

HTML output of [examples/sample.md](examples/sample.md) with the heading outline:

![HTML output of the sample document](examples/images/sample-html.png)

PDF output:

![PDF output of the sample document](examples/images/sample-pdf.png)

## Options

| Option | Description | Default |
| --- | --- | --- |
| `--format html\|pdf` | Output format. Required. | — |
| `-o, --output PATH` | Output file path. Missing directories are created. | Input path with `.html` or `.pdf` |
| `--config PATH` | JSON configuration file. See [Configuration file](#configuration-file). | — |
| `--force` | Overwrite existing output files. | Off |
| `--browser PATH` | Browser executable used for rendering. | Edge, then Chrome |
| `--language CODE` | Language of generated labels (outline, table of contents, copy button) and the HTML `lang` attribute: `ja`, `en`, `zh-cn`, `ko`, `fr`, `de`, or `es`. Document text is not translated. | `en` |
| `--theme light\|dark` | Heading color. `light` uses a brighter blue, `dark` a deeper blue. | `dark` |
| `--mermaid-theme NAME` | Mermaid theme: `auto`, `default`, `dark`, or `neutral`. | `auto` |
| `--workspace-root PATH` | Base directory for links that start with `/`. | Input directory |
| `--html-embed-images` | Embed local images in the HTML file. | Off |
| `--html-no-embed-images` | Keep relative image paths in the HTML file. | On |
| `--html-outline` | Add a heading outline sidebar to the HTML file. | Off |
| `--html-linked` | Also convert linked Markdown and Textile documents. | Off |
| `-h, --help` | Show usage. | — |
| `--version` | Show the package version. | — |

Options that start with `--html-` apply only to HTML output; combining them with `--format pdf` is an error. Command-line options take precedence over the configuration file.

### Converting linked documents

With `--html-linked`, `mve-convert` follows links to other Markdown and Textile documents and converts each one to HTML:

- Linked documents are written to the same relative location in the output directory. Documents outside the input directory are written under `_linked/`.
- If any output file already exists, the conversion fails unless `--force` is set. With `--force`, all outputs can be overwritten.
- Two different source documents cannot share one output path, even with `--force`.

## Configuration file

Pass a JSON file with `--config`. All keys are optional, and unknown keys or invalid values are reported as errors. Relative `browserPath` and `workspaceRoot` values are resolved from the configuration file's directory.

```json
{
  "rendering": {
    "remoteImagesEnabled": false
  },
  "html": {
    "embedImages": true,
    "showOutlineSidebar": true
  },
  "pdf": {
    "format": "A4",
    "orientation": "portrait",
    "margins": { "top": 15, "right": 15, "bottom": 15, "left": 15 },
    "header": "Project report",
    "footer": "{page}/{pages}"
  }
}
```

```sh
mve-convert document.md --format pdf --config export.json
```

### Top level

| Key | Description |
| --- | --- |
| `browserPath` | Same as `--browser`. |
| `workspaceRoot` | Same as `--workspace-root`. |

### `rendering`

| Key | Values | Default |
| --- | --- | --- |
| `renderFormat` | `auto`, `markdown`, `mixed`, or `textile`. `auto` treats `.textile` files as Textile and other files as Markdown with Textile syntax allowed (`mixed`). | `auto` |
| `remoteImagesEnabled` | `false` hides remote images written with Markdown or Textile image syntax. It does not block other network requests. | `true` |
| `language` | Same as `--language`. | `en` |
| `editorTheme` | Same as `--theme`. | `dark` |
| `mermaidTheme` | Same as `--mermaid-theme`. | `auto` |
| `mermaidFontSize` | Mermaid diagram font size, 8–48. | Mermaid default |
| `previewFontFamily` | CSS font stack for HTML text and Mermaid diagrams. | Noto Sans JP stack |

### `html`

| Key | Description | Default |
| --- | --- | --- |
| `embedImages` | Same as `--html-embed-images`. | `false` |
| `showOutlineSidebar` | Same as `--html-outline`. | `false` |
| `convertLinkedMarkdown` | Same as `--html-linked`. | `false` |

### `pdf`

Out-of-range numbers are clamped to the listed range.

| Key | Description | Default |
| --- | --- | --- |
| `format` | `A0`, `A1`, `A2`, `A3`, `A4`, `A5`, `A6`, `B4`, or `B5`. | `A4` |
| `orientation` | `portrait` or `landscape`. | `portrait` |
| `margins` | `top`, `right`, `bottom`, and `left` in millimeters, 0–50, rounded to whole millimeters. | 15 each |
| `header` | Text at the top of each page. `{page}` and `{pages}` are replaced with the page number and the page count. | Empty |
| `footer` | Text at the bottom of each page, with the same placeholders. | `{page}/{pages}` |
| `fontFamily` | CSS font stack for body text. | Noto Sans JP stack |
| `bodyFontSize` | Body text size in points, 6–48. | `11` |
| `headingFontSizes` | `h1`–`h6` sizes in points, 6–72. | 24, 20, 16, 14, 12, 11 |
| `codeFontSize` | Code size in points, 6–36. | `9` |
| `lineHeight` | Line height multiplier, 0.8–3. | `1.6` |
| `paragraphSpacing` | Space after paragraphs in points, 0–48. | `6` |
| `textReplacements` | Array of `{ "pattern": "...", "replacement": "..." }`. Each `pattern` is a regular expression applied to every match in the output text. `replacement` is inserted literally. Also applies to HTML output. | `[]` |

## Troubleshooting

**No browser is found or it fails to start.** The error message lists the reason reported for Edge and for Chrome. If neither is installed, install one of them or pass the path of a Chromium-based browser:

```sh
# Windows
mve-convert document.md --format pdf --browser "C:\Program Files\Google\Chrome\Application\chrome.exe"
# macOS
mve-convert document.md --format pdf --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# Linux
mve-convert document.md --format pdf --browser /usr/bin/chromium
```

On Linux, an installed browser can also fail to start because of missing system libraries. See the [Playwright browser requirements](https://playwright.dev/docs/browsers).

## License

[MIT](LICENSE.md). License texts of bundled third-party packages are included in `dist/third-party-licenses/`.
