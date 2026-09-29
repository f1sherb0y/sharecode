// Real React/Monaco/Milkdown with isolated API + provider fixtures; no live account.
// Run from frontend: node --test tests/workspace-ui.test.mjs
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import * as Y from 'yjs'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'
let server, browser, base
const engine = process.env.UI_BROWSER || 'chromium'
const screenshots = '/tmp/sharecode-ui-review/' + engine
const owner = { id: 'ui-owner', username: 'Lin', color: '#218568', role: 'superuser' }
const playbackDoc = new Y.Doc()
playbackDoc.getText('codemirror').insert(0, 'const compact = true\n')
const playbackUpdate = gzipSync(Y.encodeStateAsUpdate(playbackDoc)).toString('base64')
playbackDoc.destroy()
const sampleRooms = [['markdown', '协作文档 · 产品与技术笔记', 'markdown'], ['code', '实时协作 / TypeScript', 'typescript'], ['python', '算法练习 · Python', 'python'], ['ended', '上周的技术讨论', 'javascript']].map(([id, name, language]) => ({ id, name, language, ownerId: owner.id, owner, isOwner: true, canEdit: true, isEnded: id === 'ended', participants: [], createdAt: '2026-09-16T02:00:00Z', isPinned: id === 'markdown' }))
const mockProvider = `
import { useMemo, useState, useEffect } from 'react'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
export function useYjsProvider(name) {
  const [status, setStatus] = useState({ isConnected: true, isSaved: true, storageFailed: false })
  useEffect(() => { const handler = e => setStatus(e.detail); window.addEventListener('ui-sync-state', handler); return () => window.removeEventListener('ui-sync-state', handler) }, [])
  const state = useMemo(() => {
    const ydoc = new Y.Doc(), ytext = ydoc.getText('codemirror'), ymeta = ydoc.getMap('meta')
    ytext.insert(0, name === 'markdown' ? '# 一起写下更好的想法\\n\\n一个轻量、专注的协作空间。Keep things simple.\\n\\n## 今天的计划\\n\\n- 整理产品需求与技术方案\\n- 一起编写、讨论和回顾\\n\\n> 让内容成为主角。\\n\\n协作，从一行文字开始。' : '// A small idea, shared.\\nconst greet = (name: string) => {\\n  return "Hello, " + name\\n}\\n\\nconsole.log(greet("ShareCode"))')
    const provider = { awareness: new Awareness(ydoc), configuration: { name } }
    return { ydoc, ytext, ymeta, provider }
  }, [name])
  window.uiDoc = state.ydoc
  return { ...state, ...status, isSynced: true, canWrite: true, syncError: '', onlineUsers: [], waitForSaved: async () => {} }
}`
before(async () => {
  await mkdir(screenshots, { recursive: true })
  server = await createServer({ cacheDir: `node_modules/.vite-ui-tests-${engine}`, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false }, optimizeDeps: { include: ['yjs', 'y-protocols/awareness', '@milkdown/kit/core', '@milkdown/react', '@milkdown/plugin-collab'] }, logLevel: 'error', plugins: [{ name: 'isolated-ui-provider', enforce: 'pre', load(id) { if (id.endsWith('/src/hooks/use-yjs-provider.ts')) return mockProvider } }] })
  await server.listen(); base = server.resolvedUrls.local[0]; browser = await ({ chromium, firefox, webkit })[engine].launch()
})
after(async () => { await browser?.close(); await server?.close() })
async function open(path, { mobile = false, authenticated = true, deviceScaleFactor = 1, viewport, locale = 'zh', rooms = sampleRooms } = {}) {
  const context = await browser.newContext({ viewport: viewport ?? (mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }), deviceScaleFactor, isMobile: engine !== 'firefox' && mobile, hasTouch: mobile })
  await context.addInitScript(({ authenticated, locale }) => {
    if (!localStorage.getItem('i18nextLng')) localStorage.setItem('i18nextLng', locale)
    if (!localStorage.getItem('theme-storage')) localStorage.setItem('theme-storage', JSON.stringify({ state: { theme: 'light' }, version: 0 }))
    if (authenticated) sessionStorage.setItem('sharecode-tab-auth', JSON.stringify({ state: { token: 'ui-fixture' }, version: 0 }))
  }, { authenticated, locale })
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/auth/refresh') return route.fulfill({ status: 401, json: { error: 'No browser session' } })
    let data = {}
    if (path === '/api/auth/profile') data = { actorType: 'user', user: owner }
    else if (path === '/api/admin/rooms') data = { rooms: sampleRooms, pagination: { page: 1, pageSize: 25, total: sampleRooms.length, totalPages: 1, hasNext: false, hasPrev: false } }
    else if (path === '/api/admin/users') data = { users: [owner], pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1, hasNext: false, hasPrev: false } }
    else if (path === '/api/admin/audit') data = { events: [], snapshot: 0, pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1, hasNext: false, hasPrev: false } }
    else if (path === '/api/admin/storage/db-size') data = { bytes: 1024, pretty: '1 kB' }
    else if (path === '/api/admin/storage/playback') data = { rooms: [] }
    else if (path.endsWith('/playback/updates')) data = { updates: [0, 1].map(id => ({ id, timestamp: `2026-09-16T02:00:0${id}Z`, update: playbackUpdate, userId: owner.id })) }
    else if (path.endsWith('/notes')) data = { notes: [] }
    else if (path.endsWith('/share-links')) data = { shareLinks: [] }
    else if (path === '/api/rooms') {
      const query = new URL(route.request().url()).searchParams
      const current = Number(query.get('page') || 1)
      data = { rooms, pagination: { page: current, pageSize: Number(query.get('pageSize') || 50), total: 120, totalPages: 3, hasNext: current < 3, hasPrev: current > 1 } }
    }
    else if (path.startsWith('/api/rooms/')) data = { room: sampleRooms.find(r => path.endsWith('/' + r.id)) }
    else if (path.includes('users')) data = { users: [owner] }
    else if (path.includes('notifications')) data = { notifications: [] }
    else if (path.includes('registration')) data = { allowRegistration: true }
    await route.fulfill({ json: data })
  })
  const page = await context.newPage(), errors = []
  page.setDefaultTimeout(20000); page.on('pageerror', e => { errors.push(e.message); console.error(e.message) }); await page.goto(base + path)
  return { page, context, errors }
}
const style = (page, property) => page.locator('.ProseMirror').evaluate((el, p) => getComputedStyle(el)[p], property)
for (const room of ['code', 'markdown']) test(`fullscreen keeps menus, selects and dialogs visible and interactive in ${room}`, async () => {
  const { page, context, errors } = await open(`room/${room}`, { locale: 'en' })
  const editorSelector = room === 'code' ? '.monaco-editor' : '.ProseMirror'
  const fullscreen = () => page.evaluate(() => !!(document.fullscreenElement || document.webkitFullscreenElement))
  const assertInFullscreen = async locator => {
    await locator.waitFor()
    assert.equal(await locator.evaluate(el => {
      const root = document.fullscreenElement || document.webkitFullscreenElement
      const box = el.getBoundingClientRect()
      return !!root?.contains(el) && el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
    }), true, 'Popup must be inside fullscreen and receive pointer input')
  }
  try {
    await page.locator(editorSelector).waitFor()
    await page.evaluate(selector => { window.uiOriginalEditor = document.querySelector(selector) }, editorSelector)
    const more = page.getByRole('button', { name: 'More actions', exact: true })
    await more.click()
    await page.getByRole('menuitem', { name: 'Enter fullscreen', exact: true }).click()
    await page.waitForFunction(() => !!(document.fullscreenElement || document.webkitFullscreenElement))
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await page.getByRole('button', { name: 'Toggle theme', exact: true }).click()
      await more.click()
      await assertInFullscreen(page.getByRole('menu'))
      await page.getByRole('menuitem', { name: 'End Room', exact: true }).click()
      await assertInFullscreen(page.getByRole('dialog'))
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      assert.equal(await fullscreen(), true)
      await page.getByRole('combobox', { name: 'Language', exact: true }).click()
      await assertInFullscreen(page.getByRole('listbox'))
      await page.getByRole('option', { name: room === 'code' ? 'typescript' : 'markdown', exact: true }).click()
      await page.getByRole('listbox').waitFor({ state: 'hidden' })
      assert.equal(await fullscreen(), true)
      await page.getByRole('button', { name: 'Users', exact: true }).click()
      await assertInFullscreen(page.getByRole('menu'))
      await page.screenshot({ path: `${screenshots}/fullscreen-${room}-${theme}.png` })
      // Safari reserves Escape for leaving native fullscreen; dismiss by pointer.
      await page.mouse.click(10, 100)
      await page.getByRole('menu').waitFor({ state: 'hidden' })
      assert.equal(await fullscreen(), true)
      await page.getByRole('button', { name: 'Share', exact: true }).click()
      await assertInFullscreen(page.getByRole('dialog'))
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
    }
    await more.click()
    await page.getByRole('menuitem', { name: 'Exit fullscreen', exact: true }).click()
    await page.waitForFunction(() => !(document.fullscreenElement || document.webkitFullscreenElement))
    await more.click()
    await page.getByRole('menuitem', { name: 'Enter fullscreen', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(selector => document.querySelector(selector) === window.uiOriginalEditor, editorSelector), true)
    await page.locator(room === 'code' ? '.monaco-editor .view-lines' : editorSelector).click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('// fullscreen restored')
    assert.ok(await page.evaluate(room => (room === 'code' ? window.uiDoc.getText('codemirror') : window.uiDoc.getXmlFragment('prosemirror')).toString().includes('// fullscreen restored'), room))
    await more.click()
    await page.getByRole('menuitem', { name: 'Enter fullscreen', exact: true }).click()
    await page.waitForFunction(() => !!(document.fullscreenElement || document.webkitFullscreenElement))
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.locator('.room-row').first().waitFor()
    await page.waitForFunction(() => !(document.fullscreenElement || document.webkitFullscreenElement))
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('scrolled rooms keep the navbar and account menu visible in both themes', async () => {
  const rooms = Array.from({ length: 50 }, (_, i) => ({ ...sampleRooms[1], id: `scroll-${i}`, name: `Room ${i}` }))
  for (const mobile of [false, true]) {
    const { page, context, errors } = await open('rooms', { mobile, locale: 'en', rooms })
    try {
      await page.locator('.room-row').first().waitFor()
      for (const theme of ['light', 'dark']) {
        if (theme === 'dark') await page.getByRole('button', { name: 'Toggle theme', exact: true }).click()
        await page.evaluate(() => window.scrollTo(0, 600))
        await page.waitForFunction(() => window.scrollY >= 600)
        const headerBefore = await page.locator('header').boundingBox()
        assert.equal(headerBefore.y, 0)
        const trigger = page.getByRole('button', { name: 'Account menu', exact: true })
        const triggerBox = await trigger.boundingBox()
        await trigger.click()
        const menu = page.getByRole('menu')
        await menu.waitFor()
        const headerAfter = await page.locator('header').boundingBox()
        assert.equal(headerAfter.y, headerBefore.y, 'Opening a menu must not dislodge the sticky navbar')
        const box = await menu.boundingBox()
        assert.ok(box.y >= triggerBox.y + triggerBox.height && box.y + box.height <= page.viewportSize().height, JSON.stringify(box))
        assert.ok(box.x >= 0 && box.x + box.width <= page.viewportSize().width, JSON.stringify(box))
        assert.equal(await menu.evaluate(el => getComputedStyle(el).backgroundColor), await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor))
        // Wheel input belongs to the desktop cases (mobile WebKit does not support it).
        if (!mobile) {
          await page.mouse.move(10, 500)
          await page.mouse.wheel(0, 200)
          await page.waitForTimeout(100)
          assert.equal(await page.evaluate(() => window.scrollY), 600, 'The background must remain scroll-locked')
        }
        await page.screenshot({ path: `${screenshots}/rooms-account-${theme}-${mobile ? 'mobile' : 'desktop'}.png` })
        await page.keyboard.press('Escape')
        await menu.waitFor({ state: 'hidden' })
        // Radix restores focus in a deferred unmount callback, after hiding the menu.
        await page.waitForFunction(() => document.activeElement === document.querySelector('button[aria-label="Account menu"]'))
        assert.equal(await trigger.evaluate(el => document.activeElement === el), true)
        assert.equal(await page.evaluate(() => window.scrollY), 600)
        if (!mobile) {
          await page.mouse.wheel(0, 200)
          await page.waitForFunction(() => window.scrollY > 600)
          await page.evaluate(() => window.scrollTo(0, 600))
          await page.waitForFunction(() => window.scrollY === 600)
        }
        // Dialogs and nested selects share the same body scroll lock.
        await page.getByRole('button', { name: 'Create New Room', exact: true }).click()
        const dialog = page.getByRole('dialog')
        await dialog.waitFor()
        assert.equal((await page.locator('header').boundingBox()).y, 0)
        await dialog.getByRole('combobox').first().click()
        const options = page.getByRole('listbox')
        await options.waitFor()
        assert.equal(await options.evaluate(el => getComputedStyle(el).backgroundColor), await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor))
        await page.keyboard.press('Escape')
        await options.waitFor({ state: 'hidden' })
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden' })
        assert.equal(await page.evaluate(() => window.scrollY), 600)
        // Reopening and following an item must still work after scrolling.
        await trigger.click()
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
        await page.waitForURL('**/settings')
        await page.locator('#currentPassword').waitFor()
        await page.goto(base + 'rooms')
        await page.locator('.room-row').first().waitFor()
      }
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  }
})

test('compact secondary pages keep forms and navigation inside desktop and phone viewports', async () => {
  for (const mobile of [false, true]) {
    for (const path of ['settings', 'admin', 'admin?section=rooms', 'admin/audit', 'notifications', 'playback/ended', 'register', 'join', 's/ui-fixture']) {
      const authenticated = !['register', 'join', 's/ui-fixture'].includes(path)
      const { page, context, errors } = await open(path, { mobile, authenticated, viewport: mobile ? { width: 320, height: 700 } : { width: 1440, height: 900 } })
      try {
        await page.locator(path.startsWith('playback') ? '.monaco-editor' : path.startsWith('admin') && !path.includes('/audit') ? 'table' : 'input:not([type=hidden])').first().waitFor().catch(async error => { console.error('PAGE DIAGNOSTIC', path, mobile, await page.locator('body').innerText()); throw error })
        for (const control of await page.locator('header button, input:not([type=checkbox]), textarea').all()) {
          if (!await control.isVisible()) continue
          const box = await control.boundingBox()
          assert.ok(box.x >= -1 && box.x + box.width <= (mobile ? 321 : 1441), `${path}: ${JSON.stringify(box)}`)
        }
        if (path.startsWith('playback')) {
          const footer = await page.locator('footer').boundingBox()
          assert.ok(footer.y + footer.height <= (mobile ? 701 : 901))
          const controls = await page.locator('footer > div:last-child > *').evaluateAll(elements => elements.map(el => {
            const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }
          }))
          for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
            const a = controls[i], b = controls[j]
            assert.ok(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y, 'Playback controls overlap')
          }
        }
        for (const checkbox of await page.locator('.ui-checkbox').all()) {
          const box = await checkbox.boundingBox(); assert.ok(Math.abs(box.width - box.height) < 0.1)
        }
        assert.deepEqual(errors, [])
        await page.screenshot({ animations: 'disabled', path: screenshots + '/' + path.replaceAll('/', '-') + (mobile ? '-mobile' : '-desktop') + '.png' })
      } finally { await context.close() }
    }
  }
})

