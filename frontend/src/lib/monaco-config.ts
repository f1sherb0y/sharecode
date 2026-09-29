import type * as Monaco from 'monaco-editor'

import type { Language } from '@/types'

export const MONACO_LANGUAGE_IDS: Record<Language, string> = {
  javascript: 'javascript',
  typescript: 'typescript',
  python: 'python',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  rust: 'rust',
  go: 'go',
  php: 'php',
  markdown: 'markdown',
  verilog: 'systemverilog',
}

export const resolveMonacoLanguage = (language?: Language) => {
  return MONACO_LANGUAGE_IDS[language ?? 'javascript'] ?? 'javascript'
}

interface CreateMonacoEditorOptionsProps {
  model: Monaco.editor.ITextModel
  fontFamily: string
  fontSize: number
  theme: 'light' | 'dark'
  readOnly: boolean
}

export const createMonacoEditorOptions = ({
  model,
  fontFamily,
  fontSize,
  theme,
  readOnly,
}: CreateMonacoEditorOptionsProps): Monaco.editor.IStandaloneEditorConstructionOptions => ({
  model,
  automaticLayout: true,
  minimap: { enabled: false },
  // The runner owns the pane divider; Monaco's ruler border sits before the scrollbar.
  overviewRulerBorder: false,
  selectionHighlight: false,
  occurrencesHighlight: 'off',
  wordWrap: 'on',
  wrappingStrategy: 'advanced',
  scrollBeyondLastLine: false,
  quickSuggestions: { other: true, comments: false, strings: false },
  wordBasedSuggestions: 'currentDocument',
  fontFamily,
  fontSize,
  lineHeight: 1.4,
  lineNumbersMinChars: 3,
  lineDecorationsWidth: 8,
  padding: { top: 4, bottom: 4 },
  tabSize: 4,
  insertSpaces: true,
  theme: theme === 'dark' ? 'vs-dark' : 'vs',
  readOnly,
})
