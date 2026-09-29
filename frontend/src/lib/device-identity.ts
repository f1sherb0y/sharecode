// Browser identity is advisory audit data, never an authentication credential.
const KEY = 'sharecode-device-id'
let deviceId: string | undefined
let fingerprint: string | undefined
let initialization: Promise<void> | undefined

function getDeviceId(): string | undefined {
  if (deviceId) return deviceId
  try {
    const stored = localStorage.getItem(KEY)
    deviceId = stored && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(stored) ? stored : crypto.randomUUID()
    localStorage.setItem(KEY, deviceId)
  } catch {
    // Storage may be disabled; keep the ID for this tab's lifetime.
    deviceId ??= globalThis.crypto?.randomUUID?.()
  }
  return deviceId
}

function initialize(): Promise<void> {
  return initialization ??= import('@fingerprintjs/fingerprintjs')
    .then(fp => fp.load({ monitoring: false }))
    .then(agent => agent.get())
    .then(result => { fingerprint = `fp5:${result.visitorId}` })
    .catch(() => { /* Privacy protection must not prevent sign-in. */ })
}

export async function deviceHeaders(waitForFingerprint = false): Promise<Record<string, string>> {
  const id = getDeviceId()
  if (waitForFingerprint) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([initialize(), new Promise<void>(resolve => { timer = setTimeout(resolve, 1500) })])
    clearTimeout(timer)
  }
  return { ...(id ? { 'X-Device-Id': id } : {}), ...(fingerprint ? { 'X-Device-Fingerprint': fingerprint } : {}) }
}
