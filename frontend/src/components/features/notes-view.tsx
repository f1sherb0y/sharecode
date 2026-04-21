import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, X, Loader2, Pencil, Copy, Check, ClipboardCopy } from 'lucide-react'
import { Button, Textarea, Spinner } from '@/components/ui'
import { api } from '@/api'
import { queryKeys } from '@/lib/query-keys'
import { cn, copyTextToClipboard, getTimezone } from '@/lib/utils'

function formatNoteTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const tz = getTimezone()
  const fmt = new Intl.DateTimeFormat(undefined, { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
  const dParts = fmt.formatToParts(d)
  const nowParts = fmt.formatToParts(now)
  const get = (parts: Intl.DateTimeFormatPart[], type: string) => parts.find(p => p.type === type)?.value
  const sameYear = get(dParts, 'year') === get(nowParts, 'year')
  const sameDay = sameYear && get(dParts, 'month') === get(nowParts, 'month') && get(dParts, 'day') === get(nowParts, 'day')
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: tz })
  if (sameDay) return time
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: tz })
  return `${date} ${time}`
}

interface NotesViewProps {
  roomId: string
  readOnly?: boolean
}

export function NotesView({ roomId, readOnly = false }: NotesViewProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [newText, setNewText] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [copiedAll, setCopiedAll] = useState(false)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const newRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const { data: notes = [], isLoading } = useQuery({
    queryKey: queryKeys.notes(roomId),
    queryFn: async () => {
      const { notes } = await api.getNotes(roomId)
      return notes
    },
    enabled: !!roomId,
  })

  const addNoteMutation = useMutation({
    mutationFn: async (text: string) => {
      const { note } = await api.createNote(roomId, text)
      return note
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.notes(roomId) })
    },
  })

  const updateNoteMutation = useMutation({
    mutationFn: async ({ noteId, text }: { noteId: string; text: string }) => {
      const { note } = await api.updateNote(roomId, noteId, text)
      return note
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.notes(roomId) })
    },
  })

  const removeNoteMutation = useMutation({
    mutationFn: async (noteId: string) => {
      await api.deleteNote(roomId, noteId)
      return noteId
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.notes(roomId) })
    },
  })

  const isSaving =
    addNoteMutation.isPending || updateNoteMutation.isPending || removeNoteMutation.isPending

  const handleAdd = useCallback(async () => {
    if (!newText.trim() || isSaving) return
    try {
      await addNoteMutation.mutateAsync(newText.trim())
      setNewText('')
      requestAnimationFrame(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
      })
    } catch {
      // keep text so user can retry
    }
  }, [newText, addNoteMutation, isSaving])

  const handleNewKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Cmd/Ctrl+Enter to submit, plain Enter for newlines
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleAdd()
    }
  }, [handleAdd])

  const startEdit = useCallback((id: string, text: string) => {
    if (readOnly) return
    setEditingId(id)
    setEditText(text)
  }, [readOnly])

  const commitEdit = useCallback(async () => {
    if (editingId && editText.trim()) {
      try {
        await updateNoteMutation.mutateAsync({ noteId: editingId, text: editText.trim() })
      } catch {
        // ignore
      }
    }
    setEditingId(null)
    setEditText('')
  }, [editingId, editText, updateNoteMutation])

  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setEditText('')
  }, [])

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      commitEdit()
    } else if (e.key === 'Escape') {
      cancelEdit()
    }
  }, [commitEdit, cancelEdit])

  const handleRemove = useCallback(async (noteId: string) => {
    if (isSaving) return
    try {
      await removeNoteMutation.mutateAsync(noteId)
    } catch {
      // ignore
    }
  }, [removeNoteMutation, isSaving])

  const handleCopy = useCallback(async (noteId: string, text: string) => {
    try {
      await copyTextToClipboard(text)
      setCopiedId(noteId)
      setTimeout(() => setCopiedId((prev) => (prev === noteId ? null : prev)), 1500)
    } catch {
      // ignore
    }
  }, [])

  const handleCopyAll = useCallback(async () => {
    if (notes.length === 0) return
    const sorted = [...notes].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    const text = sorted.map((n) => n.text).join('\n')
    try {
      await copyTextToClipboard(text)
      setCopiedAll(true)
      setTimeout(() => setCopiedAll(false), 1500)
    } catch {
      // ignore
    }
  }, [notes])

  useEffect(() => {
    if (editingId && editRef.current) {
      editRef.current.focus()
      editRef.current.setSelectionRange(editRef.current.value.length, editRef.current.value.length)
    }
  }, [editingId])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size="sm" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Copy all button */}
      {notes.length > 0 && (
        <div className="shrink-0 flex justify-end px-0.5 pb-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={handleCopyAll}
          >
            {copiedAll ? (
              <Check className="h-2.5 w-2.5 mr-1 text-success" />
            ) : (
              <ClipboardCopy className="h-2.5 w-2.5 mr-1" />
            )}
            {copiedAll ? t('notes.copiedAll') : t('notes.copyAll')}
          </Button>
        </div>
      )}
      {/* Notes list */}
      <div ref={listRef} className="flex-1 overflow-y-auto min-h-0 space-y-1">
        {notes.length === 0 ? (
          <p className="text-xs text-muted-foreground px-1 py-1">{t('notes.empty')}</p>
        ) : (
          notes.map((note) => (
            <div
              key={note.id}
              className="group rounded-md border bg-muted/30 transition-colors hover:bg-muted/50"
            >
              {editingId === note.id ? (
                <div className="p-1 space-y-0.5">
                  <Textarea
                    ref={editRef}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={handleEditKeyDown}
                    className="text-xs min-h-[2.5rem] resize-none"
                    rows={Math.min(8, editText.split('\n').length + 1)}
                  />
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1.5 text-[10px]"
                      onClick={cancelEdit}
                    >
                      {t('common.cancel')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-5 px-1.5 text-[10px]"
                      onClick={commitEdit}
                      disabled={!editText.trim() || isSaving}
                    >
                      {t('common.save')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="relative px-1.5 py-1">
                  <pre className={cn(
                    'text-xs text-foreground whitespace-pre-wrap break-words font-sans leading-normal pr-12',
                    !readOnly && 'cursor-pointer'
                  )}
                    onClick={() => startEdit(note.id, note.text)}
                  >
                    {note.text}
                  </pre>
                  <span className="text-[10px] text-muted-foreground leading-none mt-0.5 block">
                    {formatNoteTime(note.updatedAt !== note.createdAt ? note.updatedAt : note.createdAt)}
                  </span>
                  <div className={cn(
                      'absolute top-0.5 right-0.5 flex items-center gap-0.5',
                      'opacity-0 group-hover:opacity-100 transition-opacity'
                    )}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                        onClick={() => handleCopy(note.id, note.text)}
                      >
                        {copiedId === note.id ? (
                          <Check className="h-2.5 w-2.5 text-success" />
                        ) : (
                          <Copy className="h-2.5 w-2.5" />
                        )}
                      </Button>
                      {!readOnly && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                            onClick={() => startEdit(note.id, note.text)}
                          >
                            <Pencil className="h-2.5 w-2.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => handleRemove(note.id)}
                            disabled={isSaving}
                          >
                            <X className="h-2.5 w-2.5" />
                          </Button>
                        </>
                      )}
                    </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Add note input */}
      {!readOnly && (
        <div className="shrink-0 border-t pt-1 mt-0.5 space-y-0.5">
          <Textarea
            ref={newRef}
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={handleNewKeyDown}
            placeholder={t('notes.placeholder')}
            className="text-xs min-h-[2rem] resize-none"
            rows={Math.min(5, Math.max(2, newText.split('\n').length))}
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">{t('notes.submitHint')}</span>
            <Button
              variant="secondary"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={handleAdd}
              disabled={!newText.trim() || isSaving}
            >
              {isSaving ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Plus className="h-3 w-3 mr-1" />
              )}
              {t('notes.add')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
