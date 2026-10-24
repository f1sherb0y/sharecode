import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { useSettingsStore } from '@/stores/settings'
import { getLocale } from '@/i18n'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Enter (or any key) that an input method is still composing with, as when Enter confirms
 * pinyin: it belongs to the input method, not to the field's own shortcuts.
 */
export function isComposing(event: { nativeEvent: KeyboardEvent; keyCode: number }): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229
}

export function getTimezone(): string {
  return useSettingsStore.getState().timezone
}

export function generateUserColor(identifier: string | number | undefined): {
  color: string
  colorLight: string
} {
  const key = String(identifier ?? 'anonymous')
  let hash = 0

  for (let i = 0; i < key.length; i++) {
    hash = (hash << 5) - hash + key.charCodeAt(i)
    hash |= 0
  }

  const hue = Math.abs(hash) % 360
  const saturation = 78
  const baseLightness = 52
  const highlightLightness = Math.min(baseLightness + 18, 72)

  return {
    color: `hsl(${hue}, ${saturation}%, ${baseLightness}%)`,
    colorLight: `hsla(${hue}, ${saturation}%, ${highlightLightness}%, 0.50)`,
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, exponent)
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

export function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString(getLocale(), { timeZone: getTimezone() })
}

export function formatDateMinutes(date: string | Date): string {
  const d = new Date(date)
  return d.toLocaleString(getLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: getTimezone(),
  })
}

/** Date and time to the minute; the audit log keeps the seconds. */
export function formatDateTime(date: string | Date): string {
  return formatDateMinutes(date)
}

export function formatDateTimeSeconds(date: string | Date): string {
  return new Date(date).toLocaleString(getLocale(), { timeZone: getTimezone() })
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString(getLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: getTimezone(),
  })
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall through to the legacy DOM copy path below.
    }
  }

  if (typeof document === 'undefined') {
    throw new Error('Clipboard is unavailable')
  }

  const textArea = document.createElement('textarea')
  textArea.value = text
  textArea.setAttribute('readonly', '')
  textArea.style.position = 'fixed'
  textArea.style.top = '0'
  textArea.style.left = '0'
  textArea.style.opacity = '0'
  textArea.style.pointerEvents = 'none'

  document.body.appendChild(textArea)
  textArea.focus()
  textArea.select()
  textArea.setSelectionRange(0, textArea.value.length)

  const copied = document.execCommand('copy')
  document.body.removeChild(textArea)

  if (!copied) {
    throw new Error('Clipboard copy failed')
  }
}
