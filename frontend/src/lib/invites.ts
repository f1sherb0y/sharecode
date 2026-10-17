import { isTauriApp } from '@/lib/tauri'
import type { RegistrationInvite } from '@/types'

/** Shows a code as XXXX-XXXX-XXXX; the server accepts any case and separators. */
export function formatInviteCode(code: string): string {
  const raw = code.toUpperCase().replace(/[^0-9A-Z]/g, '')
  return raw.match(/.{1,4}/g)?.join('-') ?? ''
}

/** The registration link that pre-fills the code. */
export function inviteLink(invite: RegistrationInvite): string {
  if (!isTauriApp()) return `${window.location.origin}/register?invite=${invite.code}`
  if (invite.inviteUrl && /^https?:\/\//.test(invite.inviteUrl)) return invite.inviteUrl
  return ''
}
