// Disposable local API only: verify multi-device sessions and renewal while editing.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { chromium } from 'playwright'
import { createServer } from 'vite'
const API = 'http://127.0.0.1:55460'
const password = 'LocalAudit#2026Strong'
const cookies = new Map()
const wait = async (fn, message, timeout = 20000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 30)) }
  throw Error(message)
}
async function request(path, method = 'GET', body, token, status = 200, includeCookie = true) {
  let sid
  try { sid = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sessionId } catch {}
  const response = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', 'X-Sharecode-Client': 'web', ...(includeCookie && cookies.has(sid) ? { Cookie: cookies.get(sid) } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json()
  assert.equal(response.status, status, `${path}: ${JSON.stringify(data)}`)
  if (data.browserSessionId && response.headers.get('set-cookie')) cookies.set(data.browserSessionId, response.headers.get('set-cookie').split(';')[0])
  return data
}
const login = () => request('/api/auth/login', 'POST', { username: 'audit_admin', password })
const signWithExpiry = (token, seconds, patch = {}) => {
  const [header, payload] = token.split('.')
  const claims = { ...JSON.parse(Buffer.from(payload, 'base64url')), exp: Math.floor(Date.now()/1000) + seconds, ...patch }
  const data = header + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url')
  return data + '.' + createHmac('sha256', 'local-runner-test-key-not-production').update(data).digest('base64url')
}
const first = await login()
const room = (await request('/api/rooms', 'POST', { name: 'renewal fixtures', language: 'python' }, first.token, 201)).room
const second = await login()
await request('/api/auth/profile', 'GET', undefined, first.token)
const peers = []
function peer(token) {
  const doc = new Y.Doc(), state = { token, auth: 0, denied: false, closed: 0 }
  const provider = new HocuspocusProvider({ url: API.replace('http', 'ws') + '/api/ws', name: room.id, document: doc, token: () => state.token,
    onAuthenticated: () => state.auth++, onAuthenticationFailed: () => { state.denied = true; provider.disconnect() }, onClose: () => state.closed++ })
  peers.push({ provider, doc }); return { provider, doc, state }
}
let browser, server
try {
  const a = peer(signWithExpiry(first.token, 5)), b = peer(second.token)
  await wait(() => a.provider.synced && b.provider.synced, 'both devices sync')
  a.doc.getText('codemirror').insert(0, 'before renewal\n')
  await wait(() => b.doc.getText('codemirror').toString().includes('before renewal'), 'same-account devices share edits')
  const renewed = await request('/api/auth/refresh', 'POST', undefined, a.state.token)
  const socket = a.provider.configuration.websocketProvider.webSocket
  a.state.token = renewed.token
  await a.provider.sendToken()
  await wait(() => a.state.auth === 2, 'renewal reauth acknowledgement')
  assert.equal(a.provider.configuration.websocketProvider.webSocket, socket)
  await new Promise(r => setTimeout(r, 5500))
  a.doc.getText('codemirror').insert(a.doc.getText('codemirror').length, 'after old expiry\n')
  await wait(() => b.doc.getText('codemirror').toString().includes('after old expiry'), 'editing survives original expiry')
  assert.equal(a.state.denied, false); assert.equal(a.state.closed, 0); assert.equal(b.state.closed, 0)
  console.log('PASS multi-device login and in-place WebSocket renewal past the original expiry')
  const sql = query => execFileSync('docker', ['exec', process.env.SHARECODE_TEST_CONTAINER, 'psql', '-U', 'runner_test', '-d', 'runner_test', '-v', 'ON_ERROR_STOP=1', '-c', query], { stdio: 'pipe' })
  let retryPeer
  sql('ALTER TABLE "User" RENAME TO "UserDuringOutage"')
  try {
    retryPeer = peer(second.token)
    await wait(() => retryPeer.state.closed > 0, 'temporary auth DB failure closes socket')
    assert.equal(retryPeer.state.denied, false, 'DB outage must not become a permanent access denial')
  } finally { sql('ALTER TABLE "UserDuringOutage" RENAME TO "User"') }
  await wait(() => retryPeer.provider.synced, 'transient auth failure recovers automatically')
  console.log('PASS database auth outage retries automatically without login or permission bypass')


  server = await createServer({ server: { host: '127.0.0.1', port: 55461, strictPort: true, proxy: { '/api': { target: API, ws: true } } }, logLevel: 'error' })
  await server.listen(); browser = await chromium.launch()
  const context = await browser.newContext()
  const [name, value] = cookies.get(first.browserSessionId).split('=')
  await context.addCookies([{ name, value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now()/1000 + 86400 }])
  // A broken font CDN must not prevent editing or synchronization.
  await context.route('https://cdn.jsdelivr.net/**', route => route.abort())
  const page = await context.newPage()
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto('http://127.0.0.1:55461/login')
  await page.evaluate(token => {
    sessionStorage.setItem('sharecode-tab-auth', JSON.stringify({ state: { token }, version: 0 }))
    localStorage.setItem('i18nextLng', 'en')
  }, first.token)
  await page.goto('http://127.0.0.1:55461/room/' + room.id)
  await page.locator('.monaco-editor').waitFor()
  await page.waitForFunction(() => document.body.textContent.includes('Saved'))
  await page.evaluate(async () => {
    const { loadMonaco } = await import('/src/lib/monaco-loader.ts')
    const m = await loadMonaco(); window.originalModel = m.editor.getModels()[0]; window.originalEditor = document.querySelector('.monaco-editor')
  })
  // Install a same-session near-expiry credential during editing, fail one
  // renewal, then retry. Concurrent callers must share one request.
  const short = signWithExpiry(first.token, 90)
  let renewals = 0
  await page.route('**/api/auth/refresh', async route => { renewals++; if (renewals === 1) await route.fulfill({ status: 503, json: { error: 'temporary' } }); else await route.continue() })
  await page.evaluate(async token => { const { useAuthStore } = await import('/src/stores/auth.ts'); useAuthStore.getState().renewToken(useAuthStore.getState().token, token) }, short)
  await wait(() => renewals === 1, 'first renewal attempted')
  await page.evaluate(async () => {
    const { ensureFreshSession } = await import('/src/lib/session-renewal.ts')
    await ensureFreshSession()
    window.originalModel.setValue('browser edit pending across renewal\n')
    await Promise.all(Array.from({ length: 6 }, () => ensureFreshSession()))
  })
  assert.equal(renewals, 2)
  assert.equal(await page.evaluate(() => document.querySelector('.monaco-editor') === window.originalEditor), true)
  assert.equal(await page.evaluate(async () => { const { loadMonaco } = await import('/src/lib/monaco-loader.ts'); return (await loadMonaco()).editor.getModels()[0] === window.originalModel }), true)
  await wait(() => b.doc.getText('codemirror').toString().includes('browser edit pending'), 'browser edits reach second device')
  await page.reload()
  await page.locator('.monaco-editor').waitFor()
  await page.waitForFunction(() => document.body.textContent.includes('Saved'))
  assert.deepEqual(errors, [])
  console.log('PASS browser renewal retry, concurrent renewal deduplication, editor identity, reload, and font-CDN failure fallback')

  // Invalid, revoked, expired and guest credentials must not gain a user session.
  await request('/api/auth/refresh', 'POST', undefined, 'invalid', 401)
  await request('/api/auth/refresh', 'POST', undefined, signWithExpiry(first.token, -120), 401, false)
  await request('/api/auth/refresh', 'POST', undefined, signWithExpiry(first.token, -120))
  await request('/api/auth/refresh', 'POST', undefined, signWithExpiry(first.token, 90, { tokenVersion: 99999 }), 401)
  const share = (await request(`/api/rooms/${room.id}/share-links`, 'POST', { canEdit: true }, first.token, 201)).shareLink
  const guest = await request(`/api/share/${share.token}/join`, 'POST', { username: 'guest renewal' }, undefined, 201)
  await request('/api/auth/refresh', 'POST', undefined, guest.token, 401)
  // An authenticated socket may not swap to another actor, even one with access.
  a.state.token = guest.token; await a.provider.sendToken(); await wait(() => a.state.denied, 'actor swapping denied')
  await request('/api/auth/change-password', 'POST', { oldPassword: password, newPassword: 'ChangedLocal#2026Strong' }, first.token)
  await request('/api/auth/refresh', 'POST', undefined, second.token, 401)
  console.log('PASS expiry, guest isolation, actor-swap denial and password revocation still enforced')
} finally {
  for (const p of peers) { p.provider.destroy(); p.doc.destroy() }
  await browser?.close(); await server?.close()
}
// Hocuspocus may leave a pending retry timer after an intentionally rejected
// socket; fixtures and browser are closed above, so release the test process.
process.exit(0)