test('whole room rows navigate, menus stay separate, and pagination uses equal button heights', async () => {
  for (const mobile of [false, true]) for (const locale of ['en', 'zh']) {
    const { page, context, errors } = await open('rooms', { mobile, locale })
    try {
      await page.locator('.room-row-link').first().waitFor()
      assert.equal(new URL(page.url()).searchParams.get('pageSize'), '50')
      const nav = page.getByRole('navigation', { name: locale === 'en' ? 'Room pages' : '房间分页' })
      const heights = await nav.getByRole('button').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height))
      assert.ok(heights.length >= 5)
      assert.ok(heights.every(height => height === heights[0]), JSON.stringify(heights))
      assert.equal(heights[0], mobile ? 44 : 24)
      await nav.getByRole('button', { name: locale === 'en' ? 'Next' : '下一页', exact: true }).click()
      await page.waitForFunction(() => new URL(location.href).searchParams.get('page') === '2')
      await nav.locator('[aria-current=page]').filter({ hasText: '2' }).waitFor()
      const row = page.locator('.room-row').first()
      if (!mobile) assert.ok((await row.boundingBox()).height <= 34, 'Desktop room rows should fit on one line')
      await row.getByRole('button').click()
      await page.getByRole('menuitem', { name: locale === 'en' ? 'Rename' : '重命名', exact: true }).click()
      assert.equal(new URL(page.url()).pathname, '/rooms')
      await page.getByRole('button', { name: locale === 'en' ? 'Close' : '关闭', exact: true }).click()
      // Click empty space well away from the title, not just its text.
      const link = row.getByRole('link'), box = await link.boundingBox()
      await link.click({ position: { x: box.width * 0.55, y: 2 } })
      await page.locator('.ProseMirror').waitFor()
      assert.equal(new URL(page.url()).pathname, '/room/markdown')
      await page.goto(base + 'rooms')
      const code = page.getByRole('link', { name: '实时协作 / TypeScript', exact: true })
      await code.focus(); await page.keyboard.press('Enter')
      await page.locator('.monaco-editor').waitFor()
      assert.equal(new URL(page.url()).pathname, '/room/code')
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  }
})

