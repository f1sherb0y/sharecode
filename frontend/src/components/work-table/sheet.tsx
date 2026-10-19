import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cn } from '@/lib/utils'

interface SheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Read by screen readers; shown when `title` is not hidden. */
  title: string
  hideTitle?: boolean
  /** Left and right of the title, like 取消 and an icon row. */
  start?: React.ReactNode
  end?: React.ReactNode
  children: React.ReactNode
  className?: string
}

/** A panel that slides up from the bottom on phones and sits in the middle on wider screens. */
export function Sheet({ open, onOpenChange, title, hideTitle, start, end, children, className }: SheetProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="wt-sheet-overlay" />
        <DialogPrimitive.Content className={cn('wt-sheet', className)} aria-describedby={undefined}>
          <div className="wt-sheet-grip" aria-hidden="true" />
          <div className={cn('wt-sheet-head', hideTitle && 'is-bare')}>
            <div className="wt-sheet-side">{start}</div>
            <DialogPrimitive.Title className={cn('wt-sheet-title', hideTitle && 'sr-only')}>{title}</DialogPrimitive.Title>
            <div className="wt-sheet-side is-end">{end}</div>
          </div>
          <div className="wt-sheet-body">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export const SheetClose = DialogPrimitive.Close
