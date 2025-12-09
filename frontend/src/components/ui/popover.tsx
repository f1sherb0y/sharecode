import * as React from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

interface PopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

interface PopoverTriggerProps {
  asChild?: boolean
  children: React.ReactNode
}

interface PopoverContentProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: 'start' | 'center' | 'end'
}

const PopoverContext = React.createContext<{
  open: boolean
  onOpenChange: (open: boolean) => void
  triggerRef: React.RefObject<HTMLSpanElement | null>
}>({
  open: false,
  onOpenChange: () => {},
  triggerRef: { current: null },
})

function Popover({ open, onOpenChange, children }: PopoverProps) {
  const triggerRef = React.useRef<HTMLSpanElement>(null)
  return (
    <PopoverContext.Provider value={{ open, onOpenChange, triggerRef }}>
      <div className="relative">{children}</div>
    </PopoverContext.Provider>
  )
}

function PopoverTrigger({ children }: PopoverTriggerProps) {
  const { open, onOpenChange, triggerRef } = React.useContext(PopoverContext)

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onOpenChange(!open)
  }

  return (
    <span ref={triggerRef} onClick={handleClick} className="inline-block cursor-pointer">
      {children}
    </span>
  )
}

function PopoverContent({ className, align = 'center', children, ...props }: PopoverContentProps) {
  const { open, onOpenChange, triggerRef } = React.useContext(PopoverContext)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [position, setPosition] = React.useState({ top: 0, left: 0 })

  React.useEffect(() => {
    if (!open || !triggerRef.current) return

    const trigger = triggerRef.current
    const rect = trigger.getBoundingClientRect()

    let left = rect.left
    if (align === 'center') {
      left = rect.left + rect.width / 2
    } else if (align === 'end') {
      left = rect.right
    }

    setPosition({
      top: rect.bottom + 8,
      left,
    })
  }, [open, align, triggerRef])

  React.useEffect(() => {
    if (!open) return

    const handleClickOutside = (event: MouseEvent) => {
      if (
        contentRef.current &&
        !contentRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        onOpenChange(false)
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false)
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open, onOpenChange, triggerRef])

  if (!open) return null

  return createPortal(
    <div
      ref={contentRef}
      className={cn('fixed z-50', className)}
      style={{
        top: position.top,
        left: position.left,
        transform: align === 'center' ? 'translateX(-50%)' : align === 'end' ? 'translateX(-100%)' : undefined,
      }}
      {...props}
    >
      {children}
    </div>,
    document.body
  )
}

export { Popover, PopoverTrigger, PopoverContent }
