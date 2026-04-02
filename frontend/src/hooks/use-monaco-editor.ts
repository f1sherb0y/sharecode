import { useEffect, useRef, useCallback, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { useThemeStore, useFontStore } from '@/stores'
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
  ytext: any
  provider: any
  canEdit: boolean
  currentUser: (User | { id: string; username: string; color: string }) | null
  roomEnded: boolean
  showGuestJoinForm: boolean
  setError: (error: string) => void
}

export function useMonacoEditor({
  effectiveRoom,
  ytext,
  provider,
  canEdit,
  currentUser,
  roomEnded,
  showGuestJoinForm,
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

    const userColor = currentUser?.color || generateUserColor(currentUser?.id).color
    const userColorLight = generateUserColor(currentUser?.id).colorLight
    provider.awareness.setLocalStateField('user', {
      id: currentUser?.id,
      name: currentUser?.username ?? 'Anonymous',
      color: userColor,
      colorLight: userColorLight,
    })
  }, [provider, currentUser?.id, currentUser?.username, currentUser?.color])

  useEffect(() => {
    if (!effectiveRoom || !editorRef.current || !provider || editorInstanceRef.current) return
    if (effectiveRoom.isEnded || roomEnded || showGuestJoinForm) return

    let cancelled = false

    loadMonaco()
      .then((monaco) => {
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
            font,
            fontSize,
            theme,
            readOnly: !canEdit,
          }),
        )
        editorInstanceRef.current = editor

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
    showGuestJoinForm,
    roomEnded,
    setError,
    destroyEditor,
  ])

  useEffect(() => {
    if (!monacoRef.current) return
    monacoRef.current.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
  }, [theme])

  useEffect(() => {
    editorInstanceRef.current?.updateOptions({
      fontFamily: `${font}, monospace`,
      fontSize,
    })
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
