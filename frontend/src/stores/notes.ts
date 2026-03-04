import { create } from 'zustand'
import { api } from '@/api'
import type { Note } from '@/types'

interface NotesState {
  notes: Note[]
  isLoading: boolean
  fetchNotes: (roomId: string) => Promise<void>
  addNote: (roomId: string, text: string) => Promise<void>
  updateNote: (roomId: string, noteId: string, text: string) => Promise<void>
  removeNote: (roomId: string, noteId: string) => Promise<void>
}

export const useNotesStore = create<NotesState>()((set) => ({
  notes: [],
  isLoading: false,

  fetchNotes: async (roomId: string) => {
    set({ isLoading: true })
    try {
      const { notes } = await api.getNotes(roomId)
      set({ notes })
    } catch {
      set({ notes: [] })
    } finally {
      set({ isLoading: false })
    }
  },

  addNote: async (roomId: string, text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const { note } = await api.createNote(roomId, trimmed)
    set((state) => ({ notes: [...state.notes, note] }))
  },

  updateNote: async (roomId: string, noteId: string, text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const { note } = await api.updateNote(roomId, noteId, trimmed)
    set((state) => ({
      notes: state.notes.map((n) => (n.id === noteId ? note : n)),
    }))
  },

  removeNote: async (roomId: string, noteId: string) => {
    await api.deleteNote(roomId, noteId)
    set((state) => ({
      notes: state.notes.filter((n) => n.id !== noteId),
    }))
  },
}))
