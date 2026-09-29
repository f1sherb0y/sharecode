# Remaining frontend bundle and CJK font choices — 2026-09-17

Current `frontend/dist`: 282 files, 14,087,284 bytes (13.43 MiB), approximately 4.10 MiB with gzip level 6 for text resources. No font files remain in dist; CDN font transfer is additional.

Rebuilt the current code with `ANALYZE=true bun run build --outDir /tmp/sharecode-optimized-analysis-20260917 --manifest`. Interactive report: `/tmp/sharecode-optimized-analysis-20260917/bundle-report.html`.

Chunks are grouped by their dominant module category using analyzer source attribution. Sizes are actual dist file bytes, not the sum of per-module gzip estimates. Shared dependencies follow their containing chunk, so these are feature-oriented estimates rather than exact individual package sizes. CSS is listed separately.

| Group | Raw MiB | gzip6 MiB |
|---|---:|---:|
| Monaco | 3.92 | 1.02 |
| Mermaid | 2.91 | 0.81 |
| Canvas | 2.10 | 0.71 |
| Canvas font WASM | 1.74 | 0.71 |
| Markdown | 0.73 | 0.22 |
| CSS | 0.66 | 0.16 |
| Other JS | 1.30 | 0.41 |
| Other | 0.01 | 0.00 |
| Other assets | 0.08 | 0.06 |

Monaco loads when code editing/playback initializes, with additional language/worker loading as needed. Canvas loads on entering Canvas; its locale files are selected at runtime. Mermaid loads for diagrams, with further lazy diagram/layout chunks. Markdown and KaTeX load for Markdown. Excalidraw font-subsetting HarfBuzz WASM is embedded in a JS chunk and is used by font embedding/export workflows: moving font files to CDN does not remove this processing code. Not all these chunks download during a single visit.

Largest individual chunks:

- `assets/chunk-EIO257PC-Dld5oW4Q.js`: 1778.4 KiB raw, 724.0 KiB gzip (Canvas font WASM).
- `assets/editor.api2-BCOr1AFn.js`: 1587.6 KiB raw, 395.0 KiB gzip (Monaco).
- `assets/toggleHighContrast-diEuXWK_.js`: 993.3 KiB raw, 250.7 KiB gzip (Monaco).
- `assets/findInput-PUoI4vDH.js`: 942.6 KiB raw, 256.8 KiB gzip (Monaco).
- `assets/chunk-KEIR6QF5-BK4PEzdO.js`: 651.9 KiB raw, 141.6 KiB gzip (Mermaid).
- `assets/canvas-view-D8H75ft4.js`: 556.1 KiB raw, 166.6 KiB gzip (Canvas).
- `assets/cytoscape.esm-DmxrTSE2.js`: 426.0 KiB raw, 133.4 KiB gzip (Mermaid).
- `assets/chunk-K2UTITRG-EcRvZ99d.js`: 414.0 KiB raw, 132.5 KiB gzip (Canvas).
- `assets/tables-CzLKoAjF.js`: 395.0 KiB raw, 119.9 KiB gzip (Markdown).
- `assets/editor-CCyqTTZR.css`: 301.3 KiB raw, 99.8 KiB gzip (CSS).
- `assets/editor.worker-DWlYVeeX.js`: 273.4 KiB raw, 83.6 KiB gzip (Monaco).
- `assets/index-5wRy-HXi.js`: 271.6 KiB raw, 84.0 KiB gzip (Other JS).

## CJK font recommendation

Recommend the Sarasa Mono family (更纱等宽), regular weight, WOFF2 unicode-range subsets over pinned CDN URLs, with monospace fallback. Official source: https://github.com/be5invis/Sarasa-Gothic . This is a CJK coding font family based on Iosevka and Source Han Sans; SC/TC/J/K/CL variants differ in regional glyph forms. Prefer SC for this Chinese-first application. A third-party CL webfont package was measured as an available reference, not installed or endorsed as a complete production solution.

Compared these published CDN packages on 2026-09-17:

- Sarasa: https://cdn.jsdelivr.net/npm/sarasa-mono-web@0.1.0/fonts/SarasaMonoCL-Regular/SarasaMonoCL-Regular.css
- Maple: https://cdn.jsdelivr.net/npm/@mogeko/maple-mono-cn@7.9.0/dist/font/result.css
- Maple upstream: https://font.subf.dev/en/download/

| Measured item | Sarasa Mono CL package | Maple Mono CN package |
|---|---:|---:|
| Full published WOFF2 set | 2.17 MiB / 97 files | 8.87 MiB / 239 files |
| CSS gzip6 | 29.3 KiB | 51.7 KiB |
| ASCII example font subsets | 49.4 KiB / 2 files | 38.6 KiB / 2 files |
| Chinese + ASCII example subsets | 152.7 KiB / 6 files | 286.2 KiB / 13 files |
| Japanese + Korean example coverage | All sample characters declared | Korean sample absent |

Example strings:

- ASCII: `const x = 123; // Hello world`
- Chinese: `const x = 123; // 你好，世界！这是代码编辑器，支持中文。`
- Mixed: `const x = 123; // 中文 日本語 こんにちは 한국어`

Method: intersect each package CSS unicode-range with sample code points, sum the matching WOFF2 file sizes from jsDelivr's package API, and gzip CSS at level 6. These are estimated cold-load resource bytes from published declarations, not browser network measurements. CSS is additional to sample font totals. Full package sizes are not directly comparable coverage guarantees; sample matching does not prove complete CJK coverage or rare-character availability.

CJK fonts cannot offer both exhaustive coverage and a tiny full download. Subsetting limits per-document traffic and browser caching avoids repeat downloads. A system monospace fallback is the zero-download option but varies across devices. Browser font requests must be driven by actual text; do not preload the entire CJK font set. Canvas font loading, text metrics, SVG font embedding and session-export replay need explicit integration checks when replacing Cascadia. No font replacement or deployment was performed in this analysis.
