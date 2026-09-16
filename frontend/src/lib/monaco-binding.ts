import * as Y from 'yjs'
import { normalizeLineEndings, normalizeCollaborativeText } from './line-endings'
import type { Awareness } from 'y-protocols/awareness'
import type * as Monaco from 'monaco-editor'

type MonacoInstance = typeof Monaco
type EditorInstance = Monaco.editor.IStandaloneCodeEditor
type MonacoModel = Monaco.editor.ITextModel

interface RelativeSelection {
  start: Y.RelativePosition
  end: Y.RelativePosition
  direction: Monaco.SelectionDirection
}

type CursorState = {
  anchor: Y.RelativePosition
  head: Y.RelativePosition
}

// Monaco uses LF offsets. Legacy CRLF is projected without mutating remote
// CRDT state (read-only clients must never send normalization updates).
export const toYTextOffset = (raw: string, offset: number): number => {
  let visible = 0
  let index = raw.startsWith('\ufeff') ? 1 : 0
  while (index < raw.length && visible < offset) {
    if (raw[index] === '\r' && raw[index + 1] === '\n') index++
    index++; visible++
  }
  return index
}
export const toModelOffset = (raw: string, offset: number) => normalizeLineEndings(raw.slice(0, offset)).replace(/^\ufeff/, '').length

const createMutex = () => {
  let locked = false
  return (cb: () => void) => {
    if (locked) return
    locked = true
    try {
      cb()
    } finally {
      locked = false
    }
  }
}

const createRelativeSelection = (
  editor: EditorInstance,
  model: MonacoModel,
  ytext: Y.Text,
): RelativeSelection | null => {
  const selection = editor.getSelection()
  if (!selection) return null

  const start = Y.createRelativePositionFromTypeIndex(
    ytext,
    toYTextOffset(ytext.toString(), model.getOffsetAt(selection.getStartPosition())),
  )
  const end = Y.createRelativePositionFromTypeIndex(
    ytext,
    toYTextOffset(ytext.toString(), model.getOffsetAt(selection.getEndPosition())),
  )

  return {
    start,
    end,
    direction: selection.getDirection(),
  }
}

const createMonacoSelectionFromRelative = (
  monacoInstance: MonacoInstance,
  editor: EditorInstance,
  ytext: Y.Text,
  rel: RelativeSelection,
  doc: Y.Doc,
) => {
  const start = Y.createAbsolutePositionFromRelativePosition(rel.start, doc)
  const end = Y.createAbsolutePositionFromRelativePosition(rel.end, doc)
  if (!start || !end || start.type !== ytext || end.type !== ytext) {
    return null
  }

  const model = editor.getModel()
  if (!model) return null

  const startPos = model.getPositionAt(toModelOffset(ytext.toString(), start.index))
  const endPos = model.getPositionAt(toModelOffset(ytext.toString(), end.index))
  return monacoInstance.Selection.createWithDirection(
    startPos.lineNumber,
    startPos.column,
    endPos.lineNumber,
    endPos.column,
    rel.direction,
  )
}

const ensureStyleElement = (
  clientId: number,
  color: string,
  highlight: string,
  styleMap: Map<number, HTMLStyleElement>,
) => {
  if (typeof document === 'undefined') return

  const existing = styleMap.get(clientId)
  const css = `
    .yRemoteSelection-${clientId} {
      background-color: ${highlight} !important;
      outline: 1px solid ${color} !important;
      outline-offset: -1px !important;
      position: absolute !important;
      height: 100% !important;
      z-index: 5 !important;
    }
    .yRemoteSelectionHead-${clientId} {
      border-left: 2px solid ${color};
      border-top: 2px solid ${color};
      border-bottom: 2px solid ${color};
      position: absolute;
      height: 100%;
      box-sizing: border-box;
    }
    .yRemoteSelectionHead-${clientId}::after {
      content: '';
      position: absolute;
      border: 3px solid ${color};
      border-radius: 3px;
      left: -4px;
      top: -5px;
    }
  `

  if (existing) {
    if (existing.textContent !== css) {
      existing.textContent = css
    }
    return
  }

  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  styleMap.set(clientId, style)
}

