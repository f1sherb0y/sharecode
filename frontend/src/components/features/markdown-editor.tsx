import { type CSSProperties, type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { loadEditorFont } from '@/lib/editor-font'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { Editor, editorViewCtx, editorViewOptionsCtx, rootCtx, serializerCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { cursor } from '@milkdown/kit/plugin/cursor'
import { trailing } from '@milkdown/kit/plugin/trailing'
import { upload, uploadConfig, type Uploader } from '@milkdown/kit/plugin/upload'
import { collab, collabServiceCtx } from '@milkdown/plugin-collab'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
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
import { $prose, insert, callCommand, forceUpdate } from '@milkdown/kit/utils'
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
  Sigma,
  Radical,
  Table,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui'
import { useFontStore } from '@/stores'
import { fontFamilyStack } from '@/stores/font'
import { compressImageFile } from '@/lib/image-compress'
import { mermaidPlugins } from '@/lib/milkdown-mermaid'
import { imagePlugins } from '@/lib/milkdown-image'
import { mathPlugins } from '@/lib/milkdown-math'
import { MarkdownSelectionBlink } from '@/lib/markdown-selection-blink'
import '@/styles/markdown.css'

// Must-have ProseMirror layout CSS + table base styles for the GFM table node.
import '@milkdown/kit/prose/view/style/prosemirror.css'
import '@milkdown/kit/prose/tables/style/tables.css'

export interface MarkdownEditorHandle {
  getMarkdown: () => string | null
  blinkSelection: () => void
}

interface MarkdownEditorProps {
  ytext: Y.Text | null
  canEdit: boolean
  provider: HocuspocusProvider | null
  ydoc: Y.Doc | null
  isSynced: boolean
  followingUserId: string | null
  followingClientId: number | null
  sourceRef?: Ref<MarkdownEditorHandle>
  onSelectionChange?: (hasSelection: boolean) => void
}

const MERMAID_SNIPPET = '```mermaid\nflowchart TD\n    A[Start] --> B[End]\n```'

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
const remoteSelectionBuilder = (user: RemoteUserAwareness, variant?: number) => {
  const highlight = user.colorLight || 'rgba(59, 130, 246, 0.3)'
  return {
    style: `--collaborator-selection: ${highlight}; --selection-blink-color: ${user.color || '#3b82f6'}`,
    class: `ProseMirror-yjs-selection yRemoteSelection${variant == null ? '' : ` selection-blink-${variant}`}`,
  }
}

const remoteCursorBuilder = (user: RemoteUserAwareness) => {
  const cursor = document.createElement('span')
  cursor.className = 'ProseMirror-yjs-cursor collaboration-caret'
  cursor.style.setProperty('--collaborator-color', user.color || '#3b82f6')
  cursor.setAttribute('aria-hidden', 'true')
  cursor.append(document.createTextNode('\u2060'))
  return cursor
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  useEffect(() => { void loadEditorFont().catch(() => {}) }, [])
  const { font, fontSize } = useFontStore()
  return (
    <div translate="no" className="notranslate h-full" style={{ '--md-font-size': `${fontSize}px`, '--md-font-family': fontFamilyStack(font) } as CSSProperties}><MilkdownProvider key={props.ydoc?.guid}>
      <MarkdownEditorInner {...props} />
    </MilkdownProvider></div>
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
  sourceRef,
  onSelectionChange,
}: MarkdownEditorProps) {
  const { t } = useTranslation()
  const [isImageLoading, setIsImageLoading] = useState(false)

  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit

  const ytextRef = useRef<Y.Text | null>(null)
  ytextRef.current = ytext

  const providerRef = useRef<HocuspocusProvider | null>(null)
  providerRef.current = provider

  const ydocRef = useRef<Y.Doc | null>(null)
  ydocRef.current = ydoc

  const collabConnectedRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const lastFollowPosRef = useRef<number | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const blinkRef = useRef<MarkdownSelectionBlink | null>(null)
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange

  const getEditor = useCallback(
    (container: HTMLElement) =>
      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, container)
          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            editable: () => canEditRef.current,
            // Read-only text still needs focus for native selection tracking
            // and y-prosemirror's remote cursor publication.
            attributes: (state) => ({
              ...(typeof prev.attributes === 'function' ? prev.attributes(state) : prev.attributes),
              tabindex: '0',
            }),
          }))
          ctx.update(uploadConfig.key, (prev) => ({ ...prev, uploader: compressedUploader }))
        })
        .use(commonmark)
        .use(gfm)
        .use(clipboard)
        .use(cursor)
        .use(trailing)
        .use(upload)
        .use(mermaidPlugins)
        .use(imagePlugins)
        .use(mathPlugins)
        .use($prose(() => new Plugin({
          props: { decorations: () => blinkRef.current?.localDecorations() ?? null },
          view: () => ({
            update: (view) => {
              onSelectionChangeRef.current?.(!view.state.selection.empty)
              blinkRef.current?.update()
            },
          }),
        })))
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
      const cursorOptions = {
        cursorBuilder: remoteCursorBuilder,
        selectionBuilder: (user: RemoteUserAwareness, clientId?: number) => remoteSelectionBuilder(user, blinkRef.current?.variant(clientId)),
        awarenessStateFilter: (_docClientId: number, clientId: number) => clientId !== provider.awareness?.clientID,
      }
      collabService.setOptions({ yCursorOpts: cursorOptions })
      const seedClient = ydoc.getMap('meta').get('markdownSeeder')
      if (canEditRef.current && (seedClient == null || seedClient === ydoc.clientID) && !ydoc.getMap('meta').get('markdownInitialized')) {
        // applyTemplate uses Y.applyUpdate (a remote transaction). Mixing that
        // with a local metadata write in one transaction makes Yjs detect a
        // false client-ID collision, leaving awareness with a different ID.
        if (legacy && ydoc.getXmlFragment('prosemirror').length === 0) collabService.applyTemplate(legacy)
        ydoc.getMap('meta').set('markdownInitialized', true)
      }
      collabService.connect()
      if (provider.awareness && bodyRef.current) {
        blinkRef.current = new MarkdownSelectionBlink(ctx.get(editorViewCtx), provider.awareness, bodyRef.current)
      }
      onSelectionChangeRef.current?.(!ctx.get(editorViewCtx).state.selection.empty)
    })
    return () => {
      blinkRef.current?.destroy()
      blinkRef.current = null
      onSelectionChangeRef.current?.(false)
      collabConnectedRef.current = false
      editor.action((ctx) => ctx.get(collabServiceCtx).disconnect())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, ydoc, provider, isSynced, canEdit])

  // Read the current document synchronously when changing modes. Milkdown's
  // debounced change listener can still hold unsent edits when we unmount.
  // XML remains the sole collaborative source of truth while editing Markdown.
  useImperativeHandle(sourceRef, () => ({
    blinkSelection: () => blinkRef.current?.send(),
    getMarkdown: () => {
      const editor = get()
      if (loading || !editor || !collabConnectedRef.current) return null
      return editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc))
    },
  }), [get, loading])

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

      if (followingClientId != null) {
        targetClientId = followingClientId
      } else if (followingUserId != null) {
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
    const href = window.prompt(t('editor.toolbar.linkPrompt'))
    if (!href) return
    run(callCommand(toggleLinkCommand.key, { href }))
  }, [run, t])

  const toolbarButtonClass =
    'text-muted-foreground hover:text-foreground'

  return (
    <div className="md-editor flex h-full flex-col">
      {canEdit && (
        <div className="md-toolbar flex shrink-0 items-center gap-0.5 border-b px-1 py-0.5 overflow-x-auto">
          <Button
            variant="ghost"
            size="icon-sm"
            className={toolbarButtonClass}
            title={t('editor.toolbar.bold')} aria-label={t('editor.toolbar.bold')}
            onClick={() => run(callCommand(toggleStrongCommand.key))}
          >
            <Bold className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={toolbarButtonClass}
            title={t('editor.toolbar.italic')} aria-label={t('editor.toolbar.italic')}
            onClick={() => run(callCommand(toggleEmphasisCommand.key))}
          >
            <Italic className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={toolbarButtonClass}
            title={t('editor.toolbar.strikethrough')} aria-label={t('editor.toolbar.strikethrough')}
            onClick={() => run(callCommand(toggleStrikethroughCommand.key))}
          >
            <Strikethrough className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={toolbarButtonClass}
            title={t('editor.toolbar.heading')} aria-label={t('editor.toolbar.heading')}
            onClick={() => run(callCommand(wrapInHeadingCommand.key, 2))}
          >
            <Heading2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={toolbarButtonClass}
            title={t('editor.toolbar.inlineCode')} aria-label={t('editor.toolbar.inlineCode')}
            onClick={() => run(callCommand(toggleInlineCodeCommand.key))}
          >
            <Code className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={toolbarButtonClass}
            title={t('editor.toolbar.inlineMath')}
            aria-label={t('editor.toolbar.inlineMath')}
            onClick={() => run(insert('$x^2$'))}
          >
            <Radical className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={toolbarButtonClass}
            title={t('editor.toolbar.blockMath')}
            aria-label={t('editor.toolbar.blockMath')}
            onClick={() => run(insert('$$\nE = mc^2\n$$'))}
          >
            <Sigma className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={toolbarButtonClass}
            title={t('editor.toolbar.quote')} aria-label={t('editor.toolbar.quote')}
            onClick={() => run(callCommand(wrapInBlockquoteCommand.key))}
          >
            <Quote className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={toolbarButtonClass}
            title={t('editor.toolbar.bulletList')} aria-label={t('editor.toolbar.bulletList')}
            onClick={() => run(callCommand(wrapInBulletListCommand.key))}
          >
            <List className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={toolbarButtonClass}
            title={t('editor.toolbar.link')} aria-label={t('editor.toolbar.link')}
            onClick={insertLink}
          >
            <Link2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={toolbarButtonClass}
            title={t('editor.toolbar.table')} aria-label={t('editor.toolbar.table')}
            onClick={() => run(callCommand(insertTableCommand.key, { row: 3, col: 3 }))}
          >
            <Table className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={toolbarButtonClass}
            title={t('editor.toolbar.diagram')} aria-label={t('editor.toolbar.diagram')}
            onClick={() => run(insert(MERMAID_SNIPPET))}
          >
            <Workflow className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={toolbarButtonClass}
            title={t('editor.toolbar.image')} aria-label={t('editor.toolbar.image')}
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
