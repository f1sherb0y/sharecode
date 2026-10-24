import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'

// Headless only: no OS input injection, live account, or desktop application is used.
let server, browser, base
const provider = `
import { useMemo } from 'react'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
export function useYjsProvider(name) {
  return useMemo(() => { const ydoc = new Y.Doc(); return {
    ydoc, ytext: ydoc.getText('codemirror'), ymeta: ydoc.getMap('meta'),
    provider: { awareness: new Awareness(ydoc), configuration: { name } },
    isConnected: true, isSynced: true, canWrite: true, isSaved: true,
    waitForSaved: async () => {}, syncError: '', storageFailed: false, onlineUsers: [],
  } }, [name])
}`
const monaco = `
import { useRef } from 'react'
export function useMonacoEditor() { return {
  editorRef: useRef(null), monacoRef: useRef(null), editorInstanceRef: useRef(null), modelRef: useRef(null),
  isEditorReady: false, hasSelection: false, updateLanguage: () => {}, blinkSelection: () => {},
} }
`
before(async () => {
  await mkdir('.cache/client-chrome', { recursive: true })
  server = await createServer({
    configFile: resolve('vite.client.config.ts'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    plugins: [{ name: 'client-chrome-fixtures', enforce: 'pre', load(id) {
      if (id.endsWith('/src/hooks/use-yjs-provider.ts')) return provider
      if (id.endsWith('/src/hooks/use-monaco-editor.ts')) return monaco
      if (id.endsWith('/src/components/features/canvas-view.tsx')) return 'export function CanvasView() { return <div data-testid="canvas-fixture" /> }'
    } }],
  })
  await server.listen(); base = server.resolvedUrls.local[0]
  browser = await chromium.launch({ headless: true })
})
after(async () => { await browser?.close(); await server?.close() })

async function open({ width = 1100, scale = 1, saved, locale = 'en', touch = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: scale, hasTouch: touch })
  await context.addInitScript(({ saved, locale }) => {
    localStorage.setItem('i18nextLng', locale)
    if (saved && !localStorage.getItem('sharecode-client-window')) localStorage.setItem('sharecode-client-window', JSON.stringify(saved))
    let id = 0
    const callbacks = new Map(), listeners = new Map()
    window.nativeCalls = []
    window.nativeState = { clickThrough: false, screenCaptureProtection: true, hideFromTaskbar: true }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: event => listeners.delete(event) }
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: handler => { callbacks.set(++id, handler); return id },
      invoke: async (command, args = {}) => {
        window.nativeCalls.push({ command, args })
        if (command === 'plugin:event|listen') { listeners.set(args.event, args.handler); return args.handler }
        if (command === 'get_stealth_state') return window.nativeState
        if (command === 'set_stealth_state') return window.nativeState = args
        if (command === 'plugin:window|is_maximized') return false
        return null
      },
    }
    window.shortcutState = clickThrough => {
      window.nativeState = { ...window.nativeState, clickThrough }
      callbacks.get(listeners.get('sharecode:stealth-state'))({ payload: window.nativeState })
    }
  }, { saved, locale })
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin
    ? route.continue() : route.fulfill({ status: 404, body: '' }))
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base + 'client.html')
  await page.waitForFunction(() => document.querySelector('[aria-keyshortcuts]')?.disabled === false)
  return { page, context, errors }
}
const opacity = page => page.evaluate(() => [
  document.body.style.getPropertyValue('--client-text-alpha'), document.body.style.getPropertyValue('--client-bg-alpha'),
])
async function enterRoom(page) {
  await page.evaluate(async () => {
    const { useAuthStore } = await import('/src/stores/auth.ts')
    useAuthStore.setState({ token: 'ui-fixture', sessionId: 'ui-session', actorType: 'guest', isLoading: false, isInitialized: true,
      guestProfile: { guest: { id: 'guest', displayName: 'Customer', color: '#218568', canEdit: true }, shareToken: 'ui-share',
        room: { id: 'ui-room', name: 'A long collaborative room title / 项目协作', language: 'typescript', isEnded: false } },
    })
    location.hash = '/room/ui-room'
  })
  await page.locator('.client-title-bar .editor-toolbar').waitFor()
}

test('opacity defaults, old-default migration and custom preferences', async () => {
  for (const [saved, expected] of [
    [undefined, ['0.9', '0.65']],
    [{ version: 0, state: { pinned: false, textOpacity: 1, backgroundOpacity: 1 } }, ['0.9', '0.65']],
    [{ version: 0, state: { pinned: true, textOpacity: 0.75, backgroundOpacity: 0.4 } }, ['0.75', '0.4']],
  ]) {
    const { page, context, errors } = await open({ saved })
    try { assert.deepEqual(await opacity(page), expected); assert.deepEqual(errors, []) }
    finally { await context.close() }
  }
})

test('button and native shortcut sync pinning; disabling click-through preserves pin', async () => {
  const { page, context, errors } = await open()
  try {
    await page.locator('[aria-keyshortcuts]').click()
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sharecode-client-window')).state.pinned)
    await page.waitForFunction(() => window.nativeCalls.some(call => call.command === 'plugin:window|set_always_on_top' && call.args.value === true))
    await page.evaluate(() => window.shortcutState(false))
    assert.equal(await page.locator('[aria-keyshortcuts]').getAttribute('aria-pressed'), 'false')
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sharecode-client-window')).state.pinned), true)
    await page.evaluate(async () => { const { useWindowPreferences } = await import('/src/client/window.ts'); useWindowPreferences.getState().setPinned(false) })
    await page.evaluate(() => window.shortcutState(true))
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sharecode-client-window')).state.pinned)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('merged toolbar fits minimum width and DPI layouts; menus and navigation still work', async () => {
  for (const [width, scale, locale, touch = false] of [[480, 1, 'en'], [768, 1.25, 'zh'], [1100, 2, 'en'], [480, 1, 'zh', true]]) {
    const { page, context, errors } = await open({ width, scale, locale, touch })
    try {
      await enterRoom(page)
      assert.equal(await page.locator('.editor-shell > header').count(), 0)
      assert.equal(await page.locator('.client-title-bar .editor-toolbar').count(), 1)
      const layout = await page.evaluate(() => {
        const bar = document.querySelector('.client-title-bar'), content = document.querySelector('.client-content')
        const barBox = bar.getBoundingClientRect()
        const bad = [...bar.querySelectorAll('button')].filter(el => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && (r.left < 0 || r.right > innerWidth || r.top < barBox.top || r.bottom > barBox.bottom + 1)
        }).map(el => el.getAttribute('aria-label'))
        return { height: barBox.height, contentTop: content.getBoundingClientRect().top, bad }
      })
      assert.ok(layout.height <= (touch ? 44 : 36), JSON.stringify(layout))
      assert.equal(layout.contentTop, layout.height)
      if (!touch) assert.deepEqual(layout.bad, [], `clipped toolbar at ${width}px`)
      const settings = page.getByRole('button', { name: locale === 'en' ? 'Window settings' : '窗口设置', exact: true })
      await settings.click()
      await page.getByRole('slider').first().waitFor()
      assert.deepEqual(await page.getByRole('slider').evaluateAll(nodes => nodes.map(el => Number(el.value))), [90, 65])
      await page.screenshot({ path: `.cache/client-chrome/toolbar-${width}-${scale}-${touch}.png` })
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: locale === 'en' ? 'Back' : '返回', exact: true }).click()
      await page.locator('.editor-toolbar').waitFor({ state: 'detached' })
      assert.equal(await page.locator('.client-title-fallback').isVisible(), true)
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  }
})
