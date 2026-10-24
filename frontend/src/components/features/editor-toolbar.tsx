import { createContext, useContext, type ComponentProps } from 'react'
import { createPortal } from 'react-dom'

/** Desktop shells may host the room toolbar in their own title bar. The web keeps it inline. */
export const EditorToolbarTarget = createContext<HTMLElement | null>(null)

export function EditorToolbar({ children, ...props }: ComponentProps<'header'>) {
  const target = useContext(EditorToolbarTarget)
  const header = <header {...props} data-tauri-drag-region={target ? true : undefined}>{children}</header>
  return target ? createPortal(header, target) : header
}
