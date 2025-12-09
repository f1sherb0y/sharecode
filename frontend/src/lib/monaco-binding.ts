import * as Y from 'yjs'
import { createMutex } from 'lib0/mutex'
import type { Awareness } from 'y-protocols/awareness'
import type * as Monaco from 'monaco-editor'

type MonacoEditor = Monaco.editor.IStandaloneCodeEditor
type MonacoModel = Monaco.editor.ITextModel

interface CursorState {
  anchor: Y.RelativePosition
  head: Y.RelativePosition
}

export class MonacoBinding {
  private editor: MonacoEditor
  private model: MonacoModel
  private ytext: Y.Text
  private doc: Y.Doc
  private awareness: Awareness
  private mux = createMutex()
  private decorations: string[] = []
  private disposables: Monaco.IDisposable[] = []
  private styleElements = new Map<number, HTMLStyleElement>()
  private isDestroyed = false

  constructor(
    editor: MonacoEditor,
    model: MonacoModel,
    ytext: Y.Text,
    awareness: Awareness,
    private monaco: typeof Monaco
  ) {
    this.editor = editor
    this.model = model
    this.ytext = ytext
    this.doc = ytext.doc!
    this.awareness = awareness

    // Initialize model content from Yjs (normalize line endings)
    const initialContent = ytext.toString().replace(/\r\n?/g, '\n')
    if (model.getValue() !== initialContent) {
      model.setValue(initialContent)
    }

    // Ensure Monaco uses LF
    model.setEOL(monaco.editor.EndOfLineSequence.LF)

    // Yjs -> Monaco
    const ytextObserver = (event: Y.YTextEvent) => {
      this.mux(() => {
        if (this.isDestroyed) return

        let index = 0
        event.delta.forEach((delta) => {
          if (delta.retain !== undefined) {
            index += delta.retain
          } else if (delta.insert !== undefined) {
            const pos = model.getPositionAt(index)
            const text = typeof delta.insert === 'string' ? delta.insert : ''
            const range = new monaco.Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column)
            model.applyEdits([{ range, text }])
            index += text.length
          } else if (delta.delete !== undefined) {
            const startPos = model.getPositionAt(index)
            const endPos = model.getPositionAt(index + delta.delete)
            const range = new monaco.Selection(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column)
            model.applyEdits([{ range, text: '' }])
          }
        })
      })
      this.renderRemoteSelections()
    }

    ytext.observe(ytextObserver)

    // Monaco -> Yjs
    const modelChangeDisposable = model.onDidChangeContent((event) => {
      this.mux(() => {
        if (this.isDestroyed) return

        this.doc.transact(() => {
          event.changes
            .sort((a, b) => b.rangeOffset - a.rangeOffset)
            .forEach((change) => {
              ytext.delete(change.rangeOffset, change.rangeLength)
              // Normalize line endings to LF
              const normalizedText = change.text.replace(/\r\n?/g, '\n')
              ytext.insert(change.rangeOffset, normalizedText)
            })
        }, this)
      })
    })

    this.disposables.push(modelChangeDisposable)

    // Update local cursor position using RelativePosition
    const cursorChangeDisposable = editor.onDidChangeCursorSelection((event) => {
      const selection = event.selection
      const anchorOffset = model.getOffsetAt({
        lineNumber: selection.startLineNumber,
        column: selection.startColumn,
      })
      const headOffset = model.getOffsetAt({
        lineNumber: selection.endLineNumber,
        column: selection.endColumn,
      })

      // Store as RelativePosition so it adjusts when document changes
      const cursor: CursorState = {
        anchor: Y.createRelativePositionFromTypeIndex(ytext, anchorOffset),
        head: Y.createRelativePositionFromTypeIndex(ytext, headOffset),
      }

      awareness.setLocalStateField('cursor', cursor)
    })

    this.disposables.push(cursorChangeDisposable)

    // Awareness change handler
    const awarenessChangeHandler = () => {
      this.renderRemoteSelections()
    }

    awareness.on('change', awarenessChangeHandler)

    // Cleanup
    this.disposables.push({
      dispose: () => {
        ytext.unobserve(ytextObserver)
        awareness.off('change', awarenessChangeHandler)
      },
    })
  }

  private renderRemoteSelections() {
    if (this.isDestroyed) return

    const states = this.awareness.getStates()
    const localClientId = this.awareness.clientID
    const activeClients = new Set<number>()
    const decorations: Monaco.editor.IModelDeltaDecoration[] = []

    states.forEach((state, clientId) => {
      if (clientId === localClientId) return
      if (!state.cursor || !state.user) return

      const cursorState = state.cursor as CursorState
      if (!cursorState.anchor || !cursorState.head) return

      // Convert RelativePosition back to absolute position
      const anchorAbs = Y.createAbsolutePositionFromRelativePosition(cursorState.anchor, this.doc)
      const headAbs = Y.createAbsolutePositionFromRelativePosition(cursorState.head, this.doc)

      if (!anchorAbs || !headAbs || anchorAbs.type !== this.ytext || headAbs.type !== this.ytext) {
        return
      }

      const user = state.user as { id?: string; username?: string; color?: string; colorLight?: string }
      const userColor = user.color ?? '#3b82f6'
      const userColorLight = user.colorLight ?? 'rgba(59, 130, 246, 0.2)'

      // Ensure style element exists for this client
      this.ensureStyleElement(clientId, userColor, userColorLight)
      activeClients.add(clientId)

      let startIndex = anchorAbs.index
      let endIndex = headAbs.index
      let afterContentClassName: string | null = null
      let beforeContentClassName: string | null = null

      if (startIndex > endIndex) {
        ;[startIndex, endIndex] = [endIndex, startIndex]
        beforeContentClassName = `yRemoteSelectionHead yRemoteSelectionHead-${clientId}`
      } else {
        afterContentClassName = `yRemoteSelectionHead yRemoteSelectionHead-${clientId}`
      }

      const startPos = this.model.getPositionAt(startIndex)
      const endPos = this.model.getPositionAt(endIndex)

      decorations.push({
        range: new this.monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column),
        options: {
          className: `yRemoteSelection yRemoteSelection-${clientId}`,
          afterContentClassName: afterContentClassName ?? undefined,
          beforeContentClassName: beforeContentClassName ?? undefined,
          stickiness: this.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          hoverMessage: { value: user.username ?? 'Anonymous' },
        },
      })
    })

    this.decorations = this.editor.deltaDecorations(this.decorations, decorations)
    this.pruneStyleElements(activeClients)
  }

  private ensureStyleElement(clientId: number, color: string, highlight: string) {
    const existing = this.styleElements.get(clientId)
    const css = `
      .yRemoteSelection-${clientId} {
        background-color: ${highlight};
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
    this.styleElements.set(clientId, style)
  }

  private pruneStyleElements(activeClientIds: Set<number>) {
    this.styleElements.forEach((element, clientId) => {
      if (!activeClientIds.has(clientId)) {
        element.remove()
        this.styleElements.delete(clientId)
      }
    })
  }

  destroy() {
    this.isDestroyed = true
    this.disposables.forEach((d) => d.dispose())
    this.editor.deltaDecorations(this.decorations, [])
    this.pruneStyleElements(new Set())
  }
}
