import { useCallback, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { Editor, editorViewCtx, editorViewOptionsCtx, rootCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { cursor } from '@milkdown/kit/plugin/cursor'
import { trailing } from '@milkdown/kit/plugin/trailing'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { upload, uploadConfig, type Uploader } from '@milkdown/kit/plugin/upload'
import { collab, collabServiceCtx } from '@milkdown/plugin-collab'
import { TextSelection } from '@milkdown/kit/prose/state'
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInBlockquoteCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  insertImageCommand,
} from '@milkdown/kit/preset/commonmark'
import {
  toggleStrikethroughCommand,
  insertTableCommand,
} from '@milkdown/kit/preset/gfm'
import { insert, callCommand, forceUpdate } from '@milkdown/kit/utils'
import { ySyncPluginKey, relativePositionToAbsolutePosition } from 'y-prosemirror'
import type { Ctx } from '@milkdown/ctx'
import {
  Bold,
  Italic,
  Strikethrough,
  Heading2,
  Code,
  Quote,
  List,
  Link2,
  Image as ImageIcon,
  Workflow,
  Table,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui'
import { compressImageFile } from '@/lib/image-compress'
import { mermaidPlugins } from '@/lib/milkdown-mermaid'
import { imagePlugins } from '@/lib/milkdown-image'
import '@/styles/markdown.css'

// Must-have ProseMirror layout CSS + table base styles for the GFM table node.
import '@milkdown/kit/prose/view/style/prosemirror.css'
import '@milkdown/kit/prose/tables/style/tables.css'

interface MarkdownEditorProps {
  ytext: Y.Text | null
  canEdit: boolean
  provider: HocuspocusProvider | null
  ydoc: Y.Doc | null
  isSynced: boolean
  followingUserId: string | null
  followingClientId: number | null
}

const MERMAID_SNIPPET = '```mermaid\nflowchart TD\n    A[Start] --> B[End]\n```'

/** Minimal diff binding used only to mirror the markdown into `ytext` so the
 *  existing playback pipeline (which reads `ytext`) keeps working. */
function applyTextDiff(oldText: string, newText: string, ytext: Y.Text, origin: object) {
  if (oldText === newText) return

  let start = 0
  const maxStart = Math.min(oldText.length, newText.length)
  while (start < maxStart && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++

  let oldEnd = oldText.length
  let newEnd = newText.length
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
  ) {
    oldEnd--
    newEnd--
  }

  ytext.doc!.transact(() => {
    if (oldEnd > start) ytext.delete(start, oldEnd - start)
    if (newEnd > start) ytext.insert(start, newText.slice(start, newEnd))
  }, origin)
}

const compressedUploader: Uploader = async (files, schema) => {
  const images: File[] = []
  for (let i = 0; i < files.length; i++) {
    const file = files.item(i)
    if (file && file.type.startsWith('image/')) images.push(file)
  }

  const { image } = schema.nodes
  if (!image) throw new Error('Image node is not available in schema')

  const compressed = await Promise.all(images.map((file) => compressImageFile(file)))
  return compressed.map(({ src, alt }) => image.create({ src, alt }))
}

interface RemoteUserAwareness {
  name?: string
  color?: string
  colorLight?: string
}

/**
 * The app broadcasts `color` as an `hsl()` string and `colorLight` as an
 * `hsla()` string (see the server's session-color payload). y-prosemirror's
 * default selection builder blindly appends `70` to the color, which only
 * works for 6-digit hex — with `hsl(...)` it produces invalid CSS and the
 * selection becomes invisible. We use `colorLight` directly instead, matching
 * the Monaco remote-selection highlight.
 */
const remoteSelectionBuilder = (user: RemoteUserAwareness) => {
  const highlight = user.colorLight || 'rgba(59, 130, 246, 0.35)'
  return {
    style: `background-color: ${highlight}`,
    class: 'ProseMirror-yjs-selection',
  }
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  return (
    <MilkdownProvider>
      <MarkdownEditorInner {...props} />
    </MilkdownProvider>
  )
}

function MarkdownEditorInner({
  ytext,
  canEdit,
  provider,
  ydoc,
  isSynced,
  followingUserId,
  followingClientId,
}: MarkdownEditorProps) {
  const [isImageLoading, setIsImageLoading] = useState(false)

  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit

  const ytextRef = useRef<Y.Text | null>(null)
  ytextRef.current = ytext

  const providerRef = useRef<HocuspocusProvider | null>(null)
  providerRef.current = provider

  const ydocRef = useRef<Y.Doc | null>(null)
  ydocRef.current = ydoc

  const mirrorOriginRef = useRef<object>({})
  const collabConnectedRef = useRef(false)
  const mirrorRegisteredRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const lastFollowPosRef = useRef<number | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const getEditor = useCallback(
    (container: HTMLElement) =>
      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, container)
          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            editable: () => canEditRef.current,
          }))
          ctx.update(uploadConfig.key, (prev) => ({ ...prev, uploader: compressedUploader }))
        })
        .use(commonmark)
        .use(gfm)
        .use(clipboard)
        .use(cursor)
        .use(trailing)
        .use(listener)
        .use(upload)
        .use(mermaidPlugins)
        .use(imagePlugins)
        .use(collab),
    [],
  )

  const { loading, get } = useEditor(getEditor, [])

  const run = useCallback(
    (fn: (ctx: Ctx) => void | boolean) => {
      const editor = get()
      if (!editor) return
      editor.action(fn)
    },
    [get],
  )

  // Connect y-prosemirror once the document has finished its initial sync.
  // Any legacy content living in `ytext` (from the old editor) is migrated into
  // the XmlFragment the first time.
  useEffect(() => {
    if (loading || !isSynced || !ydoc || !provider) return
    const editor = get()
    if (!editor || collabConnectedRef.current) return
    collabConnectedRef.current = true

    editor.action((ctx) => {
      const collabService = ctx.get(collabServiceCtx)
      const legacy = ytextRef.current?.toString() ?? ''
      collabService.bindDoc(ydoc)
      if (provider.awareness) {
        collabService.setAwareness(provider.awareness)
      }
      collabService
        .setOptions({ yCursorOpts: { selectionBuilder: remoteSelectionBuilder } })
        .applyTemplate(legacy || '')
        .connect()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, isSynced, ydoc, provider])

  // Mirror the serialized markdown into `ytext` so playback keeps working.
  useEffect(() => {
    if (loading || !ytext) return
    const editor = get()
    if (!editor || mirrorRegisteredRef.current) return
    mirrorRegisteredRef.current = true

    editor.action((ctx) => {
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        const yt = ytextRef.current
        if (!yt || markdown === yt.toString()) return
        applyTextDiff(yt.toString(), markdown, yt, mirrorOriginRef.current)
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, ytext])

  // Re-evaluate the `editable` predicate when permissions change.
  useEffect(() => {
    if (loading) return
    const editor = get()
    if (!editor) return
    editor.action(forceUpdate())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, loading])

  // Follow mode: scroll to the followed user's cursor.
  useEffect(() => {
    if (loading || !ydoc) return
    const editor = get()
    if (!editor) return
    const awareness = provider?.awareness
    if (!awareness) return

    if (followingUserId == null && followingClientId == null) {
      lastFollowPosRef.current = null
      return
    }

    const scrollToUser = () => {
      const view = editor.action((ctx) => ctx.get(editorViewCtx))
      const ystate = ySyncPluginKey.getState(view.state)
      if (!ystate) return

      const localClientId = awareness.clientID
      let targetClientId: number | null = null

      if (followingUserId != null) {
        awareness.getStates().forEach((state, clientId) => {
          if (targetClientId != null || clientId === localClientId) return
          const user = (state as { user?: { id?: string } }).user
          if (user?.id === followingUserId) targetClientId = clientId
        })
      } else if (followingClientId != null) {
        targetClientId = followingClientId
      }

      if (targetClientId == null) return

      const state = awareness.getStates().get(targetClientId) as
        | { cursor?: { head?: unknown } }
        | undefined
      if (!state?.cursor?.head) return

      try {
        const pos = relativePositionToAbsolutePosition(
          ydoc,
          ystate.type,
          Y.createRelativePositionFromJSON(state.cursor.head as object),
          ystate.binding.mapping,
        )
        if (pos == null) return
        if (lastFollowPosRef.current === pos) return
        lastFollowPosRef.current = pos

        const clamped = Math.min(pos, view.state.doc.content.size)
        const $pos = view.state.doc.resolve(clamped)
        view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))

        // Center the followed user's cursor vertically in the scroll container.
        const container = bodyRef.current
        const coords = view.coordsAtPos(clamped)
        if (container && coords) {
          const rect = container.getBoundingClientRect()
          const contentY = container.scrollTop + (coords.top - rect.top)
          container.scrollTop = Math.max(0, contentY - rect.height / 2)
        }
      } catch (err) {
        console.error('Error following user:', err)
      }
    }

    scrollToUser()
    awareness.on('change', scrollToUser)
    return () => {
      awareness.off('change', scrollToUser)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, ydoc, provider, followingUserId, followingClientId])

  const handleImageFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file) return
      setIsImageLoading(true)
      try {
        const { src, alt } = await compressImageFile(file)
        run(callCommand(insertImageCommand.key, { src, alt }))
      } catch (error) {
        console.error('Failed to insert image:', error)
      } finally {
        setIsImageLoading(false)
      }
    },
    [run],
  )

  const insertLink = useCallback(() => {
    const href = window.prompt('Link URL:')
    if (!href) return
    run(callCommand(toggleLinkCommand.key, { href }))
  }, [run])

  const toolbarButtonClass =
    'h-7 w-7 p-0 text-muted-foreground hover:text-foreground disabled:opacity-40'

  return (
    <div className="md-editor flex h-full flex-col">
      {canEdit && (
        <div className="md-toolbar flex shrink-0 items-center gap-0.5 border-b px-1.5 py-1 overflow-x-auto">
          <Button
            variant="ghost"
            size="icon"
            className={toolbarButtonClass}
            title="Bold"
            onClick={() => run(callCommand(toggleStrongCommand.key))}
          >
            <Bold className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={toolbarButtonClass}
            title="Italic"
            onClick={() => run(callCommand(toggleEmphasisCommand.key))}
          >
            <Italic className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={toolbarButtonClass}
            title="Strikethrough"
            onClick={() => run(callCommand(toggleStrikethroughCommand.key))}
          >
            <Strikethrough className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={toolbarButtonClass}
            title="Heading"
            onClick={() => run(callCommand(wrapInHeadingCommand.key, 2))}
          >
            <Heading2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={toolbarButtonClass}
            title="Inline code"
            onClick={() => run(callCommand(toggleInlineCodeCommand.key))}
          >
            <Code className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={toolbarButtonClass}
            title="Quote"
            onClick={() => run(callCommand(wrapInBlockquoteCommand.key))}
          >
            <Quote className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={toolbarButtonClass}
            title="Bullet list"
            onClick={() => run(callCommand(wrapInBulletListCommand.key))}
          >
            <List className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={toolbarButtonClass}
            title="Link"
            onClick={insertLink}
          >
            <Link2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={toolbarButtonClass}
            title="Table"
            onClick={() => run(callCommand(insertTableCommand.key, { row: 3, col: 3 }))}
          >
            <Table className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={toolbarButtonClass}
            title="Mermaid diagram"
            onClick={() => run(insert(MERMAID_SNIPPET))}
          >
            <Workflow className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={toolbarButtonClass}
            title="Insert image"
            disabled={isImageLoading}
            onClick={() => fileInputRef.current?.click()}
          >
            {isImageLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ImageIcon className="h-3.5 w-3.5" />
            )}
          </Button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              void handleImageFile(file)
              event.target.value = ''
            }}
          />
        </div>
      )}

      <div ref={bodyRef} className="md-editor-body min-h-0 flex-1 overflow-y-auto">
        <Milkdown />
      </div>
    </div>
  )
}