const pruneStyleElements = (
  activeClientIds: Set<number>,
  styleMap: Map<number, HTMLStyleElement>,
) => {
  if (typeof document === 'undefined') return

  styleMap.forEach((element, clientId) => {
    if (!activeClientIds.has(clientId)) {
      element.remove()
      styleMap.delete(clientId)
    }
  })
}

export class MonacoBinding {
  private readonly monaco: MonacoInstance
  private readonly doc: Y.Doc
  private readonly ytext: Y.Text
  private readonly monacoModel: MonacoModel
  private readonly editors: Set<EditorInstance>
  private readonly mux: (cb: () => void) => void
  private readonly awareness: Awareness | null
  private readonly styleElements = new Map<number, HTMLStyleElement>()
  private readonly selectionDisposables: Monaco.IDisposable[] = []
  private rerenderHandle = 0
  private lastDecorationsSignature = ''
  private destroyed = false
  private readonly undoManager: Y.UndoManager
  private readonly undoModel: MonacoModel & { undo: () => void | Promise<void>; redo: () => void | Promise<void> }
  private readonly nativeUndo: () => void | Promise<void>
  private readonly nativeRedo: () => void | Promise<void>

  private savedSelections = new Map<EditorInstance, RelativeSelection>()
  private decorations = new Map<EditorInstance, string[]>()

  private readonly beforeTransaction = () => {
    this.mux(() => {
      this.savedSelections = new Map()
      this.editors.forEach((editor) => {
        if (editor.getModel() !== this.monacoModel) return
        const selection = createRelativeSelection(editor, this.monacoModel, this.ytext)
        if (selection) {
          this.savedSelections.set(editor, selection)
        }
      })
    })
  }

  private readonly ytextObserver = (event: Y.YTextEvent) => {
    if (event.transaction.origin === this) {
      this.scheduleRerenderDecorations()
      return
    }

    this.mux(() => {
      this.projectDocument()

      this.savedSelections.forEach((selection, editor) => {
        const nextSelection = createMonacoSelectionFromRelative(
          this.monaco,
          editor,
          this.ytext,
          selection,
          this.doc,
        )
        if (nextSelection) {
          editor.setSelection(nextSelection)
        }
      })
    })

    this.scheduleRerenderDecorations()
  }

  private projectDocument() {
    const target = normalizeLineEndings(this.ytext.toString()).replace(/^\ufeff/, '')
    this.monacoModel.setEOL(this.monaco.editor.EndOfLineSequence.LF)
    const current = this.monacoModel.getValue()
    if (current === target) return
    let start = 0
    while (start < current.length && start < target.length && current[start] === target[start]) start++
    // Never split a surrogate pair while computing the minimal replacement.
    if (start > 0 && /[\uD800-\uDBFF]/.test(current[start - 1]!)) start--
    let oldEnd = current.length, newEnd = target.length
    while (oldEnd > start && newEnd > start && current[oldEnd - 1] === target[newEnd - 1]) { oldEnd--; newEnd-- }
    if (oldEnd < current.length && /[\uDC00-\uDFFF]/.test(current[oldEnd]!)) { oldEnd++; newEnd++ }
    const from = this.monacoModel.getPositionAt(start)
    const to = this.monacoModel.getPositionAt(oldEnd)
    this.monacoModel.applyEdits([{ range: new this.monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: target.slice(start, newEnd) }])
  }

