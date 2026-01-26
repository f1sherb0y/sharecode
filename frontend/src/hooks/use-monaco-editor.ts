import { useRef, useEffect, useCallback } from 'react'
import { loadMonaco } from '@/lib/monaco-loader'
import { MonacoBinding } from '@/lib/monaco-binding'
import { useThemeStore, useFontStore } from '@/stores'
import { generateUserColor } from '@/lib/utils'
import type * as Monaco from 'monaco-editor'
import type { Room, Language, User } from '@/types'

type MonacoModule = typeof Monaco
type MonacoEditorInstance = Monaco.editor.IStandaloneCodeEditor
type MonacoModel = Monaco.editor.ITextModel

const monacoLanguageIds: Record<Language, string> = {
  javascript: 'javascript',
  typescript: 'typescript',
  python: 'python',
  java: 'java',
  cpp: 'cpp',
  rust: 'rust',
  go: 'go',
  php: 'php',
}

interface UseMonacoEditorProps {
  effectiveRoom: Room | null
  ytext: any // Y.Text
  provider: any // HocuspocusProvider
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
  setError
}: UseMonacoEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const monacoRef = useRef<MonacoModule | null>(null)
  const monacoEditorRef = useRef<MonacoEditorInstance | null>(null)
  const monacoModelRef = useRef<MonacoModel | null>(null)
  const bindingRef = useRef<MonacoBinding | null>(null)

  const { theme } = useThemeStore()
  const { font, fontSize } = useFontStore()

  // Initialize Monaco editor and bind Yjs
  useEffect(() => {
    if (!effectiveRoom || !editorRef.current || !provider || monacoEditorRef.current) return
    if (effectiveRoom.isEnded || roomEnded) return
    if (showGuestJoinForm) return

    let isCancelled = false

    loadMonaco()
      .then((monaco) => {
        if (isCancelled || !editorRef.current) return
        monacoRef.current = monaco

        const languageId = monacoLanguageIds[effectiveRoom.language] ?? 'javascript'
        const model = monaco.editor.createModel(ytext.toString(), languageId)
        model.setEOL(monaco.editor.EndOfLineSequence.LF)
        monacoModelRef.current = model

        const editor = monaco.editor.create(editorRef.current!, {
          model,
          automaticLayout: true,
          minimap: { enabled: false },
          wordWrap: 'on',
          readOnly: !canEdit,
          scrollBeyondLastLine: false,
          fontFamily: font,
          fontSize,
          theme: theme === 'dark' ? 'vs-dark' : 'vs',
          padding: { top: 16, bottom: 16 },
        })
        monacoEditorRef.current = editor

        // Create binding immediately after editor
        bindingRef.current = new MonacoBinding(
          editor,
          model,
          ytext,
          provider.awareness!,
          monaco
        )

        // Set local user in awareness
        const userColor = currentUser?.color || generateUserColor(currentUser?.id).color
        const userColorLight = generateUserColor(currentUser?.id).colorLight
        provider.awareness!.setLocalStateField('user', {
          id: currentUser?.id,
          username: currentUser?.username ?? 'Anonymous',
          color: userColor,
          colorLight: userColorLight,
        })

        editor.focus()
      })
      .catch((err) => {
        console.error('Failed to load Monaco:', err)
        setError('Failed to initialize editor')
      })

    return () => {
      isCancelled = true
    }
  }, [effectiveRoom, provider, ytext, currentUser, theme, font, fontSize, showGuestJoinForm, roomEnded, canEdit, setError])

  // Update Monaco theme when theme changes
  useEffect(() => {
    if (!monacoRef.current) return
    monacoRef.current.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
  }, [theme])

  // Update Monaco font settings
  useEffect(() => {
    if (!monacoEditorRef.current) return
    monacoEditorRef.current.updateOptions({ fontFamily: font, fontSize })
  }, [font, fontSize])

  // Update readOnly when canEdit changes
  useEffect(() => {
    if (!monacoEditorRef.current) return
    monacoEditorRef.current.updateOptions({ readOnly: !canEdit })
  }, [canEdit])

  // Handle language updates (for the editor model)
  const updateLanguage = useCallback((language: Language) => {
    if (monacoRef.current && monacoModelRef.current) {
      monacoRef.current.editor.setModelLanguage(
        monacoModelRef.current,
        monacoLanguageIds[language] ?? 'javascript'
      )
    }
  }, [])

  // Cleanup
  useEffect(() => {
    return () => {
      bindingRef.current?.destroy()
      monacoEditorRef.current?.dispose()
      monacoModelRef.current?.dispose()
    }
  }, [])

  return {
    editorRef,
    monacoRef,
    monacoEditorRef,
    monacoModelRef,
    updateLanguage
  }
}