test('language switching covers app controls, errors, document language, and Chinese Monaco menus', async () => {
  const { page, context, errors } = await open('rooms', { locale: 'en' })
  try {
    await page.getByRole('button', { name: 'Switch language', exact: true }).click()
    await page.getByRole('heading', { name: '工作空间' }).waitFor()
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
    await page.goto(base + 'admin')
    await page.getByRole('tab', { name: '用户管理', exact: true }).waitFor()
    assert.equal(await page.getByText('All', { exact: true }).count(), 0)
    await page.goto(base + 'room/markdown')
    await page.getByRole('button', { name: '粗体', exact: true }).waitFor()
    await page.getByRole('button', { name: '插入图片', exact: true }).waitFor()
    await page.goto(base + 'room/code')
    await page.locator('.monaco-editor .view-lines').click()
    await page.keyboard.press(await page.evaluate(() => /Macintosh|Mac OS X/.test(navigator.userAgent) ? 'Meta+f' : 'Control+f'))
    await page.locator('.find-widget').getByRole('button', { name: /关闭/ }).click()
    assert.deepEqual(errors, [])
  } finally { await context.close() }
  const login = await open('login', { locale: 'zh', authenticated: false })
  try {
    await login.page.route('**/api/auth/login', route => route.fulfill({ status: 401, json: { error: 'Invalid credentials' } }))
    await login.page.locator('#username').fill('incorrect')
    await login.page.locator('#password').fill('incorrect')
    await login.page.locator('form button[type=submit]').first().click()
    await login.page.getByText('用户名或密码错误。', { exact: true }).waitFor()
    await login.page.getByRole('button', { name: '切换语言', exact: true }).click()
    await login.page.getByText('Incorrect username or password.', { exact: true }).waitFor()
    assert.equal(await login.page.locator('html').getAttribute('lang'), 'en')
    assert.deepEqual(login.errors, [])
  } finally { await login.context.close() }
})
test('Markdown fonts resize live, preserve content/editor/selection, and persist after reload', async () => {
  const { page, context, errors } = await open('room/markdown')
  await page.locator('.ProseMirror h1').waitFor().catch(async error => { console.error('Markdown load state:', await page.locator('body').innerText()); throw error })
  await page.locator('.ProseMirror').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' 字体调节不应丢失这段输入。')
  const documentText = () => page.evaluate(() => window.uiDoc.getXmlFragment('prosemirror').toString())
  let before = await documentText()
  await page.evaluate(() => { window.uiOriginalEditor = document.querySelector('.ProseMirror') })
  assert.equal(await style(page, 'fontSize'), '13px')
  await page.getByRole('button', { name: '增大字号', exact: true }).click()
  assert.equal(await style(page, 'fontSize'), '15px')
  assert.equal(await documentText(), before)
  assert.equal(await page.evaluate(() => document.querySelector('.ProseMirror') === window.uiOriginalEditor), true)
  // Test the logical cursor by continuing to type, not DOM text-node offsets
  // (Yjs cursor decorations can split or merge text nodes on blur).
  await page.locator('.ProseMirror').focus()
  await page.keyboard.insertText(' [字号后]')
  before = before.replace('字体调节不应丢失这段输入。', '字体调节不应丢失这段输入。 [字号后]')
  assert.equal(await documentText(), before)
  assert.equal(await page.getByRole('button', { name: '字体', exact: true }).count(), 0)
  assert.match(await style(page, 'fontFamily'), /Sarasa Mono/)
  assert.equal(await documentText(), before)
  assert.ok(Math.abs(await page.locator('.ProseMirror h1').evaluate(el => parseFloat(getComputedStyle(el).fontSize)) - 27) < 0.01)
  assert.equal(await page.locator('.editor-shell > [role=status], header [role=status]').count(), 0)
  assert.equal(await page.locator('footer [role=status]').count(), 1)
  await page.screenshot({ animations: 'disabled', path: screenshots + '/editor-light.png' })
  await page.getByRole('button', { name: '切换主题', exact: true }).click(); await page.screenshot({ animations: 'disabled', path: screenshots + '/editor-dark.png' })
  await page.reload(); await page.locator('.ProseMirror h1').waitFor()
  assert.equal(await style(page, 'fontSize'), '15px'); assert.match(await style(page, 'fontFamily'), /Sarasa Mono/)
  for (let i = 0; i < 8; i++) { const plus = page.getByRole('button', { name: '增大字号', exact: true }); if (await plus.isEnabled()) await plus.click() }
  assert.equal(await style(page, 'fontSize'), '24px'); assert.equal(await page.getByRole('button', { name: '增大字号', exact: true }).isDisabled(), true)
  for (let i = 0; i < 7; i++) await page.getByRole('button', { name: '减小字号', exact: true }).click()
  assert.equal(await style(page, 'fontSize'), '10px')
  assert.equal(await page.getByRole('button', { name: '减小字号', exact: true }).isDisabled(), true)
  assert.deepEqual(errors, []); await context.close()
})
test('mobile keeps bottom status and touch font controls, including save errors and landscape', async () => {
  const { page, context, errors } = await open('room/markdown', { mobile: true })
  await page.locator('.ProseMirror h1').waitFor(); await page.getByRole('button', { name: '增大字号', exact: true }).click()
  assert.equal(await style(page, 'fontSize'), '15px')
  const bottom = await page.locator('footer').boundingBox(); assert.ok(bottom.y + bottom.height <= 844)
  const touch = await page.getByRole('button', { name: '增大字号', exact: true }).boundingBox(); assert.ok(touch.width >= 44 && touch.height >= 44)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ animations: 'disabled', path: screenshots + '/editor-mobile.png' })
  await page.setViewportSize({ width: 320, height: 700 })
  for (const control of await page.locator('footer button').all()) {
    const box = await control.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 320, JSON.stringify(box))
  }
  await page.screenshot({ animations: 'disabled', path: screenshots + '/editor-320.png' })
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ui-sync-state', { detail: { isConnected: true, isSaved: false, storageFailed: true } })))
  await page.getByRole('status').getByText('暂时无法保存，编辑已保留在本机').waitFor(); assert.equal(await page.locator('footer .animate-spin').count(), 0)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ui-sync-state', { detail: { isConnected: false, isSaved: false, storageFailed: false } })))
  await page.getByRole('status').getByText('更改已保留在本机').waitFor()
  await page.setViewportSize({ width: 844, height: 390 }); await page.waitForFunction(() => document.querySelector('footer').getBoundingClientRect().bottom <= 391); assert.ok(await page.getByRole('status').isVisible())
  const landscape = await page.locator('footer').boundingBox(); assert.ok(landscape.y + landscape.height <= 391)
  assert.deepEqual(errors, []); await context.close()
})
test('workspace list, code and authentication render at desktop and phone sizes', async () => {
  for (const mobile of [false, true]) {
    const { page, context, errors } = await open('rooms', { mobile })
    await page.getByRole('heading', { name: '工作空间' }).waitFor(); await page.locator('.room-row').first().waitFor()
    assert.equal(await page.locator('.room-row').count(), 4); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ animations: 'disabled', path: screenshots + '/rooms-' + (mobile ? 'mobile' : 'desktop') + '.png' })
    await page.getByRole('link', { name: '实时协作 / TypeScript', exact: true }).click(); await page.locator('.monaco-editor').waitFor()
    await page.getByRole('button', { name: '增大字号', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.monaco-editor .view-lines')?.style.fontSize === '15px')
    await page.screenshot({ animations: 'disabled', path: screenshots + '/code-' + (mobile ? 'mobile' : 'desktop') + '.png' })
    assert.deepEqual(errors, []); await context.close()
    const guest = await open('login', { mobile, authenticated: false })
    await guest.page.locator('#username').waitFor(); await guest.page.screenshot({ animations: 'disabled', path: screenshots + '/login-' + (mobile ? 'mobile' : 'desktop') + '.png' })
    assert.equal(await guest.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await guest.context.close()
  }
})

test('DPI matrix: responsive controls fit at 1x through 3x density', async () => {
  for (const [width, height, deviceScaleFactor] of [[320, 700, 1], [1280, 800, 1.25], [1024, 768, 1.5], [768, 1024, 2], [390, 844, 3]]) {
    const { page, context, errors } = await open('room/markdown', { mobile: width < 1024, deviceScaleFactor, viewport: { width, height }, locale: 'en' })
    await page.locator('.ProseMirror h1').waitFor()
    await page.getByRole('button', { name: 'Increase font size', exact: true }).click()
    assert.equal(await style(page, 'fontSize'), '15px')
    for (const control of await page.locator('footer button, .editor-shell > header button').all()) {
      if (!await control.isVisible()) continue
      const box = await control.boundingBox()
      assert.ok(box.x >= -1 && box.x + box.width <= width + 1, JSON.stringify({ engine, width, deviceScaleFactor, box }))
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.evaluate(async () => { const { useFontStore } = await import('/src/stores/font.ts'); useFontStore.getState().setFontSize(24) })
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ProseMirror')).fontSize === '24px')
    const footer = await page.locator('footer').boundingBox()
    assert.ok(footer.y + footer.height <= height + 1)
    await page.screenshot({ animations: 'disabled', path: screenshots + '/dpi-' + deviceScaleFactor + '.png' })
    assert.deepEqual(errors, []); await context.close()
  }
})

test('room actions remain available in the compact menu and mobile dialog', async () => {
  const { page, context, errors } = await open('rooms', { mobile: true, viewport: { width: 320, height: 700 } })
  await page.locator('.room-row').first().waitFor()
  await page.locator('.room-row').first().getByRole('button', { name: /更多操作/ }).click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  const dialog = page.getByRole('dialog'); await dialog.waitFor()
  const box = await dialog.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 320)
  await page.locator('#renameRoomName').fill('一个新的房间名称')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await dialog.count(), 0)
  assert.deepEqual(errors, []); await context.close()
})