  private readonly rerenderDecorations = () => {
    // Track every peer currently known to awareness (regardless of whether
    // their cursor state is resolvable this tick). Pruning against the full
    // peer set avoids churning style elements when a peer's relative
    // position temporarily fails to resolve, and still drops styles when a
    // peer leaves awareness entirely (y-protocols has its own ~30s stale
    // state timeout, so silent disconnects clear up too).
    const knownPeers = new Set<number>()
    if (this.awareness) {
      this.awareness.getStates().forEach((_state, clientId) => {
        if (clientId !== this.doc.clientID) knownPeers.add(clientId)
      })
    }

    this.editors.forEach((editor) => {
      if (!this.awareness || editor.getModel() !== this.monacoModel) {
        this.decorations.delete(editor)
        return
      }

      const currentDecorations = this.decorations.get(editor) ?? []
      const nextDecorations: Monaco.editor.IModelDeltaDecoration[] = []
      // Build a stable signature from resolved absolute indices instead of
      // JSON.stringify(RelativePosition), which is brittle (item=null at
      // end-of-doc yields identical JSON for different positions) and fails
      // to distinguish between a temporarily-unresolved cursor and one that
      // has actually moved.
      let nextSignature = ''

      this.awareness.getStates().forEach((state: any, clientId: number) => {
        if (clientId === this.doc.clientID) return

        const cursorState = state.cursor as CursorState | undefined
        if (!cursorState?.anchor || !cursorState?.head) {
          // Peer exists but has no cursor yet — include in signature so
          // we re-render once they do.
          nextSignature += `${clientId}:nocursor|`
          return
        }

        const anchorAbs = Y.createAbsolutePositionFromRelativePosition(cursorState.anchor, this.doc)
        const headAbs = Y.createAbsolutePositionFromRelativePosition(cursorState.head, this.doc)
        if (!anchorAbs || !headAbs || anchorAbs.type !== this.ytext || headAbs.type !== this.ytext) {
          // Document may still be syncing; keep an unresolved marker in
          // the signature so we try again on the next update.
          nextSignature += `${clientId}:unresolved|`
          return
        }

        nextSignature += `${clientId}:${anchorAbs.index}:${headAbs.index}|`

        const userColor = state.user?.color ?? '#3b82f6'
        const userHighlight = state.user?.colorLight ?? 'rgba(59, 130, 246, 0.3)'
        ensureStyleElement(clientId, userColor, userHighlight, this.styleElements)

        let startIndex = anchorAbs.index
        let endIndex = headAbs.index
        let afterContentClassName: string | undefined
        let beforeContentClassName: string | undefined

        if (startIndex > endIndex) {
          ;[startIndex, endIndex] = [endIndex, startIndex]
          beforeContentClassName = `yRemoteSelectionHead yRemoteSelectionHead-${clientId}`
        } else {
          afterContentClassName = `yRemoteSelectionHead yRemoteSelectionHead-${clientId}`
        }

        const selectionLen = endIndex - startIndex
        const hasSelection = selectionLen > 0

        const startPos = this.monacoModel.getPositionAt(toModelOffset(this.ytext.toString(), startIndex))
        const endPos = this.monacoModel.getPositionAt(toModelOffset(this.ytext.toString(), endIndex))

        nextDecorations.push({
          range: new this.monaco.Range(
            startPos.lineNumber,
            startPos.column,
            endPos.lineNumber,
            endPos.column,
          ),
          options: {
            className: hasSelection
              ? `yRemoteSelection yRemoteSelection-${clientId}`
              : undefined,
            afterContentClassName,
            beforeContentClassName,
            stickiness: this.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            showIfCollapsed: true,
          },
        })
      })

      if (nextSignature !== this.lastDecorationsSignature) {
        this.lastDecorationsSignature = nextSignature
        const newIds = editor.deltaDecorations(currentDecorations, nextDecorations)
        this.decorations.set(editor, newIds)
      }
    })

    pruneStyleElements(knownPeers, this.styleElements)
  }

  private readonly scheduleRerenderDecorations = () => {
    if (this.rerenderHandle) return
    this.rerenderHandle = requestAnimationFrame(() => {
      this.rerenderHandle = 0
      this.rerenderDecorations()
    })
  }

  private readonly monacoChangeHandler: Monaco.IDisposable
  private readonly monacoDisposeHandler: Monaco.IDisposable

