import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'

// Any Playwright engine works: UI_BROWSER=chromium|firefox|webkit (chromium default).
// Each engine gets its own Vite cache so pre-bundled dependencies never mix engines.
const engine = process.env.UI_BROWSER ?? 'chromium'
const engines = { chromium, firefox, webkit }
const launchBrowser = engines[engine]
if (!launchBrowser) throw new Error(`UI_BROWSER must be chromium, firefox or webkit, not ${engine}`)

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
  await mkdir(`.cache/client-chrome-${engine}`, { recursive: true })
  server = await createServer({
    configFile: resolve('vite.client.config.ts'), logLevel: 'error',
    cacheDir: `node_modules/.vite/client-chrome-${engine}`,
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    plugins: [{ name: 'client-chrome-fixtures', enforce: 'pre', load(id) {
      if (id.endsWith('/src/hooks/use-yjs-provider.ts')) return provider
      if (id.endsWith('/src/hooks/use-monaco-editor.ts')) return monaco
    } }],
  })
  await server.listen(); base = server.resolvedUrls.local[0]
  browser = await launchBrowser.launch({ headless: true })
})
after(async () => { await browser?.close(); await server?.close() })

// The client is a Windows app in the baseline tests unless a Mac user agent is requested;
// macOS assertions reuse the same open() with `mac: true`.
async function open({ width = 1100, scale = 1, saved, locale = 'en', touch = false, mac = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 760 }, deviceScaleFactor: scale, hasTouch: touch, reducedMotion: 'reduce',
    userAgent: mac ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15' : undefined,
  })
  await context.addInitScript(({ saved, locale }) => {
    localStorage.setItem('i18nextLng', locale)
    if (saved && !localStorage.getItem('sharecode-client-window')) localStorage.setItem('sharecode-client-window', JSON.stringify(saved))
    let id = 0
    const callbacks = new Map(), listeners = new Map()
    window.nativeCalls = []
    window.nativeState = { clickThrough: false, screenCaptureProtection: true, hideFromTaskbar: true }
    window.nativeFail = null // set a command name to make the next invoke of it reject
    window.nativeMaximized = false
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: event => listeners.delete(event) }
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: handler => { callbacks.set(++id, handler); return id },
      invoke: async (command, args = {}) => {
        window.nativeCalls.push({ command, args })
        if (window.nativeFail === command) { window.nativeFail = null; throw new Error(`mock failure: ${command}`) }
        if (command === 'plugin:event|listen') { listeners.set(args.event, args.handler); return args.handler }
        if (command === 'get_stealth_state') return window.nativeState
        if (command === 'set_stealth_state') return window.nativeState = args
        if (command === 'client_is_maximized') return window.nativeMaximized
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
      await page.screenshot({ path: `.cache/client-chrome-${engine}/toolbar-${width}-${scale}-${touch}.png` })
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: locale === 'en' ? 'Back' : '返回', exact: true }).click()
      await page.locator('.editor-toolbar').waitFor({ state: 'detached' })
      assert.equal(await page.locator('.client-title-fallback').isVisible(), true)
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  }
})

async function appearance(page, theme, background, text = 0.9) {
  await page.evaluate(async ({ theme, background, text }) => {
    // Measure final colours rather than intermediate transition frames. Reduced-motion
    // CSS still gives every element a tiny nonzero transition duration in this app.
    if (!document.getElementById('appearance-test-transitions')) {
      const style = document.createElement('style'); style.id = 'appearance-test-transitions'
      style.textContent = 'body, body *, body *::before, body *::after { transition-property: none !important; }'
      document.head.append(style)
    }
    const { useThemeStore } = await import('/src/stores/theme.ts')
    const { useWindowPreferences } = await import('/src/client/window.ts')
    useThemeStore.getState().setTheme(theme)
    useWindowPreferences.getState().setOpacity(text, background)
  }, { theme, background, text })
  await page.waitForFunction(({ background, text }) =>
    document.body.style.getPropertyValue('--client-bg-alpha') === String(background) &&
    document.body.style.getPropertyValue('--client-text-alpha') === String(text), { background, text })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

// Canvas converts CSS colour spaces (including color-mix) to comparable sRGB bytes.
async function paintedColor(locator, property, pseudo = null) {
  return locator.evaluate((el, { property, pseudo }) => {
    const color = getComputedStyle(el, pseudo).getPropertyValue(property)
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1)
    return [...ctx.getImageData(0, 0, 1, 1).data]
  }, { property, pseudo })
}
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 2, `${label}: ${actual} vs ${expected}`)
const distance = (left, right) => Math.hypot(...left.slice(0, 3).map((value, index) => value - right[index]))

