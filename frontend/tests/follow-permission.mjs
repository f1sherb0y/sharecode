// Real two-browser "Allow follow" opt-out against the disposable local API/database.
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'
const API = 'http://127.0.0.1:55460'
async function request(path, method = 'GET', body, token) {
  const response = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data
}
const wait = async (fn, label) => { for (let i = 0; i < 300; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 25)) } throw Error('Timed out: ' + label) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const password = 'LocalAudit#2026Strong'
const admin = (await request('/api/auth/login', 'POST', { username: 'audit_admin', password })).token
await request('/api/admin/users', 'POST', { username: 'follow_peer', password, role: 'admin', canReadAllRooms: true, canWriteAllRooms: true }, admin)
const peerToken = (await request('/api/auth/login', 'POST', { username: 'follow_peer', password })).token

async function seededRoom(name, language) {
  const { room } = await request('/api/rooms', 'POST', { name, language }, admin)
  const doc = new Y.Doc(), messages = []
  const provider = new HocuspocusProvider({ url: API.replace('http', 'ws') + '/api/ws', name: room.id, document: doc, token: admin, onStateless: ({ payload }) => messages.push(JSON.parse(payload)) })
  try {
    await wait(() => provider.synced, 'seed sync')
    doc.getText('codemirror').insert(0, Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n\n'))
    const id = crypto.randomUUID(); provider.sendStateless(JSON.stringify({ type: 'durability-barrier', id }))
    await wait(() => messages.some(m => m.type === 'durability-ack' && m.id === id), 'seed durability')
  } finally { provider.destroy(); doc.destroy() }
  return room
}

const web = await createServer({ plugins: [{ name: 'capture-follow-test-editors', enforce: 'pre', transform(source, id) {
  if (id.endsWith('/hooks/use-monaco-editor.ts')) return source.replace('editorInstanceRef.current = editor', 'editorInstanceRef.current = editor; (window as any).__followTest = { editor, provider }')
  if (id.endsWith('/components/features/canvas-view.tsx')) return source.replace('excalidrawAPI={setApi}', 'excalidrawAPI={instance => { setApi(instance); (window as any).__testCanvasApi = instance }}')
} }], cacheDir: 'node_modules/.vite-follow-tests', server: { host: '127.0.0.1', port: 55461, strictPort: true, proxy: { '/api': { target: API, changeOrigin: true, ws: true } } }, define: { 'import.meta.env.VITE_API_URL': JSON.stringify(API), 'import.meta.env.VITE_WS_URL': JSON.stringify(API.replace('http', 'ws')) }, logLevel: 'error' })
await web.listen()

const allowFollow = page => page.getByRole('checkbox', { name: 'Allow follow', exact: true })
const presenterItem = page => page.getByRole('menuitem').filter({ hasText: 'audit_admin' })
async function menuItemText(page) {
  await page.getByRole('button', { name: 'Users', exact: true }).click()
  const item = presenterItem(page); await item.waitFor()
  const result = { text: await item.innerText(), disabled: await item.getAttribute('aria-disabled') === 'true' }
  await page.keyboard.press('Escape')
  return result
}
async function follow(page) {
  await page.getByRole('button', { name: 'Users', exact: true }).click()
  await presenterItem(page).click()
  assert.match((await menuItemText(page)).text, /Following/)
}
async function waitFollowOff(page) {
  for (let i = 0; i < 40; i++) {
    const item = await menuItemText(page)
    if (item.text.includes('Follow off')) { assert.equal(item.disabled, true); return }
    await sleep(100)
  }
  throw Error('Follower never saw Follow off')
}
const monacoTop = page => page.evaluate(() => window.__followTest.editor.getScrollTop())
const markdownTop = page => page.evaluate(() => document.querySelector('.md-editor-body').scrollTop)
// WebKit reports a macOS user agent, so editors bind document start/end to Meta+Arrow there.
const docKey = async (page, end) => page.keyboard.press(await page.evaluate(() => /Macintosh|Mac OS X/.test(navigator.userAgent)) ? (end ? 'Meta+ArrowDown' : 'Meta+ArrowUp') : (end ? 'Control+End' : 'Control+Home'))
const canvasZoom = page => page.evaluate(() => window.__testCanvasApi.getAppState().zoom.value)

try {
  for (const [engine, type] of Object.entries({ chromium, firefox, webkit })) {
    if (process.env.ENGINE && process.env.ENGINE !== engine) continue
    const codeRoom = await seededRoom('Follow permission code', 'python')
    const markdownRoom = await seededRoom('Follow permission markdown', 'markdown')
    const browser = await type.launch()
    try {
      const pages = [], errors = []
      for (const token of [admin, peerToken]) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
        await context.addInitScript(token => { sessionStorage.setItem('sharecode-tab-auth', JSON.stringify({ state: { token }, version: 0 })); localStorage.setItem('i18nextLng', 'en') }, token)
        const page = await context.newPage(); pages.push(page)
        page.setDefaultTimeout(20000)
        page.on('pageerror', e => { errors.push(e.message); console.error(engine, 'PAGE ERROR', e.stack) })
      }
      const [presenter, follower] = pages
      const openCode = async (page, query = '') => {
        await page.goto('http://127.0.0.1:55461/room/' + codeRoom.id + query)
        if (!query) await page.waitForFunction(() => window.__followTest?.provider.synced && window.__followTest.editor.getModel().getLineCount() > 500)
      }

      // Code rooms (Monaco).
      for (const page of pages) await openCode(page)
      for (const page of pages) assert.equal(await allowFollow(page).isChecked(), true, 'Allow follow defaults on')
      await follow(follower)
      await presenter.evaluate(() => window.__followTest.editor.focus())
      await docKey(presenter, true)
      await follower.waitForFunction(() => window.__followTest.editor.getScrollTop() > 2000)
      await docKey(presenter, false)
      await follower.waitForFunction(() => window.__followTest.editor.getScrollTop() < 50)
      await allowFollow(presenter).click()
      assert.equal(await allowFollow(presenter).isChecked(), false)
      await waitFollowOff(follower)
      await presenter.evaluate(() => window.__followTest.editor.focus())
      await docKey(presenter, true)
      await sleep(1000)
      assert.ok(await monacoTop(follower) < 50, 'blocked presenter must not move the follower')
      // The follower keeps free control of their own viewport.
      await follower.evaluate(() => window.__followTest.editor.setScrollTop(3000))
      await docKey(presenter, false)
      await sleep(800)
      assert.ok(Math.abs(await monacoTop(follower) - 3000) < 5)
      // Cross-view follow is blocked too.
      await presenter.getByRole('button', { name: 'Canvas', exact: true }).click()
      await presenter.waitForFunction(() => new URL(location.href).searchParams.get('view') === 'canvas')
      await sleep(1000)
      assert.notEqual(new URL(follower.url()).searchParams.get('view'), 'canvas')
      // The preference persists and can be re-enabled.
      await openCode(presenter)
      assert.equal(await allowFollow(presenter).isChecked(), false, 'preference persists across reloads')
      await allowFollow(presenter).click()
      await wait(async () => { const item = await menuItemText(follower); return !item.disabled && /Follow$/.test(item.text.trim()) }, 'follow re-enabled, previous follow cleared')
      console.log('PASS', engine, 'code room: default on, follow, opt-out stops follow and view switching, free control, persistence')

      // Markdown rooms (Milkdown).
      for (const page of pages) {
        await page.goto('http://127.0.0.1:55461/room/' + markdownRoom.id)
        await page.waitForFunction(() => (document.querySelector('.ProseMirror')?.textContent ?? '').includes('line 300'))
      }
      await follow(follower)
      // Clicking paragraphs moves the caret natively in every engine.
      await presenter.locator('.ProseMirror p').last().click()
      await follower.waitForFunction(() => document.querySelector('.md-editor-body').scrollTop > 1000)
      await presenter.locator('.ProseMirror p').first().click()
      await follower.waitForFunction(() => document.querySelector('.md-editor-body').scrollTop < 200)
      const followedTop = await markdownTop(follower)
      await allowFollow(presenter).click()
      await waitFollowOff(follower)
      await presenter.locator('.ProseMirror p').last().click()
      await sleep(1000)
      assert.ok(Math.abs(await markdownTop(follower) - followedTop) < 5, 'blocked markdown presenter must not scroll the follower')
      await allowFollow(presenter).click()
      console.log('PASS', engine, 'markdown room: follow, opt-out keeps follower in place')

      // Canvas (native Excalidraw follow).
      for (const page of pages) {
        await openCode(page, '?view=canvas')
        await page.waitForFunction(() => !!window.__testCanvasApi && document.querySelector('.excalidraw canvas'))
      }
      await follow(follower)
      await follower.locator('.follow-mode').waitFor()
      let zoom = await canvasZoom(follower)
      await presenter.getByRole('button', { name: 'Zoom in', exact: true }).click()
      await wait(async () => Math.abs(await canvasZoom(follower) - zoom) > 0.01, 'canvas follower tracks presenter zoom')
      await allowFollow(presenter).click()
      await follower.locator('.follow-mode').waitFor({ state: 'hidden' })
      zoom = await canvasZoom(follower)
      await presenter.getByRole('button', { name: 'Zoom in', exact: true }).click()
      await sleep(1000)
      assert.equal(await canvasZoom(follower), zoom, 'blocked canvas presenter must not move the follower')
      // Native avatar follow is rejected as well, and the follower can still navigate.
      await follower.locator('.UserList .Avatar').filter({ hasText: /^A$/ }).click()
      await sleep(500)
      assert.equal(await follower.locator('.follow-mode').count(), 0)
      await follower.getByRole('button', { name: 'Zoom in', exact: true }).click()
      await wait(async () => await canvasZoom(follower) > zoom, 'follower zooms freely')
      await allowFollow(presenter).click()
      console.log('PASS', engine, 'canvas: native follow, opt-out cancels and blocks avatar follow, free navigation')

      assert.deepEqual(errors, [])
    } finally { await browser.close() }
  }
} finally { await web.close() }