test('viewport resize keeps editor and footer visible when the keyboard reduces available height', async () => {
  const { page, context, errors } = await open('room/markdown', { mobile: true })
  await page.locator('.ProseMirror h1').waitFor()
  await page.locator('.ProseMirror').click()
  await page.keyboard.insertText('键盘输入')
  await page.setViewportSize({ width: 390, height: 400 })
  await page.waitForFunction(() => document.querySelector('footer').getBoundingClientRect().bottom <= 401)
  const editor = await page.locator('.md-editor-body').boundingBox()
  assert.ok(editor.height > 100)
  await page.getByRole('button', { name: '增大字号', exact: true }).click()
  assert.equal(await style(page, 'fontSize'), '15px')
  assert.deepEqual(errors, []); await context.close()
})

test('Monaco find controls remain clickable after their hints open at different DPI', async () => {
  for (const [width, deviceScaleFactor] of [[1440, 1], [1024, 1.25], [768, 2], [390, 3]]) {
    const { page, context, errors } = await open('room/code', { viewport: { width, height: 800 }, deviceScaleFactor, locale: 'en' })
    try {
      await page.locator('.monaco-editor').waitFor()
      await page.locator('.monaco-editor .view-lines').click()
      await page.keyboard.press(await page.evaluate(() => /Macintosh|Mac OS X/.test(navigator.userAgent) ? 'Meta+f' : 'Control+f'))
      const widget = page.locator('.find-widget')
      await widget.locator('textarea').first().fill('greet')
      for (const name of [/Next Match/, /Previous Match/, /Close/]) {
        const button = widget.getByRole('button', { name })
        await button.hover()
        const hint = page.locator('.workbench-hover').filter({ hasText: name })
        await hint.waitFor()
        // Wait past the fade-in, then hit-test the exact center of the trigger.
        await hint.evaluate(async el => { await Promise.all(el.getAnimations().map(a => a.finished)) })
        assert.equal(await button.evaluate(el => {
          const r = el.getBoundingClientRect()
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        }), true, `${engine}: ${name} at ${width}px / ${deviceScaleFactor}x`)
        await button.click({ timeout: 3000 })
      }
      await page.waitForFunction(() => !document.querySelector('.find-widget')?.classList.contains('visible'))
      // The editor should retain its content and accept input after dismissal.
      await page.keyboard.press('Control+End')
      await page.keyboard.insertText('// find closed')
      assert.ok(await page.evaluate(() => window.uiDoc.getText('codemirror').toString().includes('// find closed')))
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  }
})