test('transparency boosts neutral contrast and fades settings/menu surfaces without fading labels', async () => {
  const { page, context, errors } = await open()
  try {
    await enterRoom(page)
    for (const theme of ['light', 'dark']) {
      await page.getByRole('button', { name: 'Window settings', exact: true }).click()
      const panel = page.getByRole('dialog'), muted = panel.locator('.text-muted-foreground').first()
      let lastTextDistance = Infinity, lastBorderDistance = Infinity
      for (const background of [1, 0.65, 0.35, 0.1]) {
        await appearance(page, theme, background)
        const foreground = await paintedColor(page.locator('.client-shell'), 'color')
        const gray = await paintedColor(muted, 'color'), border = await paintedColor(panel, 'border-top-color')
        const textDistance = distance(gray, foreground), borderDistance = distance(border, foreground)
        assert.ok(textDistance < lastTextDistance, `${theme} gray must approach foreground at ${background}: gray=${gray} foreground=${foreground} distance=${textDistance} previous=${lastTextDistance}`)
        assert.ok(borderDistance < lastBorderDistance, `${theme} border must approach foreground at ${background}: ${borderDistance} previous=${lastBorderDistance}`)
        lastTextDistance = textDistance; lastBorderDistance = borderDistance
        near(gray[3], 0.9 * 255, 'gray follows text alpha')
        near(border[3], 0.9 * 255, 'border stays readable at low background opacity')
        near((await paintedColor(panel, 'background-color'))[3], background * 255, 'settings surface alpha')
        near((await paintedColor(panel.getByRole('button', { name: 'Recommended', exact: true }), 'background-color'))[3], background === 0.65 ? background * 255 : 0, 'preset fill')
      }
      assert.ok(lastTextDistance < 5 && lastBorderDistance < 5, 'at minimum opacity both approach theme foreground')
      await appearance(page, theme, 0.65, 0.5)
      near((await paintedColor(muted, 'color'))[3], 0.5 * 255, 'text slider remains independent')
      near((await paintedColor(panel, 'background-color'))[3], 0.65 * 255, 'text slider leaves panel fill unchanged')
      await appearance(page, theme, 0.35)
      await page.screenshot({ path: `.cache/client-chrome-${engine}/settings-transparent-${theme}.png`, omitBackground: true })
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'More actions', exact: true }).click()
      near((await paintedColor(page.getByRole('menu'), 'background-color'))[3], 0.35 * 255, 'room menu alpha')
      await page.keyboard.press('Escape')
    }
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('native and real Monaco scrollbars use transparent tracks and adjustable translucent thumbs', async () => {
  const { page, context, errors } = await open()
  try {
    await enterRoom(page)
    await page.evaluate(async () => {
      const scroller = document.createElement('div')
      scroller.id = 'scroll-fixture'; scroller.style.cssText = 'width:160px;height:90px;overflow:scroll;position:absolute;left:20px;top:50px'
      scroller.innerHTML = '<div style="width:300px;height:300px">Scroll area</div>'
      document.querySelector('.client-content').append(scroller)
      const host = document.createElement('div')
      host.style.cssText = 'width:500px;height:260px;position:absolute;left:200px;top:50px'
      document.querySelector('.client-content').append(host)
      const { loadMonaco } = await import('/src/lib/monaco-loader.ts')
      const monaco = await loadMonaco()
      window.testMonaco = monaco
      window.scrollEditor = monaco.editor.create(host, { value: Array.from({ length: 100 }, (_, i) => `${i}: ${'scroll '.repeat(50)}`).join('\n'), minimap: { enabled: false }, wordWrap: 'off', overviewRulerBorder: false, scrollbar: { vertical: 'visible', horizontal: 'visible' } })
    })
    const native = page.locator('#scroll-fixture')
    const thumb = page.locator('.monaco-scrollable-element > .scrollbar.vertical > .slider').first()
    await thumb.waitFor()
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => window.testMonaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs'), theme)
      let previousAlpha = Infinity
      for (const background of [1, 0.65, 0.1]) {
        await appearance(page, theme, background)
        const color = await paintedColor(thumb, 'background-color')
        assert.ok(color[3] > 0 && color[3] < 255 && color[3] < previousAlpha, `Monaco thumb fades, stays translucent and visible: ${theme}, bg=${background}, rgba=${color}, previous=${previousAlpha}`)
        previousAlpha = color[3]
        assert.equal((await paintedColor(thumb.locator('..'), 'background-color'))[3], 0, 'Monaco track is transparent')
        assert.equal((await paintedColor(native, 'background-color', '::-webkit-scrollbar-track'))[3], 0, 'native track is transparent')
        const nativeThumb = await paintedColor(native, 'background-color', '::-webkit-scrollbar-thumb')
        near(nativeThumb[3], color[3], 'native and Monaco thumbs agree')
        assert.match(await native.evaluate(el => getComputedStyle(el).scrollbarColor), /rgba\(0, 0, 0, 0\)/, 'standard scrollbar track is transparent')
      }
    }
    await page.evaluate(() => window.scrollEditor.dispose())
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('real Canvas toolbar, zoom/history controls and menu stay translucent after lazy load and theme changes', async () => {
  const { page, context, errors } = await open()
  try {
    await enterRoom(page)
    await appearance(page, 'light', 0.65)
    await page.evaluate(() => { location.hash = '/room/ui-room?view=canvas' })
    const toolbar = page.locator('.excalidraw .App-toolbar')
    await toolbar.waitFor()
    for (const theme of ['light', 'dark']) {
      for (const background of [1, 0.65, 0.35, 0.1]) {
        await appearance(page, theme, background)
        if (theme === 'dark') await page.locator('.excalidraw.theme--dark').waitFor()
        for (const selector of ['.App-toolbar', '.zoom-actions', '.undo-redo-buttons']) {
          near((await paintedColor(page.locator(`.excalidraw ${selector}`).first(), 'background-color'))[3], background * 255, `${theme} ${selector} surface alpha`)
        }
        for (const selector of ['.zoom-actions button', '.undo-redo-buttons button']) {
          assert.equal((await paintedColor(page.locator(`.excalidraw ${selector}`).first(), 'background-color'))[3], 0, 'idle buttons do not double paint the group background')
        }
        const hint = page.locator('.excalidraw .HintViewer')
        if (await hint.count()) {
          const hintColor = await paintedColor(hint, 'color')
          near(hintColor[3], 0.9 * 255, 'canvas hints follow text alpha')
          if (background === 0.1) assert.ok(distance(hintColor, await paintedColor(page.locator('.client-shell'), 'color')) < 5, 'canvas hints approach foreground too')
        }
        const icon = page.locator('.excalidraw .App-toolbar .ToolIcon__icon svg').first()
        near((await paintedColor(icon, 'color'))[3], 0.9 * 255, 'canvas icon alpha remains independent')
      }
      await appearance(page, theme, 0.35)
      await page.locator('.excalidraw .dropdown-menu-button').first().click()
      const menu = page.locator('.excalidraw .dropdown-menu-container')
      await menu.waitFor()
      near((await paintedColor(menu, 'background-color'))[3], 0.35 * 255, 'canvas menu surface alpha')
      await page.screenshot({ path: `.cache/client-chrome-${engine}/canvas-transparent-${theme}.png`, omitBackground: true })
      await page.keyboard.press('Escape')
    }
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})
