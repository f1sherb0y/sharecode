import * as Y from 'yjs'
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
    ytext: Y.Text
): RelativeSelection | null => {
    const selection = editor.getSelection()
    if (!selection) {
        return null
    }

    const start = Y.createRelativePositionFromTypeIndex(
        ytext,
        model.getOffsetAt(selection.getStartPosition())
    )
    const end = Y.createRelativePositionFromTypeIndex(
        ytext,
        model.getOffsetAt(selection.getEndPosition())
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
    doc: Y.Doc
) => {
    const start = Y.createAbsolutePositionFromRelativePosition(rel.start, doc)
    const end = Y.createAbsolutePositionFromRelativePosition(rel.end, doc)
    if (!start || !end || start.type !== ytext || end.type !== ytext) {
        return null
    }

    const model = editor.getModel()
    if (!model) {
        return null
    }

    const startPos = model.getPositionAt(start.index)
    const endPos = model.getPositionAt(end.index)
    return monacoInstance.Selection.createWithDirection(
        startPos.lineNumber,
        startPos.column,
        endPos.lineNumber,
        endPos.column,
        rel.direction
    )
}

const ensureStyleElement = (
    clientId: number,
    color: string,
    highlight: string,
    styleMap: Map<number, HTMLStyleElement>
) => {
    if (typeof document === 'undefined') return

    const existing = styleMap.get(clientId)
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
    styleMap.set(clientId, style)
}

const pruneStyleElements = (activeClientIds: Set<number>, styleMap: Map<number, HTMLStyleElement>) => {
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

    private savedSelections = new Map<EditorInstance, RelativeSelection>()
    private decorations = new Map<EditorInstance, string[]>()

    private readonly beforeTransaction = () => {
        this.mux(() => {
            this.savedSelections = new Map()
            this.editors.forEach((editor) => {
                if (editor.getModel() === this.monacoModel) {
                    const rsel = createRelativeSelection(editor, this.monacoModel, this.ytext)
                    if (rsel) {
                        this.savedSelections.set(editor, rsel)
                    }
                }
            })
        })
    }

    private readonly ytextObserver = (event: Y.YTextEvent) => {
        this.mux(() => {
            let index = 0
            event.delta.forEach((op) => {
                if (op.retain !== undefined) {
                    index += op.retain
                } else if (op.insert !== undefined) {
                    const pos = this.monacoModel.getPositionAt(index)
                    const range = new this.monaco.Selection(
                        pos.lineNumber,
                        pos.column,
                        pos.lineNumber,
                        pos.column
                    )
                    const text = String(op.insert)
                    this.monacoModel.applyEdits([{ range, text }])
                    index += text.length
                } else if (op.delete !== undefined) {
                    const pos = this.monacoModel.getPositionAt(index)
                    const endPos = this.monacoModel.getPositionAt(index + op.delete)
                    const range = new this.monaco.Selection(
                        pos.lineNumber,
                        pos.column,
                        endPos.lineNumber,
                        endPos.column
                    )
                    this.monacoModel.applyEdits([{ range, text: '' }])
                }
            })
            this.savedSelections.forEach((rel, editor) => {
                const selection = createMonacoSelectionFromRelative(
                    this.monaco,
                    editor,
                    this.ytext,
                    rel,
                    this.doc
                )
                if (selection) {
                    editor.setSelection(selection)
                }
            })
        })
        this.rerenderDecorations()
    }

    private readonly rerenderDecorations = () => {
        const activeClients = new Set<number>()

        this.editors.forEach((editor) => {
            if (!this.awareness || editor.getModel() !== this.monacoModel) {
                this.decorations.delete(editor)
                return
            }

            const currentDecorations = this.decorations.get(editor) || []
            const nextDecorations: Monaco.editor.IModelDeltaDecoration[] = []

            this.awareness.getStates().forEach((state: any, clientID: number) => {
                if (clientID === this.doc.clientID) return
                const cursorState: CursorState | undefined = state.cursor
                if (!cursorState?.anchor || !cursorState?.head) return

                const anchorAbs = Y.createAbsolutePositionFromRelativePosition(cursorState.anchor, this.doc)
                const headAbs = Y.createAbsolutePositionFromRelativePosition(cursorState.head, this.doc)
                if (!anchorAbs || !headAbs || anchorAbs.type !== this.ytext || headAbs.type !== this.ytext) {
                    return
                }

                const userColor = state.user?.color ?? '#3b82f6'
                const userHighlight = state.user?.colorLight ?? 'rgba(59, 130, 246, 0.2)'
                ensureStyleElement(clientID, userColor, userHighlight, this.styleElements)
                activeClients.add(clientID)

                let startIndex = anchorAbs.index
                let endIndex = headAbs.index
                let afterContentClassName: string | null = null
                let beforeContentClassName: string | null = null

                if (startIndex > endIndex) {
                    ;[startIndex, endIndex] = [endIndex, startIndex]
                    beforeContentClassName = `yRemoteSelectionHead yRemoteSelectionHead-${clientID}`
                } else {
                    afterContentClassName = `yRemoteSelectionHead yRemoteSelectionHead-${clientID}`
                }

                const startPos = this.monacoModel.getPositionAt(startIndex)
                const endPos = this.monacoModel.getPositionAt(endIndex)

                nextDecorations.push({
                    range: new this.monaco.Range(
                        startPos.lineNumber,
                        startPos.column,
                        endPos.lineNumber,
                        endPos.column
                    ),
                    options: {
                        className: `yRemoteSelection yRemoteSelection-${clientID}`,
                        afterContentClassName: afterContentClassName ?? undefined,
                        beforeContentClassName: beforeContentClassName ?? undefined,
                        stickiness:
                            this.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                    },
                })
            })

            this.decorations.set(editor, editor.deltaDecorations(currentDecorations, nextDecorations))
        })

        pruneStyleElements(activeClients, this.styleElements)
    }

    private readonly monacoChangeHandler: Monaco.IDisposable
    private readonly monacoDisposeHandler: Monaco.IDisposable

    constructor(
        monacoInstance: MonacoInstance,
        ytext: Y.Text,
        monacoModel: MonacoModel,
        editors = new Set<EditorInstance>(),
        awareness: Awareness | null = null
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

        const yValue = this.ytext.toString()
        if (this.monacoModel.getValue() !== yValue) {
            this.monacoModel.setValue(yValue)
        }

        this.monacoChangeHandler = this.monacoModel.onDidChangeContent((event) => {
            this.mux(() => {
                this.doc.transact(() => {
                    event.changes
                        .sort((a, b) => b.rangeOffset - a.rangeOffset)
                        .forEach((change) => {
                            this.ytext.delete(change.rangeOffset, change.rangeLength)
                            this.ytext.insert(change.rangeOffset, change.text)
                        })
                })
            })
        })

        this.monacoDisposeHandler = this.monacoModel.onWillDispose(() => {
            this.destroy()
        })

        if (this.awareness) {
            this.editors.forEach((editor) => {
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
                            direction === this.monaco.SelectionDirection.RTL ? headOffset : anchorOffset
                        ),
                        head: Y.createRelativePositionFromTypeIndex(
                            this.ytext,
                            direction === this.monaco.SelectionDirection.RTL ? anchorOffset : headOffset
                        ),
                    }

                    this.awareness?.setLocalStateField('cursor', cursor)
                })
            })

            this.awareness.on('change', this.rerenderDecorations)
        }
    }

    destroy() {
        this.monacoChangeHandler.dispose()
        this.monacoDisposeHandler.dispose()
        this.ytext.unobserve(this.ytextObserver)
        this.doc.off('beforeAllTransactions', this.beforeTransaction)

        if (this.awareness) {
            this.awareness.off('change', this.rerenderDecorations)
        }

        pruneStyleElements(new Set(), this.styleElements)
    }
}
