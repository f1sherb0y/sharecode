// Fault injection against the real React hook/provider and disposable API/database.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'
assert.ok(process.env.SHARECODE_TEST_CONTAINER?.startsWith('sharecode-runner-test-'), 'Use the disposable database runner')
const API = 'http://127.0.0.1:55460', base = 'http://127.0.0.1:55461'
const out = '/tmp/sharecode-reconnect-recovery'
await mkdir(out, { recursive: true })
const request = async (path, method = 'GET', body, token) => {
  const response = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', 'X-Sharecode-Client': 'web', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  assert.ok(response.ok, `${path}: ${response.status}`)
  return { data: await response.json(), cookie: response.headers.get('set-cookie') }
}
const expiredToken = token => {
  const [header, payload] = token.split('.')
  const claims = { ...JSON.parse(Buffer.from(payload, 'base64url')), exp: Math.floor(Date.now()/1000) - 120 }
  const data = header + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url')
  return data + '.' + createHmac('sha256', 'local-runner-test-key-not-production').update(data).digest('base64url')
}
const server = await createServer({ server: { host: '127.0.0.1', port: 55461, strictPort: true, proxy: { '/api': { target: API, ws: true } } }, logLevel: 'error', plugins: [{ name: 'observe-real-provider', enforce: 'pre', transform(code, id) {
  if (id.endsWith('/src/hooks/use-yjs-provider.ts')) return code.replace('const identityMatches =', 'window.__collab = { provider, ydoc, isConnected, isSynced, isAuthenticated, protocolReady, hasPending, serverPending, syncError, storageFailed }; const identityMatches =')
} }] })
await server.listen()
try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    if (process.env.ENGINE && process.env.ENGINE !== engine) continue
    const { data: credentials, cookie } = await request('/api/auth/login', 'POST', { username: 'audit_admin', password: 'LocalAudit#2026Strong' })
    const { data: { room } } = await request('/api/rooms', 'POST', { name: `${engine} reconnect recovery`, language: 'typescript' }, credentials.token)
    const browser = await launcher.launch()
    try {
      const context = await browser.newContext()
      const [name, value] = cookie.split(';')[0].split('=')
      await context.addCookies([{ name, value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }])
      await context.addInitScript(({ token, browserSessionId }) => {
        if (!sessionStorage.getItem('sharecode-tab-auth')) sessionStorage.setItem('sharecode-tab-auth', JSON.stringify({ state: { token, browserSessionId, sessionId: 'recovery-test-session' }, version: 0 }))
        localStorage.setItem('i18nextLng', 'en')
      }, credentials)
      const page = await context.newPage(), errors = [], results = []
      page.on('pageerror', e => errors.push(e.message))
      page.setDefaultTimeout(20000)
      const state = () => page.evaluate(() => {
        const { provider, ydoc, ...flags } = window.__collab
        return { ...flags, synced: provider?.synced, status: document.querySelector('footer [role=status]')?.textContent, text: ydoc?.getText('codemirror').toString() }
      })
      const saved = async () => {
        const snapshot = await page.waitForFunction(() => {
          const s = window.__collab
          if (document.querySelector('footer [role=status]')?.textContent.includes('Saved') && s.isSynced && s.provider?.synced && s.isAuthenticated && s.protocolReady && !s.hasPending && !s.serverPending && !s.storageFailed && !s.syncError) {
            const { provider, ydoc, ...flags } = s
            return { ...flags, synced: provider.synced }
          }
          return false
        }, {}, { timeout: 25000 })
        const s = await snapshot.jsonValue()
        await snapshot.dispose()
        assert.equal(s.isSynced && s.synced && s.isAuthenticated && s.protocolReady, true)
        assert.equal(s.hasPending || s.serverPending || s.storageFailed || !!s.syncError, false)
      }
      const record = async name => { results.push({ name, ...await state() }); console.log(`PASS ${engine}: ${name}`) }
      const outboxCount = () => page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('sharecode-recovery', 1)
        open.onerror = () => reject(open.error)
        open.onsuccess = () => { const db = open.result, r = db.transaction('pending').objectStore('pending').count(); r.onsuccess = () => { resolve(r.result); db.close() }; r.onerror = () => { reject(r.error); db.close() } }
      }))
      await page.goto(base + '/room/' + room.id); await saved()
      await page.locator('.monaco-editor').waitFor()
      await page.evaluate(() => { window.originalDoc = window.__collab.ydoc; window.originalEditor = document.querySelector('.monaco-editor') })
      for (let i = 0; i < 3; i++) {
        await page.evaluate(i => {
          const p = window.__collab.provider
          window.oldSocket = p.configuration.websocketProvider.webSocket
          window.__collab.ydoc.getText('codemirror').insert(0, `normal ${i}\n`)
          window.oldSocket.close()
        }, i)
        await page.waitForFunction(() => window.__collab.provider.configuration.websocketProvider.webSocket !== window.oldSocket)
        await saved()
      }
      await record('three normal reconnects retain pending edits')
      for (let i = 0; i < 2; i++) {
        await page.evaluate(i => {
          const ws = window.__collab.provider.configuration.websocketProvider, socket = ws.webSocket, close = socket.close.bind(socket)
          window.oldSocket = socket
          window.__collab.ydoc.getText('codemirror').insert(0, `watchdog ${i}\n`)
          socket.close = () => {}
          ws.lastMessageReceived = Date.now() - ws.configuration.messageReconnectTimeout - 1
          ws.checkConnection(); ws.checkConnection(); ws.checkConnection(); close()
        }, i)
        await page.waitForFunction(() => window.__collab.provider.configuration.websocketProvider.webSocket !== window.oldSocket)
        await saved()
      }
      await record('forced watchdog reconnect restores both sync states')
      // Hold acknowledgements, including a retry. No timer may mark edits Saved.
      await page.evaluate(() => {
        const p = window.__collab.provider
        window.receiveStateless = p.receiveStateless.bind(p)
        window.heldAcks = []; window.holdAcks = true; window.barrierIds = []
        const send = p.sendStateless.bind(p)
        p.sendStateless = payload => { const m = JSON.parse(payload); if (m.type === 'durability-barrier') window.barrierIds.push(m.id); send(payload) }
        p.receiveStateless = payload => { if (window.holdAcks && JSON.parse(payload).type === 'durability-ack') window.heldAcks.push(payload); else window.receiveStateless(payload) }
        window.__collab.ydoc.getText('codemirror').insert(0, 'held acknowledgement\n')
      })
      await page.waitForFunction(() => window.heldAcks.length >= 2)
      assert.equal((await state()).hasPending, true)
      assert.ok(await outboxCount() > 0)
      assert.equal(await page.evaluate(() => window.barrierIds[0] === window.barrierIds[1]), true, 'Retry keeps its acknowledged version boundary')
      // Let the timeout trigger a new socket, keep acknowledgements held.
      await page.evaluate(() => { window.oldSocket = window.__collab.provider.configuration.websocketProvider.webSocket })
      await page.waitForFunction(() => window.__collab.provider.configuration.websocketProvider.webSocket !== window.oldSocket)
      await page.waitForFunction(() => window.__collab.isAuthenticated && window.__collab.isSynced)
      await page.evaluate(() => window.__collab.ydoc.getText('codemirror').insert(0, 'newer edit\n'))
      await page.waitForTimeout(200)
      // A late old acknowledgement must not clear the newer outbox.
      await page.evaluate(() => window.receiveStateless(window.heldAcks[0]))
      assert.equal((await state()).hasPending, true)
      assert.ok(await outboxCount() > 0)
      await page.evaluate(() => { window.holdAcks = false; for (const ack of window.heldAcks) window.receiveStateless(ack) })
      await saved(); assert.equal(await outboxCount(), 0)
      await record('lost acknowledgements retry/reconnect; stale ack cannot clear newer edits')
      // Read committed replay rows independently of the live browser/server document.
      assert.match(room.id, /^[0-9a-f-]{36}$/)
      const updates = execFileSync('docker', ['exec', process.env.SHARECODE_TEST_CONTAINER, 'psql', '-U', 'runner_test', '-d', 'runner_test', '-At', '-v', 'ON_ERROR_STOP=1', '-c', `SELECT encode(update, 'hex') FROM "DocumentUpdate" WHERE "documentId" = '${room.id}' ORDER BY seq`], { encoding: 'utf8' }).trim().split('\n')
      const persisted = new Y.Doc()
      for (const update of updates) Y.applyUpdate(persisted, Buffer.from(update, 'hex'))
      assert.equal(persisted.getText('codemirror').toString(), (await state()).text)
      persisted.destroy()
      await record('Saved content matches persisted server replay')
      // Failed refresh remains retryable; success must recover without manual renew/reload.
      let refreshes = 0
      await page.route('**/api/auth/refresh', route => { refreshes++; return route.fulfill({ status: 503, json: { error: 'temporary outage' } }) })
      await page.evaluate(async token => { const { useAuthStore } = await import('/src/stores/auth.ts'); useAuthStore.getState().renewToken(useAuthStore.getState().token, token) }, expiredToken(credentials.token))
      await page.waitForFunction(() => !window.__collab.isAuthenticated && !window.__collab.provider.configuration.websocketProvider.shouldConnect)
      await page.waitForTimeout(2500); assert.ok(refreshes >= 2)
      assert.equal(await page.evaluate(() => !!window.originalEditor && document.querySelector('.monaco-editor') === window.originalEditor), true, 'Recovery keeps the editor mounted during the outage')
      await page.unroute('**/api/auth/refresh')
      await saved()
      assert.equal(await page.evaluate(() => window.__collab.ydoc === window.originalDoc && document.querySelector('.monaco-editor') === window.originalEditor), true)
      await page.evaluate(() => window.__collab.ydoc.getText('codemirror').insert(0, 'after renewal\n'))
      await saved(); await record('transient refresh failure automatically recovers with document/editor intact')
      // Explicit access revocation remains terminal despite online/visible events.
      assert.equal(await page.evaluate(async browserSessionId => (await fetch('/api/auth/logout', { method: 'POST', credentials: 'include', headers: { 'X-Sharecode-Client': 'web', 'X-Session-Id': browserSessionId } })).status, credentials.browserSessionId), 200)
      await page.waitForFunction(() => window.__collab.syncError === 'accessRevoked')
      const wsCount = await page.evaluate(() => window.__collab.provider.configuration.websocketProvider.identifier)
      await page.evaluate(() => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')) })
      await page.waitForTimeout(2000)
      assert.equal(await page.evaluate(() => window.__collab.provider.configuration.websocketProvider.shouldConnect), false)
      assert.equal(await page.evaluate(() => window.__collab.provider.configuration.websocketProvider.identifier), wsCount)
      assert.deepEqual(errors, [])
      await record('revoked access stays disconnected')
      // A definitive refresh denial must stop collaboration retries.
      const loginAgain = async () => {
        await page.evaluate(async () => { const { useAuthStore } = await import('/src/stores/auth.ts'); await useAuthStore.getState().login('audit_admin', 'LocalAudit#2026Strong') })
        await saved()
        return page.evaluate(async () => (await import('/src/stores/auth.ts')).useAuthStore.getState().token)
      }
      const nextToken = await loginAgain()
      let denials = 0
      await page.route('**/api/auth/refresh', route => { denials++; return route.fulfill({ status: 401, json: { error: 'session revoked' } }) })
      await page.evaluate(async token => { const { useAuthStore } = await import('/src/stores/auth.ts'); useAuthStore.getState().renewToken(useAuthStore.getState().token, token) }, expiredToken(nextToken))
      await page.waitForFunction(() => window.__collab.syncError === 'sessionExpired' && !window.__collab.provider.configuration.websocketProvider.shouldConnect)
      const deniedCount = denials
      await page.waitForTimeout(2200)
      assert.equal(denials, deniedCount)
      await record('refresh 401 stops automatic collaboration retries')
      await page.unroute('**/api/auth/refresh')

      // A refresh completing after logout must not revive the old provider/session.
      const finalToken = await loginAgain()
      let releaseRefresh, heldRefresh = false, outage = true
      await page.route('**/api/auth/refresh', async route => {
        if (outage) return route.fulfill({ status: 503, json: { error: 'temporary outage' } })
        const response = await route.fetch()
        heldRefresh = true
        await new Promise(resolve => { releaseRefresh = resolve })
        await route.fulfill({ response })
      })
      await page.evaluate(async token => { const { useAuthStore } = await import('/src/stores/auth.ts'); useAuthStore.getState().renewToken(useAuthStore.getState().token, token) }, expiredToken(finalToken))
      await page.waitForFunction(() => !window.__collab.isAuthenticated && !window.__collab.provider.configuration.websocketProvider.shouldConnect)
      outage = false
      await page.evaluate(() => window.dispatchEvent(new Event('online')))
      for (let i = 0; i < 100 && !heldRefresh; i++) await page.waitForTimeout(50)
      assert.ok(heldRefresh, 'A successful refresh response is held in flight')
      await page.evaluate(async () => {
        window.retiredProvider = window.__collab.provider
        const { useAuthStore } = await import('/src/stores/auth.ts')
        useAuthStore.getState().forgetSession()
      })
      releaseRefresh()
      await page.waitForTimeout(2200)
      assert.equal(await page.evaluate(async () => (await import('/src/stores/auth.ts')).useAuthStore.getState().token), null)
      assert.equal(await page.evaluate(() => window.retiredProvider.configuration.websocketProvider.shouldConnect), false)
      assert.equal(await page.evaluate(() => window.retiredProvider.configuration.websocketProvider.webSocket), null)
      assert.deepEqual(errors, [])
      results.push({ name: 'late refresh after logout cannot revive the old provider or session' })
      console.log(`PASS ${engine}: late refresh after logout cannot revive the old provider or session`)
      await writeFile(`${out}/${engine}.json`, JSON.stringify(results, null, 2))
    } finally { await browser.close() }
  }
} finally { await server.close() }
process.exit(0)
