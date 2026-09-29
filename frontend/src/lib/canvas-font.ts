import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'

export const CANVAS_FONT = 3 as const // Reuse Excalidraw's legacy ID; the build adapter supplies Sarasa Mono.
export function monoCanvasElements(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  return elements.map(element => element.type === 'text' && (element.fontFamily !== CANVAS_FONT || element.lineHeight !== 1.25)
    ? { ...element, fontFamily: CANVAS_FONT, lineHeight: 1.25 as typeof element.lineHeight }
    : element)
}
