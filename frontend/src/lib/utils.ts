import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { useSettingsStore } from '@/stores/settings'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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
  const highlightLightness = Math.min(baseLightness + 20, 88)

  return {
    color: `hsl(${hue}, ${saturation}%, ${baseLightness}%)`,
    colorLight: `hsla(${hue}, ${saturation}%, ${highlightLightness}%, 0.35)`,
  }
}

export function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString(undefined, { timeZone: getTimezone() })
}

export function formatDateMinutes(date: string | Date): string {
  const d = new Date(date)
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: getTimezone(),
  })
}

export function formatDateTime(date: string | Date): string {
  return new Date(date).toLocaleString(undefined, { timeZone: getTimezone() })
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: getTimezone(),
  })
}
