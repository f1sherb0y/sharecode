# Sarasa Mono integration — 2026-09-17

Implemented locally; not deployed or committed.

## Font and delivery

- Code, Markdown, Mermaid and Canvas use `"Sarasa Mono", monospace`.
- Font: Sarasa Mono CL Regular (font version 1.0.35), using the previously measured `sarasa-mono-web@0.1.0` package. CL denotes its classical orthography variant. CJK and Latin have a 2:1 cell-width ratio.
- Pinned font CDN: `https://cdn.jsdelivr.net/npm/sarasa-mono-web@0.1.0/fonts/SarasaMonoCL-Regular/`.
- 97 WOFF2 unicode-range subsets. No font binaries are packaged with the website. Website JavaScript remains self-hosted.
- Subset declarations are a lazy shared module. Only font resources required by displayed text download; repeated requests reuse browser HTTP caching. No full-font preload.
- Sample `Mi中文日本語한글` plus Canvas fixture text loaded 6 of the 97 registered faces in Chromium, Firefox and WebKit. Measured widths at 20px: Latin 10px, CJK 20px (within floating point tolerance). This is sample-specific, not a per-room download guarantee.
- Legacy font preferences migrate to Sarasa, preserving the user's font size.
- Monaco remeasures when any additional Sarasa subset finishes loading, including after the initial font wait expires. A blocked CDN leaves the editor usable with system monospace.

## Canvas and replay

- Preserve numeric Canvas family ID 3 for existing records; normalize display to Sarasa and 1.25 line height. Existing room histories are not bulk-rewritten.
- Extend the version-guarded Excalidraw adapter to register actual Sarasa subset FontFaces shared with other editors. Metrics use the font's unitsPerEm=1000, typoAscender=965, typoDescender=-285.
- Excalidraw SVG export embeds the required Sarasa glyph subsets. Font selection remains hidden.
- Vite dependency version query strings are removed before identifying vendor modules. Explicitly prebundle the excluded vendor's CommonJS helpers, so a clean development cache also opens Canvas.
- Standalone replay retains CDN dependencies. Its font stylesheet is fetched from the pinned CDN and rebased to absolute URLs; the 97-range manifest is not embedded in the downloaded HTML. The public Excalidraw family map exposes Sarasa for name lookup while preserving the legacy Cascadia ID for internal metadata. No browser font/drawing APIs are patched by application code.

## Validation

- TypeScript + production Vite build passed; `git diff --check` passed.
- `bun tests/bundle-loading.mjs`: Chromium / Firefox / WebKit passed actual production nginx/browser cache, lazy editor boundaries, no font download on login, CJK widths, single shared font registry, legacy Canvas and code/Markdown playback.
- Production screenshots inspected: `/tmp/sharecode-loading-BQb5aC/`.
- `tests/sarasa-font.mjs` (run with Node; supports individual ENGINE runs): Chromium / Firefox / WebKit passed the development adapter, SVG font embedding and blocked-CDN fallback. Firefox artifacts: `/tmp/sarasa-font-t4DHab/`; WebKit: `/tmp/sarasa-font-Uy40FX/`.
- Standalone export regression includes actual CJK Canvas text and verifies the Canvas drawing font, no old drawing-font downloads, local-file execution, timeline seek, Markdown/math/diagrams, image loading, CSP and metadata sanitization. Chromium, Firefox and WebKit passed. WebKit artifacts: `/tmp/session-export-KL5R5D/`.
- Drawing gestures remain for the user's manual testing.

## Build size

- Current dist: 284 files, 14,169,140 bytes = 13.51 MiB; gzip6 text / unchanged binary resources approximately 4.13 MiB.
- Font files in dist: zero. CDN font download is additional and text-dependent.
- Lazy font descriptor JS: about 79.8 kB raw / 31.9 kB gzip (Vite report).
- Login JS/CSS: about 196 KiB encoded; warm JS/CSS transfer remained zero in the production browser cache test.
- Standalone replay template: 63,781 bytes, excluding session data.

## Provenance and maintenance

Font upstream: https://github.com/be5invis/Sarasa-Gothic (SIL Open Font License).
Web subset distributor: https://github.com/HotoRas/sarasa-mono-web .
Only the CDN's URL/unicode-range metadata is vendored in `frontend/src/lib/sarasa-subsets.json`; font binaries are not redistributed here.
Regenerate the pinned metadata with `cd frontend && bun tooling/update-sarasa-subsets.ts` (requires network). The generator validates the expected 97 subsets and file names. Builds themselves do not fetch fonts.
Font or Excalidraw upgrades require rechecking CJK coverage, metrics, dynamic subset loading and both website and standalone export paths.
