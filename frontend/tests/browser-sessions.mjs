// Disposable PostgreSQL/API only. Restart actual browser processes with their
// on-disk profiles; do not simulate persistence by copying sessionStorage.
import assert from 'node:assert/strict'
import { createHmac, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'

const API = 'http://127.0.0.1:55460', WEB = 'http://127.0.0.1:55461'
const password = 'LocalAudit#2026Strong'
const temp = await mkdtemp(join(tmpdir(), 'sharecode-browser-sessions-'))
const sql = query => execFileSync('docker', ['exec', process.env.SHARECODE_TEST_CONTAINER, 'psql', '-U', 'runner_test', '-d', 'runner_test', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim()
async function req(path, { cookie, token, method = 'POST', body, status = 200, headers = {}, marker = true } = {}) {
  const response = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(marker ? { 'X-Sharecode-Client': 'web' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
  assert.equal(response.status, status, `${method} ${path}`)
  return { data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers }
}
const login = () => req('/api/auth/login', { body: { username: 'audit_admin', password } })
const refresh = (cookie, options = {}) => req('/api/auth/refresh', { cookie, ...options })
const claims = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'))
function sign(token, patch) {
  const header = token.split('.')[0], payload = { ...claims(token), ...patch }
  const message = header + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url')
  return message + '.' + createHmac('sha256', 'local-runner-test-key-not-production').update(message).digest('base64url')
}
const wait = async (condition, message) => {
  for (let i = 0; i < 300; i++) { if (await condition()) return; await new Promise(r => setTimeout(r, 40)) }
  throw Error(message)
}
const first = await login(), second = await login()
assert(first.cookie && second.cookie && first.cookie !== second.cookie)
assert.match(first.headers.get('set-cookie'), /HttpOnly/)
assert.match(first.headers.get('set-cookie'), /SameSite=Lax/)
assert.match(first.headers.get('set-cookie'), /Max-Age=2592000/)
assert.equal(claims(first.data.token).exp - claims(first.data.token).iat, 900)
const secret = first.cookie.split('=')[1]
assert.equal(sql(`SELECT encode("secretHash",'hex') FROM "BrowserSession" WHERE id='${first.data.browserSessionId}'`), createHash('sha256').update(secret).digest('hex'))
await refresh(first.cookie, { marker: false, status: 403 })
await refresh(first.cookie, { headers: { Origin: 'https://evil.invalid' }, status: 403 })
await req('/api/auth/login', { body: { username: 'audit_admin', password }, headers: { Origin: 'https://evil.invalid' }, status: 403 })
const preflight = await fetch(API + '/api/auth/refresh', { method: 'OPTIONS', headers: { Origin: 'https://evil.invalid', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-sharecode-client' } })
assert.equal(preflight.headers.get('access-control-allow-origin'), null)
const expired = sign(first.data.token, { exp: Math.floor(Date.now()/1000) - 120 })
await refresh(undefined, { token: expired, status: 401 })
assert.equal((await refresh(first.cookie, { token: expired })).data.browserSessionId, first.data.browserSessionId)
await refresh(first.cookie, { token: second.data.token, status: 401 })
const concurrent = await Promise.all(Array.from({ length: 8 }, () => refresh(first.cookie)))
assert(concurrent.every(result => result.data.browserSessionId === first.data.browserSessionId))
const legacy = sign(first.data.token, { sessionId: undefined })
assert((await refresh(undefined, { token: legacy })).cookie, 'valid legacy JWT upgrades to persistent login')
await refresh(undefined, { token: sign(legacy, { exp: 1 }), status: 401 })
console.log('PASS persistent cookie flags/hash, 15-minute JWT, CSRF/CORS, expiry, concurrent refresh and legacy upgrade')

const room = (await req('/api/rooms', { token: first.data.token, body: { name: 'Persistent login checks', language: 'python' }, status: 201 })).data.room
const share = (await req(`/api/rooms/${room.id}/share-links`, { token: first.data.token, body: { canEdit: true }, status: 201 })).data.shareLink
const guest = (await req(`/api/share/${share.token}/join`, { body: { username: 'Guest in separate tab' }, status: 201 })).data
await refresh(first.cookie, { token: guest.token, status: 401 })

let server, context
const peers = []
try {
  server = await createServer({ cacheDir: join(temp, 'vite'), optimizeDeps: { include: ['@fingerprintjs/fingerprintjs'] }, server: { host: '127.0.0.1', port: 55461, strictPort: true, proxy: { '/api': { target: API, ws: true } } }, logLevel: 'error' })
  await server.listen()
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    if (process.env.ENGINE && process.env.ENGINE !== name) continue
    const profile = join(temp, name), errors = []
    const open = async () => {
      context = await engine.launchPersistentContext(profile, { headless: true })
      await context.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      return page
    }
    let page = await open()
    await page.goto(WEB + '/login')
    await page.locator('#username').fill('audit_admin')
    await page.locator('#password').fill(password)
    await page.getByRole('button', { name: 'Login', exact: true }).click()
    await page.waitForURL('**/rooms').catch(async error => {
      console.error(name, 'login diagnostic:', await page.locator('body').innerText(), errors)
      throw error
    })
    const cookie = (await context.cookies()).find(c => c.name === 'sharecode-session')
    assert(cookie?.httpOnly && cookie.expires > Date.now()/1000 + 29*86400)
    assert(!await page.evaluate(() => document.cookie.includes('sharecode-session')))
    assert(!await page.evaluate(secret => Object.values(localStorage).some(value => value.includes(secret)), cookie.value))
    await context.close(); context = undefined
    // A fresh page in the restarted process has no tab access token.
    page = await open()
    await page.goto(WEB + '/rooms')
    await page.getByRole('heading', { name: 'Workspace', exact: true }).waitFor()
    assert.equal(await page.evaluate(async () => (await import('/src/stores/auth.ts')).useAuthStore.getState().user?.username), 'audit_admin')
    const hints = await page.evaluate(async () => {
      const state = (await import('/src/stores/auth.ts')).useAuthStore.getState()
      return { browserSessionId: state.browserSessionId, sessionId: state.sessionId }
    })
    // Keep a guest tab alongside the restored user. It must not adopt the cookie.
    const guestPage = await context.newPage()
    await guestPage.addInitScript(token => sessionStorage.setItem('sharecode-tab-auth', JSON.stringify({ state: { token }, version: 0 })), guest.token)
    await guestPage.goto(WEB + '/room/' + room.id)
    await guestPage.locator('.monaco-editor').waitFor()
    assert.equal(await guestPage.evaluate(async () => (await import('/src/stores/auth.ts')).useAuthStore.getState().actorType), 'guest')
    // Reload with an expired access JWT; cookie recovery preserves the journal scope.
    await page.evaluate(token => {
      const stored = JSON.parse(sessionStorage.getItem('sharecode-tab-auth')); stored.state.token = token
      sessionStorage.setItem('sharecode-tab-auth', JSON.stringify(stored))
    }, sign((await page.evaluate(async () => (await import('/src/stores/auth.ts')).useAuthStore.getState().token)), { exp: 1 }))
    await page.reload()
    await page.getByRole('heading', { name: 'Workspace', exact: true }).waitFor()
    assert.equal(await page.evaluate(async () => (await import('/src/stores/auth.ts')).useAuthStore.getState().sessionId), hints.sessionId)
    await page.getByRole('button', { name: 'Account menu', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Logout', exact: true }).click()
    await page.waitForURL('**/login')
    assert.equal(await guestPage.evaluate(async () => (await import('/src/stores/auth.ts')).useAuthStore.getState().actorType), 'guest')
    await context.close(); context = undefined
    page = await open()
    await page.goto(WEB + '/rooms')
    await page.getByRole('button', { name: 'Login', exact: true }).waitFor()
    assert.equal((await context.cookies()).filter(c => c.name === 'sharecode-session').length, 0)
    assert.deepEqual(errors, [])
    await context.close(); context = undefined
    console.log(`PASS ${name}: real process restart restores login, expired access recovery, guest isolation and logout survives another restart`)
  }
  const makePeer = token => {
    const doc = new Y.Doc(), state = { closed: false }
    const provider = new HocuspocusProvider({ url: API.replace('http','ws')+'/api/ws', name: room.id, document: doc, token,
      onClose: () => { state.closed = true }, onAuthenticationFailed: () => provider.disconnect() })
    const peer = { doc, provider, state }; peers.push(peer); return peer
  }
  const a = makePeer(first.data.token), b = makePeer(second.data.token)
  await wait(() => a.provider.synced && b.provider.synced, 'both devices connect')
  await req('/api/auth/logout', { cookie: first.cookie })
  await wait(() => a.state.closed, 'logout closes this session WebSocket')
  assert.equal(b.state.closed, false, 'logout must not kick another device')
  await refresh(first.cookie, { status: 401 })
  await req('/api/auth/profile', { method: 'GET', token: first.data.token, status: 401 })
  await refresh(second.cookie)
  const changed = await req('/api/auth/change-password', { cookie: second.cookie, token: second.data.token, body: { oldPassword: password, newPassword: 'NewPersistent#2026Strong' } })
  await refresh(second.cookie, { status: 401 })
  await refresh(changed.cookie)
  sql(`UPDATE "BrowserSession" SET "expiresAt"=NOW()-INTERVAL '1 second' WHERE id='${changed.data.browserSessionId}'`)
  await refresh(changed.cookie, { status: 401 })
  console.log('PASS per-device HTTP/WS logout, other-device survival, password revocation and server-side session expiry')
  console.log('Browser profile artifacts:', temp)
} finally {
  for (const { provider, doc } of peers) { provider.destroy(); doc.destroy() }
  await context?.close(); await server?.close()
}
process.exit(0)
