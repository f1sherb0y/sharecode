import * as React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Button } from './button'

export interface TourStep {
  /** The `data-tour` value of the element to point at; without one the card sits in the middle. */
  target: string
  title: string
  body: string
}

interface TourProps {
  steps: TourStep[]
  index: number
  onIndexChange: (index: number) => void
  /** Skipped, or finished on the last step. */
  onClose: () => void
}

interface Box { top: number; left: number; width: number; height: number }

const GAP = 8
const MARGIN = 8

function targetBox(target: string): Box | null {
  const element = document.querySelector<HTMLElement>(`[data-tour="${target}"]`)
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  // Only the part inside the window counts, so a tall calendar stays in view.
  const top = Math.max(rect.top, 0)
  const bottom = Math.min(rect.bottom, window.innerHeight)
  const left = Math.max(rect.left, 0)
  const right = Math.min(rect.right, window.innerWidth)
  return { top, left, width: Math.max(right - left, 0), height: Math.max(bottom - top, 0) }
}

const sameBox = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height)

/** A step-by-step tour that dims the page and points at one element per step. */
export function Tour({ steps, index, onIndexChange, onClose }: TourProps) {
  const { t } = useTranslation()
  const step = steps[index]!
  const last = index === steps.length - 1
  const [box, setBox] = React.useState<Box | null>(null)
  const [cardHeight, setCardHeight] = React.useState(0)
  const cardRef = React.useRef<HTMLDivElement>(null)
  const nextRef = React.useRef<HTMLButtonElement>(null)
  const titleId = React.useId()

  // The target may render a moment after the step changes it into view, and it
  // moves with scrolling and resizing: follow it every frame.
  React.useEffect(() => {
    let frame = 0
    let scrolled = false
    const follow = () => {
      if (!scrolled) {
        const element = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
        if (element) {
          element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          scrolled = true
        }
      }
      const next = targetBox(step.target)
      setBox(current => (sameBox(current, next) ? current : next))
      frame = requestAnimationFrame(follow)
    }
    follow()
    return () => cancelAnimationFrame(frame)
  }, [step.target])

  React.useLayoutEffect(() => {
    setCardHeight(cardRef.current?.offsetHeight ?? 0)
  }, [index, box?.width])

  React.useEffect(() => { nextRef.current?.focus() }, [index])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'Tab') {
      // Keep focus on the card while the page underneath is dimmed.
      const buttons = [...(cardRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      const position = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.shiftKey ? (position <= 0 ? buttons.length - 1 : position - 1) : (position + 1) % buttons.length
      event.preventDefault()
      buttons[next]?.focus()
    }
  }

  const width = Math.min(320, window.innerWidth - MARGIN * 2)
  let position: React.CSSProperties
  if (box && box.width > 0 && box.height > 0) {
    const below = box.top + box.height + GAP
    const above = box.top - GAP - cardHeight
    const top = below + cardHeight <= window.innerHeight - MARGIN ? below
      : above >= MARGIN ? above
      : window.innerHeight - MARGIN - cardHeight
    const left = Math.min(Math.max(box.left + box.width / 2 - width / 2, MARGIN), window.innerWidth - MARGIN - width)
    position = { top, left, width }
  } else {
    position = { top: '50%', left: '50%', width, transform: 'translate(-50%, -50%)' }
  }

  return createPortal(
    <div className="ui-tour" onKeyDown={onKeyDown}>
      {box && box.width > 0 && box.height > 0 ? (
        <div
          className="ui-tour-spotlight"
          style={{ top: box.top - 4, left: box.left - 4, width: box.width + 8, height: box.height + 8 }}
          aria-hidden="true"
        />
      ) : (
        <div className="ui-tour-backdrop" aria-hidden="true" />
      )}
      <div ref={cardRef} className="ui-tour-card" style={position} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="flex items-baseline justify-between gap-2">
          <h2 id={titleId} className="ui-card-title text-base font-semibold">{step.title}</h2>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {t('tour.progress', { current: index + 1, total: steps.length })}
          </span>
        </div>
        <p className="text-sm">{step.body}</p>
        <div className="flex items-center gap-1 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('tour.skip')}</Button>
          <span className="flex-1" />
          {index > 0 && (
            <Button variant="outline" size="sm" onClick={() => onIndexChange(index - 1)}>{t('tour.previous')}</Button>
          )}
          <Button ref={nextRef} size="sm" onClick={() => (last ? onClose() : onIndexChange(index + 1))}>
            {last ? t('tour.done') : t('tour.next')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
