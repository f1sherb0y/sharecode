// Runtime hooks for our patched tldraw (see patches/tldraw@4.5.6.patch).
// The patch reads these globals on each draw-tool tick, so setting them at
// any time takes effect on the next stroke without a rebuild.

declare global {
  // eslint-disable-next-line no-var
  var __TLDRAW_DRAW_SAMPLE_INTERVAL_MS: number | undefined
}

/** Minimum milliseconds between recorded points during freehand drawing with
 *  a mouse. 200 ms = 5 Hz. Pen/stylus input is unaffected. */
export function setDrawSampleIntervalMs(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`setDrawSampleIntervalMs: expected non-negative finite number, got ${ms}`)
  }
  globalThis.__TLDRAW_DRAW_SAMPLE_INTERVAL_MS = ms
}

export function getDrawSampleIntervalMs(): number {
  return globalThis.__TLDRAW_DRAW_SAMPLE_INTERVAL_MS ?? 200
}
