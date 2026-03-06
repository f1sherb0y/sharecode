import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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
  return new Date(date).toLocaleDateString()
}

export function formatDateMinutes(date: string | Date): string {
  const d = new Date(date)
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatDateTime(date: string | Date): string {
  return new Date(date).toLocaleString()
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const seconds = date.getSeconds().toString().padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}
