import { useEffect, useRef, useCallback } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { php } from '@codemirror/lang-php'
import { go } from '@codemirror/lang-go'
import { markdown } from '@codemirror/lang-markdown'
import { StreamLanguage } from '@codemirror/language'
import { verilog } from '@codemirror/legacy-modes/mode/verilog'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode'
import { useThemeStore, useFontStore } from '@/stores'
import { generateUserColor } from '@/lib/utils'
import type { Room, Language, User } from '@/types'

// Note: CodeMirror doesn't have a dedicated TypeScript language package,
// it uses the javascript package with typescript set to true.
const languageExtensions: Record<string, any> = {
  javascript: javascript(),
  typescript: javascript({ typescript: true }),
  python: python(),
  java: java(),
  cpp: cpp(),
  rust: rust(),
  go: go(),
  php: php(),
  markdown: markdown(),
  verilog: StreamLanguage.define(verilog),
}

interface UseCodeMirrorEditorProps {
  effectiveRoom: Room | null
  ytext: any // Y.Text
  provider: any // HocuspocusProvider
  canEdit: boolean
  currentUser: (User | { id: string; username: string; color: string }) | null
  roomEnded: boolean
  showGuestJoinForm: boolean
  setError: (error: string) => void
}

export function useCodeMirrorEditor({
  effectiveRoom,
  ytext,
  provider,
  canEdit,
  currentUser,
  roomEnded,
  showGuestJoinForm,
  setError
}: UseCodeMirrorEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  
  // Compartments allow dynamic reconfiguration of extensions
  const languageCompartment = useRef(new Compartment())
  const themeCompartment = useRef(new Compartment())
  const fontCompartment = useRef(new Compartment())
  const editableCompartment = useRef(new Compartment())

  const { theme } = useThemeStore()
  const { font, fontSize } = useFontStore()

  // Initialize CodeMirror editor
  useEffect(() => {
    if (!effectiveRoom || !editorRef.current || !provider || viewRef.current) return
    if (effectiveRoom.isEnded || roomEnded) return
    if (showGuestJoinForm) return

    try {
      // Set local user in awareness
      const userColor = currentUser?.color || generateUserColor(currentUser?.id).color
      const userColorLight = generateUserColor(currentUser?.id).colorLight
      provider.awareness.setLocalStateField('user', {
        id: currentUser?.id,
        name: currentUser?.username ?? 'Anonymous', // y-codemirror.next expects 'name'
        color: userColor,
        colorLight: userColorLight,
      })

      const languageExt = languageExtensions[effectiveRoom.language] ?? javascript()
      
      const fontExt = EditorView.theme({
        "&": {
          height: "100%",
        },
        ".cm-scroller": {
           fontFamily: `${font}, monospace`,
           fontSize: `${fontSize}px`,
           paddingTop: "16px",
           paddingBottom: "16px",
        },
        ".cm-content": {
          fontFamily: `${font}, monospace`,
        }
      })

      const state = EditorState.create({
        doc: ytext.toString(),
        extensions: [
          basicSetup,
          keymap.of([...yUndoManagerKeymap]),
          EditorView.lineWrapping,
          languageCompartment.current.of(languageExt),
          themeCompartment.current.of(theme === 'dark' ? vscodeDark : vscodeLight),
          fontCompartment.current.of(fontExt),
          editableCompartment.current.of(EditorView.editable.of(canEdit)),
          yCollab(ytext, provider.awareness)
        ]
      })

      const view = new EditorView({
        state,
        parent: editorRef.current
      })

      viewRef.current = view
    } catch (err) {
      console.error('Failed to initialize CodeMirror:', err)
      setError('Failed to initialize editor')
    }

    return () => {
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [effectiveRoom, provider, ytext, currentUser, showGuestJoinForm, roomEnded, setError]) // Note: excluding theme/font/canEdit to prevent full re-init

  // Update theme dynamically
  useEffect(() => {
    if (!viewRef.current) return
    
    viewRef.current.dispatch({
      effects: themeCompartment.current.reconfigure(theme === 'dark' ? vscodeDark : vscodeLight)
    })
  }, [theme])

  // Update font dynamically
  useEffect(() => {
    if (!viewRef.current) return
    
    const fontExt = EditorView.theme({
        "&": {
          height: "100%",
        },
        ".cm-scroller": {
           fontFamily: `${font}, monospace`,
           fontSize: `${fontSize}px`,
           paddingTop: "16px",
           paddingBottom: "16px",
        },
        ".cm-content": {
          fontFamily: `${font}, monospace`,
        }
      })

    viewRef.current.dispatch({
      effects: fontCompartment.current.reconfigure(fontExt)
    })
  }, [font, fontSize])

  // Update readOnly (editable) dynamically
  useEffect(() => {
    if (!viewRef.current) return
    viewRef.current.dispatch({
      effects: editableCompartment.current.reconfigure(EditorView.editable.of(canEdit))
    })
  }, [canEdit])

  // Handle language updates dynamically
  const updateLanguage = useCallback((language: Language) => {
    if (!viewRef.current) return
    const ext = languageExtensions[language] ?? javascript()
    viewRef.current.dispatch({
      effects: languageCompartment.current.reconfigure(ext)
    })
  }, [])

  return {
    editorRef,
    viewRef,
    updateLanguage
  }
}