  constructor(
    monacoInstance: MonacoInstance,
    ytext: Y.Text,
    monacoModel: MonacoModel,
    editors = new Set<EditorInstance>(),
    awareness: Awareness | null = null,
  ) {
    this.monaco = monacoInstance
    this.doc = ytext.doc as Y.Doc
    this.ytext = ytext
    this.monacoModel = monacoModel
    this.editors = editors
    this.mux = createMutex()
    this.awareness = awareness

    this.doc.on('beforeAllTransactions', this.beforeTransaction)
    this.ytext.observe(this.ytextObserver)

    this.undoManager = new Y.UndoManager(ytext, { trackedOrigins: new Set([this]) })
    this.undoModel = monacoModel as typeof this.undoModel
    this.nativeUndo = this.undoModel.undo
    this.nativeRedo = this.undoModel.redo
    // All Monaco undo entry points (keyboard, context menu and commands) call
    // the model. Native offset-based history must not undo remote operations.
    this.undoModel.undo = () => { if (this.isEditable()) this.undoManager.undo() }
    this.undoModel.redo = () => { if (this.isEditable()) this.undoManager.redo() }
    this.mux(() => this.projectDocument())
    this.monacoChangeHandler = this.monacoModel.onDidChangeContent((event) => {
      this.mux(() => {
        if (event.isEolChange) { this.projectDocument(); return }
        const raw = this.ytext.toString()
        this.doc.transact(() => {
          [...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset).forEach((change) => {
            const start = toYTextOffset(raw, change.rangeOffset)
            const end = toYTextOffset(raw, change.rangeOffset + change.rangeLength)
            if (end > start) this.ytext.delete(start, end - start)
            if (change.text) this.ytext.insert(start, normalizeCollaborativeText(change.text))
          })
        }, this)
        this.projectDocument()
      })
    })

    this.monacoDisposeHandler = this.monacoModel.onWillDispose(() => {
      this.destroy()
    })

    if (this.awareness) {
      this.editors.forEach((editor) => {
        this.selectionDisposables.push(
          editor.onDidChangeCursorSelection(() => {
            if (editor.getModel() !== this.monacoModel) return

            const selection = editor.getSelection()
            if (!selection) return

            const anchorOffset = this.monacoModel.getOffsetAt(selection.getStartPosition())
            const headOffset = this.monacoModel.getOffsetAt(selection.getEndPosition())
            const direction = selection.getDirection()

            const cursor: CursorState = {
              anchor: Y.createRelativePositionFromTypeIndex(
                this.ytext,
                toYTextOffset(this.ytext.toString(), direction === this.monaco.SelectionDirection.RTL ? headOffset : anchorOffset),
              ),
              head: Y.createRelativePositionFromTypeIndex(
                this.ytext,
                toYTextOffset(this.ytext.toString(), direction === this.monaco.SelectionDirection.RTL ? anchorOffset : headOffset),
              ),
            }

            this.awareness?.setLocalStateField('cursor', cursor)
          }),
        )
      })

      this.awareness.on('change', this.scheduleRerenderDecorations)
    }
  }

  private isEditable() {
    return !this.destroyed && (this.editors.size === 0 || [...this.editors].some(editor =>
      !editor.getOption(this.monaco.editor.EditorOption.readOnly)))
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.undoModel.undo = this.nativeUndo
    this.undoModel.redo = this.nativeRedo
    this.undoManager.destroy()
    this.monacoChangeHandler.dispose()
    this.monacoDisposeHandler.dispose()
    this.selectionDisposables.forEach((disposable) => disposable.dispose())
    this.selectionDisposables.length = 0
    this.ytext.unobserve(this.ytextObserver)
    this.doc.off('beforeAllTransactions', this.beforeTransaction)

    if (this.awareness) {
      this.awareness.off('change', this.scheduleRerenderDecorations)
      this.awareness.setLocalStateField('cursor', null)
    }

    if (this.rerenderHandle) {
      cancelAnimationFrame(this.rerenderHandle)
      this.rerenderHandle = 0
    }

    this.styleElements.forEach((style) => style.remove())
    this.styleElements.clear()
  }
}
