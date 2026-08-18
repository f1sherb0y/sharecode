import { useEffect, useRef, useCallback, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import type * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { useThemeStore, useFontStore } from '@/stores'
import { fontFamilyStack } from '@/stores/font'
import { generateUserColor } from '@/lib/utils'
import { MonacoBinding } from '@/lib/monaco-binding'
import { createMonacoEditorOptions, resolveMonacoLanguage } from '@/lib/monaco-config'
import { loadMonaco } from '@/lib/monaco-loader'
import type { Room, Language, User } from '@/types'

type MonacoModule = typeof Monaco
type MonacoEditorInstance = Monaco.editor.IStandaloneCodeEditor
type MonacoModelInstance = Monaco.editor.ITextModel

interface UseMonacoEditorProps {
  effectiveRoom: Room | null
  ytext: Y.Text | null
  provider: HocuspocusProvider | null
  canEdit: boolean
  currentUser: (User | { id: string; username: string; color: string }) | null
  sessionAwarenessColor: {
    slot: number
    color: string
    colorLight: string
  } | null
  roomEnded: boolean
  setError: (error: string) => void
}

export function useMonacoEditor({
  effectiveRoom,
  ytext,
  provider,
  canEdit,
  currentUser,
  sessionAwarenessColor,
  roomEnded,
  setError,
}: UseMonacoEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const monacoRef = useRef<MonacoModule | null>(null)
  const editorInstanceRef = useRef<MonacoEditorInstance | null>(null)
  const modelRef = useRef<MonacoModelInstance | null>(null)
  const bindingRef = useRef<MonacoBinding | null>(null)
  const [isEditorReady, setIsEditorReady] = useState(false)

  const { theme } = useThemeStore()
  const { font, fontSize } = useFontStore()

  const destroyEditor = useCallback(() => {
    bindingRef.current?.destroy()
    bindingRef.current = null
    editorInstanceRef.current?.dispose()
    editorInstanceRef.current = null
    modelRef.current?.dispose()
    modelRef.current = null
    setIsEditorReady(false)
  }, [])

  useEffect(() => {
    if (!provider?.awareness) return

    const fallbackSeed = `${currentUser?.id ?? 'anonymous'}:${provider.awareness.clientID}`
    const fallbackColor = generateUserColor(fallbackSeed)
    const username = currentUser?.username ?? 'Anonymous'
    provider.awareness.setLocalStateField('user', {
      id: currentUser?.id,
      name: username,
      username,
      colorSlot: sessionAwarenessColor?.slot,
      color: sessionAwarenessColor?.color ?? fallbackColor.color,
      colorLight: sessionAwarenessColor?.colorLight ?? fallbackColor.colorLight,
    })
  }, [
    provider,
    currentUser?.id,
    currentUser?.username,
    sessionAwarenessColor?.slot,
    sessionAwarenessColor?.color,
    sessionAwarenessColor?.colorLight,
  ])

  const isMarkdownMode = effectiveRoom?.language === 'markdown'

  useEffect(() => {
    if (!effectiveRoom || !editorRef.current || !provider || !ytext || editorInstanceRef.current) return
    if (effectiveRoom.isEnded || roomEnded || isMarkdownMode) return

    let cancelled = false

    loadMonaco()
      .then(async (monaco) => {
        if (cancelled || !editorRef.current) return

        // Monaco caches glyph widths the first time it paints. If the web
        // font isn't loaded yet, it measures against a fallback and the
        // cached metrics never update — text ends up mispositioned even
        // after the real font arrives. Wait for font loading, with a hard
        // cap so a stalled fetch never blocks the editor from appearing.
        await Promise.race([
          document.fonts.ready,
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ])
        if (cancelled || !editorRef.current) return

        const mountNode = editorRef.current

        monacoRef.current = monaco
        const model = monaco.editor.createModel(
          ytext.toString(),
          resolveMonacoLanguage(effectiveRoom.language),
        )
        model.setEOL(monaco.editor.EndOfLineSequence.LF)
        modelRef.current = model

        const editor = monaco.editor.create(
          mountNode,
          createMonacoEditorOptions({
            model,
            fontFamily: fontFamilyStack(font),
            fontSize,
            theme,
            readOnly: !canEdit,
          }),
        )
        editorInstanceRef.current = editor

        // If fonts.ready timed out above, the real font may still arrive
        // afterwards; remeasure then so metrics match the displayed glyphs.
        document.fonts.ready
          .then(() => {
            if (cancelled) return
            monaco.editor.remeasureFonts()
          })
          .catch(() => {})

        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => {
          void editor.getAction('actions.find')?.run()
        })

        bindingRef.current = new MonacoBinding(
          monaco,
          ytext,
          model,
          new Set([editor]),
          provider.awareness ?? null,
        )

        editor.focus()
        setIsEditorReady(true)
      })
      .catch((err) => {
        console.error('Failed to initialize Monaco:', err)
        setError('Failed to initialize editor')
      })

    return () => {
      cancelled = true
      destroyEditor()
    }
  }, [
    effectiveRoom?.id,
    effectiveRoom?.isEnded,
    provider,
    ytext,
    roomEnded,
    isMarkdownMode,
    setError,
    destroyEditor,
  ])

  useEffect(() => {
    if (!monacoRef.current) return
    monacoRef.current.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
  }, [theme])

  useEffect(() => {
    const editor = editorInstanceRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return
    editor.updateOptions({
      fontFamily: fontFamilyStack(font),
      fontSize,
    })
    monaco.editor.remeasureFonts()
  }, [font, fontSize])

  useEffect(() => {
    editorInstanceRef.current?.updateOptions({ readOnly: !canEdit })
  }, [canEdit])

  const updateLanguage = useCallback((language: Language) => {
    if (!monacoRef.current || !modelRef.current) return
    monacoRef.current.editor.setModelLanguage(modelRef.current, resolveMonacoLanguage(language))
  }, [])

  return {
    editorRef,
    monacoRef,
    editorInstanceRef,
    modelRef,
    isEditorReady,
    updateLanguage,
  }
}
