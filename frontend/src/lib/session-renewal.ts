import { useAuthStore } from '@/stores/auth'
import { getApiBaseUrl } from '@/api/client'
import type { AuthResponse } from '@/types'

const RENEW_WINDOW_SECONDS = 2 * 60
let pending: { token: string; request: Promise<string> } | undefined

export function tokenIdentity(token: string): { type?: string; userId?: string; sessionId?: string } {
  try { return JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) }
  catch { return {} }
}

export async function restoreBrowserSession(token?: string, browserSessionId?: string | null): Promise<AuthResponse> {
  const response = await fetch(`${getApiBaseUrl()}/api/auth/refresh`, {
    method: 'POST', credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    headers: { 'X-Sharecode-Client': 'web', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(browserSessionId ? { 'X-Session-Id': browserSessionId } : {}) },
  })
  if (!response.ok) throw Object.assign(new Error('Could not restore login session'), { status: response.status })
  const data = await response.json() as AuthResponse
  if (!data.user?.id || !data.token || !data.browserSessionId) throw new Error('Invalid session response')
  return data
}

// Scheduling only: the server alone validates signatures, expiry and revocation.
export function tokenExpiry(token: string): number | null {
  try {
    const payload = token.split('.')[1]!
    const exp: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null
  } catch { return null }
}

/** Renew active user sessions before expiry. Single flight per credential;
 * a late response cannot replace a login from another account or a logout. */
export async function ensureFreshSession(options: { throwOnFailure?: boolean } = {}): Promise<string | null> {
  const { token, actorType } = useAuthStore.getState()
  if (!token || actorType !== 'user') return token
  const expiry = tokenExpiry(token)
  if (expiry === null || expiry - Date.now() / 1000 > RENEW_WINDOW_SECONDS) return token
  const result = (request: Promise<string>) => options.throwOnFailure ? request : request.catch(() => token)
  if (pending?.token === token) return result(pending.request)
  const request = (async () => {
    try {
      const data = await restoreBrowserSession(token, useAuthStore.getState().browserSessionId)
      if (typeof data.token !== 'string' || tokenExpiry(data.token) === null) return token
      useAuthStore.getState().renewToken(token, data.token, data.browserSessionId)
      return useAuthStore.getState().token ?? token
    } finally { if (pending?.token === token) pending = undefined }
  })()
  pending = { token, request }
  // Background callers retain their current credential on transient failures;
  // collaboration recovery needs to distinguish those from a revoked session.
  return result(request)
}
