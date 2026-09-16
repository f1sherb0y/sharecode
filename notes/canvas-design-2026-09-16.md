# Canvas design and local verification

## Component decision

- **Excalidraw 0.18.1 (MIT)**: chosen. Ready-made React whiteboard, freehand, shapes, text, arrows/bindings, grouping, layers, images, undo/redo, import/export, touch support and Chinese/English. React 19 is included in its peer range. Custom collaboration integrates with our existing Yjs pipeline.
- **tldraw 4.5.6**: repository had unused scaffolding, but current SDK requires a production license key. The old hook sent entire growing strokes, and its sampling patch did not cover pens. It remains unused; no legacy documents are deleted or silently converted.
- **Plait (MIT)**: flexible plugin framework, useful for mind maps/diagrams, but requires building more product UI/integration than Excalidraw. It is not a drop-in equivalent for this request.

Sources: [Excalidraw integration](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/integration), [MIT license](https://github.com/excalidraw/excalidraw/blob/master/LICENSE), [tldraw production licensing](https://tldraw.dev/sdk-features/license-key), [Plait](https://github.com/worktile/plait).

Excalidraw is feature-complete, not tiny. Canvas is lazy loaded separately from the code view; fonts are served locally, split by font/unicode range and fetched as needed. No external collaboration service. Existing Yjs persistence, IndexedDB recovery, permissions and durable save acknowledgement apply to Canvas too.

## Synchronization and history

- Code/rich text and Canvas are separate types in the same room Y.Doc. Switching view does not change room language or erase the code.
- `canvas-elements`: one atomic metadata record per element (including tombstones), rather than full-scene snapshots. Stable fractional indexes retain layer order.
- `canvas-paths`: append-only Y.Array point generations. Metadata references generation + visible point count. Concurrent transforms use separate generations, preventing mixed/invalid paths.
- Shape changes coalesce for 100 ms **before** the Yjs transaction, network, local recovery journal and SQL history. Terminal pointer-up, visibility change, mode switch and leaving the room flush accepted edits. These terminal flushes are intentional exceptions to the regular 10 Hz cadence.
- During an active freehand stroke, each batch samples at most six new points (about 60 points/second), keeping the first/last sampled endpoints and corresponding pressure. High polling rates do not multiply transmitted samples. Imported completed strokes are capped at 2,048 points. This is lossy sampling: small high-speed details may change. Local drawing remains smooth while remote/replay use the sampled path; the user should validate fidelity with their mouse/pen.
- `canvas-files`: image payloads stored once. Current inline transport budget caps encoded data at 350,000 characters per image / 1,000,000 total per room. Oversize imports produce a visible error and must be undone/removed before saving. Removed images remain available for undo/history. Dedicated blob storage is preferable if larger image-heavy boards are needed.
- `canvas-settings`: background color is shared and replayed. Tool selection, selected elements, theme, local camera and open panels are not document history.
- Awareness sends cursor + viewport at most 10 Hz and stores neither in SQL. Recordings capture drawings, not every raw pointer event or cursor movement.
- Forward playback applies only newly reached Yjs updates. Backward seeks rebuild once. The shared document supplies code, Markdown and Canvas at the same timestamp. Canvas replay fits the recorded drawing; it does not replay ephemeral live cameras.

## Follow

Follow selects the exact browser client, rather than an arbitrary tab belonging to the same user. It switches between Editor and Canvas with the presenter. Canvas world viewport is `(-scrollX, -scrollY, CSS width/zoom, CSS height/zoom)`.

For follower dimensions `(W,H)` and presenter rectangle `(x,y,w,h)`:

```
z = min(W/w, H/h)
scrollX = W/(2z) - x - w/2
scrollY = H/(2z) - y - h/2
```

This exactly contains the presenter view, centers it, and leaves letterboxing along only one axis. CSS pixels make the calculation independent of physical DPI. It recomputes on follower resize. Followers advertise the original presenter rectangle to avoid recursive zoom-out when following a follower.

## UI

Compact Editor/Canvas switch uses existing app buttons. Canvas chrome maps to app theme tokens: neutral selected states, thin borders, shared radii/font and control heights, minimal shadow and spacing. Touch controls retain 44px targets. Overrides are scoped to Canvas; palette/drawing colors are not replaced by UI colors. Theme changes and view changes retain the document.

## Verification and manual checklist

- `just test-canvas`: concurrent documents/conflicts, deletion/undo, duplicate and out-of-order delivery, rate/size bounds, pressure samples, file limits, code isolation, replay seek, aspect-ratio geometry.
- `just test-canvas-integration`: disposable local PostgreSQL/API, real WebSocket synchronization and persistence acknowledgement, read-only enforcement, reconnect, ended-room compressed replay, browser mount/view-switch checks. No drawing gestures are simulated.
- Frontend production build + locale checks; admin integration covers tabs, bounded queries, filters, pagination and current-page-only statistics in Chromium/Firefox/WebKit.

User checks: open one room in two browsers, draw/erase/move shapes and text, undo/redo, try a fast mouse/pen stroke and small image, follow between differently shaped windows, resize/rotate, switch Editor/Canvas, wait for Saved, end room and scrub Canvas playback. Please judge smoothness and sampled-stroke fidelity; those are deliberately left to the user.

Not deployed. User explicitly requires permission before deployment.

## Completed local checks

- Canvas protocol: 7 tests / 56 assertions passed.
- Rust: 16 unit tests passed.
- Admin integration: server filters/pages/auth and three browser engines passed.
- Canvas integration: live two-client data, read-only rejection, saved acknowledgement, reconnect, room-end playback and Chromium/Firefox/WebKit mount/theme checks passed; WebKit also used a touch viewport at 3x DPI.
- Existing workspace UI regression: 10/10 passed (including Markdown, i18n, mobile/DPI and Monaco Find close). Locale checks: 3/3 passed.
- Production frontend build passed. Vite still warns about large vendor chunks; Canvas is lazy loaded but is not a micro-library.
- Local development restarted at http://localhost:5173 with the new API/index migration; existing local database retained. Nothing was deployed.
