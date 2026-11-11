import type * as Monaco from 'monaco-editor'

/**
 * Publishes where the sticky scroll widget ends, as CSS variables on the editor:
 * `--sticky-scroll-height`, and `--sticky-scroll-margin-top`, the same edge inside the
 * gutter, which scrolls with the text. The desktop client (client.css) clips the code
 * under the widget with them, so the widget can be see-through like the rest of the editor.
 */
export function trackStickyScroll(editor: Monaco.editor.IStandaloneCodeEditor) {
  const node = editor.getDomNode()
  if (!node) return

  let widget: HTMLElement | null = null
  let frame = 0
  const update = () => {
    const height = widget?.offsetHeight ?? 0
    node.style.setProperty('--sticky-scroll-height', `${height}px`)
    node.style.setProperty('--sticky-scroll-margin-top', `${height + editor.getScrollTop()}px`)
  }
  const observer = new ResizeObserver(update)
  // Monaco adds the widget some time after the editor is created.
  const find = () => {
    widget = node.querySelector<HTMLElement>('.sticky-widget')
    if (!widget) return
    added.disconnect()
    observer.observe(widget)
  }
  const added = new MutationObserver(find)
  added.observe(node, { childList: true, subtree: true })
  find()
  // In a frame, so the gutter's edge stays in step with Monaco's own rendering.
  const scroll = editor.onDidScrollChange(() => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(update)
  })
  editor.onDidDispose(() => {
    added.disconnect()
    observer.disconnect()
    scroll.dispose()
    cancelAnimationFrame(frame)
  })
}
