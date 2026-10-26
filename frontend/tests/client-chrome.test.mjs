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
async function open({ width = 1100, height = 760, scale = 1, saved, locale = 'en', touch = false, mac = false, hotkeyPhase = 'listening', savedStealth, setup = false, canDrag = true, sharing = false, capturePermission = true, setupRecording = false, setupProgress } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: scale, hasTouch: touch, reducedMotion: 'reduce',
    userAgent: mac ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  })
  await context.addInitScript(({ saved, locale, mac, hotkeyPhase, savedStealth, setup, canDrag, sharing, capturePermission, setupRecording, setupProgress }) => {
    localStorage.setItem('i18nextLng', locale)
    if (setupProgress && !localStorage.getItem('sharecode-macos-permission-setup-v1')) localStorage.setItem('sharecode-macos-permission-setup-v1', setupProgress)
    if (saved && !localStorage.getItem('sharecode-client-window')) localStorage.setItem('sharecode-client-window', JSON.stringify(saved))
    if (savedStealth) localStorage.setItem('sharecode-client-stealth', JSON.stringify({ state: savedStealth, version: 0 }))
    let id = 0
    const callbacks = new Map(), listeners = new Map()
    window.nativeCalls = []
    window.nativeState = { clickThrough: false, screenCaptureProtection: true, hideFromTaskbar: true }
    window.captureState = { supported: true, permission: capturePermission, running: false,
      phase: capturePermission ? 'idle' : 'permissionRequired', displays: capturePermission ? [{ id: 7, width: 1920, height: 1080 }, { id: 9, width: 1440, height: 900 }] : [] }
    window.nativeFail = null // set a command name to make the next invoke of it reject
    window.nativeMaximized = false
    window.nativeHotkey = { revision: 0, ready: hotkeyPhase === 'listening', phase: hotkeyPhase, received: 0, testing: false, lastAction: null, error: null }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: event => listeners.delete(event) }
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: setup ? 'input-monitoring' : 'main' }, currentWebview: { label: setup ? 'input-monitoring' : 'main' } },
      transformCallback: handler => { callbacks.set(++id, handler); return id },
      invoke: async (command, args = {}) => {
        window.nativeCalls.push({ command, args })
        if (window.nativeFail === command) { window.nativeFail = null; throw new Error(`mock failure: ${command}`) }
        if (command === 'plugin:event|listen') { listeners.set(args.event, args.handler); return args.handler }
        if (['open_client_recording_setup', 'open_client_hotkey_setup'].includes(command)) {
          callbacks.get(listeners.get('sharecode:permission-step'))?.({ payload: command === 'open_client_recording_setup' })
          return null
        }
        if (command === 'client_screen_share') {
          if (args.action === 'start' && window.captureState.permission) window.captureState = { ...window.captureState, phase: 'sharing', running: true, selectedDisplay: args.displayId }
          if (args.action === 'stop') window.captureState = { ...window.captureState, phase: 'stopped', running: false }
          return structuredClone(window.captureState)
        }
        if (command === 'get_stealth_state') return window.nativeState
        if (command === 'set_stealth_state') {
          if (mac) {
            const next = args.changedField ? { ...window.nativeState, [args.changedField]: args[args.changedField] }
              : { clickThrough: false, screenCaptureProtection: args.screenCaptureProtection, hideFromTaskbar: args.hideFromTaskbar }
            if (next.clickThrough && window.nativeHotkey.phase !== 'listening') throw new Error('Input Monitoring required')
            window.nativeState = next
            if (window.deferStealthReply) {
              window.deferStealthReply = false
              await new Promise(resolve => { window.releaseStealthReply = resolve })
            }
            return next
          }
          return window.nativeState = args
        }
        if (command === 'get_client_hotkey_status') return window.nativeHotkey
        if (command === 'show_client_main') {
          if (!window.nativeHotkey.ready || (window.captureState.supported && !window.captureState.permission)) throw new Error('Native permissions required')
          return null
        }
        if (command === 'get_client_application') return { name: 'ShareCode Setup Test', path: '/Applications/ShareCode Setup Test.app', canDrag }
        if (command === 'test_client_hotkey') { window.hotkeyStatus({ testing: true, lastAction: null }); return null }
        if (command === 'client_is_maximized') return window.nativeMaximized
        if (command === 'plugin:window|is_maximized') return false
        return null
      },
    }
    window.shortcutState = clickThrough => {
      window.nativeState = { ...window.nativeState, clickThrough }
      callbacks.get(listeners.get('sharecode:stealth-state'))({ payload: window.nativeState })
    }
    window.hotkeyStatus = patch => {
      window.nativeHotkey = { ...window.nativeHotkey, ...(patch.phase ? { ready: patch.phase === 'listening' } : {}), ...patch, revision: window.nativeHotkey.revision + 1 }
      callbacks.get(listeners.get('sharecode:hotkey-status'))?.({ payload: window.nativeHotkey })
    }
    window.staleHotkeyStatus = status => callbacks.get(listeners.get('sharecode:hotkey-status'))?.({ payload: status })
  }, { saved, locale, mac, hotkeyPhase, savedStealth, setup, canDrag, sharing, capturePermission, setupRecording, setupProgress })
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin
    ? route.continue() : route.fulfill({ status: 404, body: '' }))
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base + 'client.html' + (setup ? '#/input-monitoring' + (setupRecording ? '?recording=1' : '') : ''))
  if (setup) await page.getByTestId('setup-status').waitFor()
  else await page.waitForFunction(async () => (await import('/src/client/window.ts')).useStealthPreferences.getState().ready)
  if (sharing) {
    await page.getByRole('button', { name: locale === 'zh' ? '共享画面' : 'Shared screen', exact: true }).click()
    await page.locator('.screen-share-status').filter({ hasText: capturePermission ? /已就绪|Ready to share/ : /需要屏幕录制权限|Screen Recording permission required/ }).waitFor()
  }
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

test('macOS requires explicit Input Monitoring and never restores saved click-through', async () => {
  const { page, context, errors } = await open({ mac: true, hotkeyPhase: 'permissionRequired',
    savedStealth: { clickThrough: true, screenCaptureProtection: true, hideFromTaskbar: true } })
  try {
    await page.getByRole('button', { name: 'Window settings', exact: true }).click()
    await page.getByTestId('hotkey-status').filter({ hasText: 'Input Monitoring permission required' }).waitFor()
    assert.equal(await page.locator('[aria-keyshortcuts]').isDisabled(), true)
    assert.equal(await page.locator('[data-control="minimize"]').isDisabled(), true)
    assert.equal(await page.evaluate(() => window.nativeState.clickThrough), false)
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'request_client_hotkey_permission')), false)
    await page.getByRole('button', { name: 'Enable Input Monitoring', exact: true }).click()
    assert.equal(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'request_client_hotkey_permission').length), 1)
    await page.getByRole('button', { name: 'Input Monitoring settings', exact: true }).click()
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'open_client_hotkey_setup')), true)
    // Grant is reported by native status, not assumed merely because the prompt was requested.
    assert.equal(await page.locator('[aria-keyshortcuts]').isDisabled(), true)
    await page.evaluate(() => window.hotkeyStatus({ phase: 'listening' }))
    await page.waitForFunction(() => !document.querySelector('[aria-keyshortcuts]').disabled)
    await page.keyboard.press('Escape')
    await page.locator('[aria-keyshortcuts]').click()
    await page.waitForFunction(() => window.nativeState.clickThrough)
    assert.equal(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'set_stealth_state').at(-1).args.changedField), 'clickThrough')
    await page.evaluate(() => { window.shortcutState(false); window.hotkeyStatus({ phase: 'permissionRequired' }) })
    await page.waitForFunction(() => document.querySelector('[aria-keyshortcuts]').disabled)
    assert.equal(await page.locator('[aria-keyshortcuts]').getAttribute('aria-pressed'), 'false')
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('macOS shortcut test reports delivery without toggling and ignores stale availability', async () => {
  const { page, context, errors } = await open({ mac: true })
  try {
    await page.getByRole('button', { name: 'Window settings', exact: true }).click()
    const status = page.getByTestId('hotkey-status')
    await status.filter({ hasText: 'Native shortcut listener active' }).waitFor()
    await page.getByRole('button', { name: 'Test shortcut', exact: true }).click()
    await page.getByText('Press Ctrl + Shift + F within 15 seconds.', { exact: false }).waitFor()
    await page.evaluate(() => window.hotkeyStatus({ testing: false, received: 1, lastAction: 'tested' }))
    await page.getByText('Shortcut received. The window was not changed.', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.nativeState.clickThrough), false)
    for (const phase of ['secureInput', 'recovering', 'failed']) {
      await page.evaluate(phase => window.hotkeyStatus({ phase }), phase)
      await page.waitForFunction(() => document.querySelector('[aria-keyshortcuts]').disabled)
      await page.evaluate(() => window.staleHotkeyStatus({ ...window.nativeHotkey, revision: 0, ready: true, phase: 'listening' }))
      assert.equal(await page.locator('[aria-keyshortcuts]').isDisabled(), true)
    }
    await page.evaluate(() => window.hotkeyStatus({ phase: 'listening', lastAction: 'testTimedOut' }))
    await page.getByText('No shortcut received. Check permission and try again.', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    await page.screenshot({ path: `.cache/client-chrome-${engine}/mac-native-hotkey.png` })
  } finally { await context.close() }
})

test('macOS ignores an old setting response after a newer native shortcut event', async () => {
  const { page, context, errors } = await open({ mac: true })
  try {
    await page.waitForFunction(async () => (await import('/src/client/hotkey.ts')).useMacHotkey.getState().ready)
    await page.evaluate(async () => {
      const { useStealthPreferences } = await import('/src/client/window.ts')
      window.deferStealthReply = true
      useStealthPreferences.getState().setScreenCaptureProtection(false)
    })
    await page.waitForFunction(() => typeof window.releaseStealthReply === 'function')
    await page.evaluate(() => { window.shortcutState(true); window.releaseStealthReply() })
    await page.waitForFunction(async () => !(await import('/src/client/window.ts')).useStealthPreferences.getState().busy)
    const state = await page.evaluate(async () => {
      const { clickThrough, screenCaptureProtection } = (await import('/src/client/window.ts')).useStealthPreferences.getState()
      return { clickThrough, screenCaptureProtection }
    })
    assert.deepEqual(state, { clickThrough: true, screenCaptureProtection: false })
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('macOS shortcut controls fit a minimum-height window and keep in-app input focus', async () => {
  const { page, context, errors } = await open({ mac: true, width: 480, height: 360 })
  try {
    const input = page.getByRole('textbox').first()
    await input.fill('focus stays here')
    await page.evaluate(() => window.shortcutState(true))
    assert.equal(await input.evaluate(el => el === document.activeElement), true)
    await page.evaluate(() => window.shortcutState(false))
    assert.equal(await input.evaluate(el => el === document.activeElement), true)
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'plugin:window|set_focus')), false)
    await page.getByRole('button', { name: 'Window settings', exact: true }).click()
    await page.getByRole('button', { name: 'Test shortcut', exact: true }).scrollIntoViewIfNeeded()
    const box = await page.getByRole('dialog').boundingBox()
    assert.ok(box.y >= 0 && box.y + box.height <= 360, JSON.stringify(box))
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('button and native shortcut sync pinning; disabling click-through preserves pin', async () => {
  const { page, context, errors } = await open()
  try {
    await page.locator('[aria-keyshortcuts]').click()
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sharecode-client-window')).state.pinned)
    await page.waitForFunction(() => window.nativeCalls.some(call => call.command === 'client_set_pinned' && call.args.pinned === true))
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
      // Firefox cannot override the screenshot background; alpha is asserted above.
      await page.screenshot({ path: `.cache/client-chrome-${engine}/settings-transparent-${theme}.png`, omitBackground: engine !== 'firefox' })
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
        if (engine !== 'firefox') {
          assert.equal((await paintedColor(native, 'background-color', '::-webkit-scrollbar-track'))[3], 0, 'native track is transparent')
          const nativeThumb = await paintedColor(native, 'background-color', '::-webkit-scrollbar-thumb')
          near(nativeThumb[3], color[3], 'native and Monaco thumbs agree')
        }
        // Firefox uses the standard property, not WebKit's scrollbar pseudo-elements.
        // Split only at top-level whitespace: CSS colour functions contain spaces.
        const standard = await native.evaluate(el => {
          const value = getComputedStyle(el).scrollbarColor
          const colors = []; let depth = 0, token = ''
          for (const char of value) {
            if (/\s/.test(char) && depth === 0) {
              if (token) { colors.push(token); token = '' }
            } else {
              token += char
              if (char === '(') depth++
              if (char === ')') depth--
            }
          }
          if (token) colors.push(token)
          return colors.map(color => {
            if (!CSS.supports('color', color)) throw new Error(`Invalid scrollbar colour: ${value}`)
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
            const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1)
            return [...ctx.getImageData(0, 0, 1, 1).data]
          })
        })
        assert.equal(standard.length, 2, 'standard scrollbar defines thumb and track colours')
        assert.equal(standard[1][3], 0, 'standard scrollbar track is transparent')
        near(standard[0][3], color[3], 'standard native and Monaco thumbs agree')
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
      await page.screenshot({ path: `.cache/client-chrome-${engine}/canvas-transparent-${theme}.png`, omitBackground: engine !== 'firefox' })
      await page.keyboard.press('Escape')
    }
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('macOS resumes unfinished setup without automatically requesting permission; manual reopen remains available', async () => {
  const { page, context, errors } = await open({ mac: true, hotkeyPhase: 'permissionRequired' })
  try {
    await page.waitForFunction(() => localStorage.getItem('sharecode-input-monitoring-guide-shown') === '1')
    assert.equal(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'open_client_hotkey_setup').length), 1)
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'request_client_hotkey_permission')), false)
    await page.reload()
    await page.getByRole('button', { name: 'Window settings', exact: true }).click()
    await page.getByTestId('hotkey-status').filter({ hasText: 'Input Monitoring permission required' }).waitFor()
    assert.equal(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'open_client_hotkey_setup').length), 1)
    await page.getByRole('button', { name: 'Input Monitoring settings', exact: true }).click()
    await page.waitForFunction(() => window.nativeCalls.some(c => c.command === 'open_client_hotkey_setup'))
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('filtered screen source is a macOS-only in-app popover', async () => {
  for (const mac of [false, true]) {
    const { page, context, errors } = await open({ mac, locale: 'zh' })
    try {
      const button = page.getByRole('button', { name: '共享画面', exact: true })
      assert.equal(await button.count(), mac ? 1 : 0)
      assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'open_client_screen_share')), false)
      if (mac) {
        await button.click()
        await page.locator('.screen-share-menu').waitFor()
        assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'open_client_screen_share')), false)
        await page.keyboard.press('Escape')
        assert.equal(await page.locator('.screen-share-menu').count(), 0)
      }
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  }
})

test('setup helper drags the actual app only on a drag gesture and gates testing on native readiness', async () => {
  const { page, context, errors } = await open({ mac: true, hotkeyPhase: 'permissionRequired', setup: true, width: 420, height: 570 })
  try {
    const app = page.getByTestId('setup-drag-app')
    await page.waitForFunction(() => !document.querySelector('[data-testid="setup-drag-app"]').disabled)
    await app.click()
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'drag_client_application')), false)
    const box = await app.boundingBox()
    await page.mouse.move(box.x + 40, box.y + 30)
    await page.mouse.down()
    await page.mouse.move(box.x + 65, box.y + 30, { steps: 4 })
    await page.mouse.up()
    await page.waitForFunction(() => window.nativeCalls.some(c => c.command === 'drag_client_application'))
    assert.equal(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'drag_client_application').length), 1)
    assert.equal(await page.getByRole('button', { name: 'Test shortcut', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: 'Open Input Monitoring', exact: true }).click()
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'open_client_hotkey_settings')), true)
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => ['set_stealth_state', 'request_client_hotkey_permission', 'plugin:updater|check'].includes(c.command))), false)
    await page.evaluate(() => window.hotkeyStatus({ phase: 'listening' }))
    await page.getByRole('button', { name: 'Test shortcut', exact: true }).click()
    await page.evaluate(() => window.hotkeyStatus({ testing: false, lastAction: 'tested' }))
    await page.getByText('Shortcut received. The window was not changed.', { exact: true }).waitFor()
    await page.evaluate(() => window.hotkeyStatus({ phase: 'permissionRequired' }))
    await page.waitForFunction(() => document.querySelector('.input-monitoring-primary').disabled)
    await page.screenshot({ path: `.cache/client-chrome-${engine}/input-monitoring-en.png` })
    await page.getByRole('button', { name: 'Later', exact: true }).click()
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'plugin:window|close')), true)
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'show_client_main')), false)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('setup handles an uninstalled app and command failures, with readable Chinese instructions', async () => {
  const { page, context, errors } = await open({ mac: true, hotkeyPhase: 'permissionRequired', setup: true, canDrag: false, locale: 'zh', width: 420, height: 570 })
  try {
    await page.getByRole('alert').filter({ hasText: '请先将应用移到' }).waitFor()
    assert.equal(await page.getByTestId('setup-drag-app').isDisabled(), true)
    await page.evaluate(() => { window.nativeFail = 'open_client_hotkey_settings' })
    await page.getByRole('button', { name: '打开输入监控', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'mock failure' }).waitFor()
    assert.equal(await page.evaluate(() => document.querySelector('.input-monitoring-setup').scrollWidth <= innerWidth), true)
    await page.screenshot({ path: `.cache/client-chrome-${engine}/input-monitoring-zh.png` })
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})


test('share popover selects a display and preserves capture across dismissal', async () => {
  const { page, context, errors } = await open({ mac: true, sharing: true, locale: 'zh', width: 600, height: 650 })
  try {
    await page.getByText('在会议软件中共享屏幕，选择 secondary monitor。', { exact: true }).waitFor()
    await page.getByRole('combobox', { name: '屏幕', exact: true }).click()
    await page.getByRole('option', { name: '屏幕 2 · 1440 × 900', exact: true }).click()
    await page.getByRole('button', { name: '开始共享', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '正在输出过滤画面' }).waitFor()
    assert.equal(await page.getByLabel('屏幕', { exact: true }).isDisabled(), true)
    assert.equal(await page.evaluate(() => window.nativeCalls.find(c => c.command === 'client_screen_share' && c.args.action === 'start').args.displayId), 9)
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'client_screen_share' && c.args.action === 'stop')), false)
    await page.getByRole('button', { name: '共享画面', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '正在输出过滤画面' }).waitFor()
    assert.equal(await page.getByRole('combobox', { name: '屏幕', exact: true }).innerText(), '屏幕 2 · 1440 × 900')
    await page.screenshot({ path: `.cache/client-chrome-${engine}/screen-share-zh.png`, animations: 'disabled' })
    await page.getByRole('button', { name: '停止共享', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '已停止' }).waitFor()
    assert.equal(await page.getByLabel('屏幕', { exact: true }).isDisabled(), false)
    await page.evaluate(() => { window.nativeFail = 'open_client_recording_setup' })
    await page.getByRole('button', { name: '录屏权限', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'mock failure' }).waitFor()
    assert.equal(await page.evaluate(() => document.querySelector('.screen-share-menu').scrollWidth <= innerWidth), true)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('share popover never prompts on open and shows denied and unsupported native states', async () => {
  const { page, context, errors } = await open({ mac: true, sharing: true, capturePermission: false, width: 600, height: 650 })
  try {
    assert.equal(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'client_screen_share').every(c => c.args.action === 'status')), true)
    await page.getByRole('button', { name: 'Start sharing', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Screen Recording permission required' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Stop sharing', exact: true }).count(), 0)
    await page.screenshot({ path: `.cache/client-chrome-${engine}/screen-share-en.png`, animations: 'disabled' })
    await page.evaluate(() => { window.captureState = { ...window.captureState, supported: false, phase: 'unsupported' } })
    await page.getByRole('status').filter({ hasText: 'Requires macOS 12.3' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Start sharing', exact: true }).isDisabled(), true)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('share popover reports negotiated output pixels and unavailable virtual display API', async () => {
  const { page, context, errors } = await open({ mac: true, sharing: true, width: 600, height: 650 })
  try {
    await page.evaluate(() => { window.captureState = { ...window.captureState, virtualDisplaySupported: false } })
    await page.getByRole('alert').filter({ hasText: 'This system cannot create a virtual display.' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Start sharing', exact: true }).isDisabled(), true)
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'client_screen_share' && c.args.action === 'start')), false)
    await page.evaluate(() => { window.captureState = { ...window.captureState, virtualDisplaySupported: true,
      running: true, phase: 'sharing', outputDisplay: 123, outputWidth: 1920, outputHeight: 1080 } })
    await page.getByText('1920 × 1080 · 30 fps · no audio', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Stop sharing', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Virtual display removed.' }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})


test('share and Ghost popovers use identical surfaces in both themes and fit minimum height', async () => {
  const { page, context, errors } = await open({ mac: true, locale: 'zh', width: 600, height: 650 })
  const surface = () => page.locator('[data-radix-popper-content-wrapper] > [data-state="open"]').evaluate(node => {
    const style = getComputedStyle(node)
    return [style.width, style.padding, style.borderRadius, style.backgroundColor, style.color, style.boxShadow]
  })
  try {
    for (const theme of ['light', 'dark']) {
      await appearance(page, theme, 0.35)
      await page.getByRole('button', { name: '共享画面', exact: true }).click()
      await page.locator('.screen-share-menu').waitFor()
      const share = await surface()
      await page.getByRole('combobox', { name: '屏幕', exact: true }).click()
      const options = page.getByRole('listbox')
      await options.waitFor()
      near((await paintedColor(options, 'background-color'))[3], 0.35 * 255, `${theme}: display options follow background opacity`)
      await page.screenshot({ path: `.cache/client-chrome-${engine}/display-options-${theme}.png`, animations: 'disabled' })
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('.screen-share-menu').isVisible(), true)
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '窗口设置', exact: true }).click()
      assert.deepEqual(await surface(), share, `${theme}: shared width, padding, rounding, opacity and colours`)
      await page.keyboard.press('Escape')
    }
    await page.setViewportSize({ width: 480, height: 360 })
    await page.getByRole('button', { name: '共享画面', exact: true }).click()
    const panel = page.locator('[data-radix-popper-content-wrapper] > [data-state="open"]')
    await panel.waitFor()
    const box = await panel.boundingBox()
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 480 && box.y + box.height <= 360)
    await page.getByRole('button', { name: '开始共享', exact: true }).scrollIntoViewIfNeeded()
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})


test('permission setup progresses to recording, drags the running app and resumes its page after reload', async () => {
  const { page, context, errors } = await open({ mac: true, setup: true, hotkeyPhase: 'permissionRequired', capturePermission: false, width: 360, height: 318 })
  try {
    await page.getByRole('button', { name: 'Later', exact: true }).click()
    await page.getByRole('heading', { name: 'Enable screen sharing', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => localStorage.getItem('sharecode-macos-permission-setup-v1')), 'recording')
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'open_client_recording_setup')), true)
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'client_screen_share' && c.args.action !== 'status')), false)
    await page.reload()
    await page.getByRole('heading', { name: 'Enable screen sharing', exact: true }).waitFor()
    const app = page.getByRole('button', { name: 'Drag ShareCode Setup Test into Screen Recording', exact: true })
    await page.waitForFunction(() => !document.querySelector('[data-testid="setup-drag-app"]').disabled)
    const box = await app.boundingBox()
    await page.mouse.move(box.x + 30, box.y + 30)
    await page.mouse.down()
    await page.mouse.move(box.x + 65, box.y + 30, { steps: 4 })
    await page.mouse.up()
    await page.waitForFunction(() => window.nativeCalls.some(c => c.command === 'drag_client_application'))
    await page.getByTestId('setup-status').filter({ hasText: 'Screen Recording permission required' }).waitFor()
    await page.getByRole('button', { name: 'Open Screen Recording', exact: true }).click()
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'open_client_recording_settings')), true)
    await page.screenshot({ path: `.cache/client-chrome-${engine}/recording-setup-en.png`, animations: 'disabled' })
    await page.evaluate(() => { window.captureState.permission = true; window.hotkeyStatus({ phase: 'listening' }) })
    await page.getByTestId('setup-status').filter({ hasText: 'Screen Recording permission granted' }).waitFor()
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    assert.equal(await page.evaluate(() => localStorage.getItem('sharecode-macos-permission-setup-v1')), 'done')
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'plugin:window|close')), true)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('startup rechecks native permissions even after setup was previously completed', async () => {
  for (const setupProgress of ['recording', 'done']) {
    const { page, context, errors } = await open({ mac: true, capturePermission: false, setupProgress })
    try {
      await page.waitForFunction(() => window.nativeCalls.some(c => c.command === 'open_client_recording_setup'))
      assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'show_client_main')), false)
      await page.getByRole('button', { name: 'Shared screen', exact: true }).click()
      await page.getByRole('button', { name: 'Recording permission', exact: true }).click()
      await page.waitForFunction(() => window.nativeCalls.some(c => c.command === 'open_client_recording_setup'))
      assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'client_screen_share' && c.args.action === 'settings')), false)
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  }
})

test('completed setup shows the main window on every permitted launch, but missing input permission reopens setup', async () => {
  for (const hotkeyPhase of ['listening', 'permissionRequired']) {
    const { page, context, errors } = await open({ mac: true, hotkeyPhase, setupProgress: 'done' })
    try {
      for (let launch = 0; launch < 2; launch++) {
        if (launch) await page.reload()
        const expected = hotkeyPhase === 'listening' ? 'show_client_main' : 'open_client_hotkey_setup'
        await page.waitForFunction(command => window.nativeCalls.some(c => c.command === command), expected)
        assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'show_client_main')), hotkeyPhase === 'listening')
      }
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  }
})

test('recording completion returns to missing input permission and does not close on a failed native gate', async () => {
  const { page, context, errors } = await open({ mac: true, setup: true, setupRecording: true, hotkeyPhase: 'permissionRequired' })
  try {
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await page.getByRole('heading', { name: 'Enable keyboard shortcuts', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'show_client_main')), false)
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'plugin:window|close')), false)
    await page.evaluate(() => { window.hotkeyStatus({ phase: 'listening' }); window.nativeFail = 'show_client_main' })
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'mock failure' }).waitFor()
    assert.equal(await page.evaluate(() => localStorage.getItem('sharecode-macos-permission-setup-v1')), 'input')
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'plugin:window|close')), false)
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.waitForFunction(() => window.nativeCalls.some(c => c.command === 'plugin:window|close'))
    assert.equal(await page.evaluate(() => localStorage.getItem('sharecode-macos-permission-setup-v1')), 'done')
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('recording guide has Chinese steps and cannot drag an uninstalled app', async () => {
  const { page, context, errors } = await open({ mac: true, setup: true, setupRecording: true, capturePermission: false, canDrag: false, locale: 'zh', width: 360, height: 318 })
  try {
    await page.getByRole('heading', { name: '开启屏幕共享', exact: true }).waitFor()
    assert.equal(await page.getByTestId('setup-drag-app').isDisabled(), true)
    await page.getByRole('alert').filter({ hasText: '请先将应用移到' }).waitFor()
    await page.screenshot({ path: `.cache/client-chrome-${engine}/recording-setup-zh.png`, animations: 'disabled' })
    await page.getByRole('button', { name: '上一步', exact: true }).click()
    await page.getByRole('heading', { name: '开启键盘快捷键', exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})


test('compact permission cards fit both steps and both languages without ordinary-state scrolling', async () => {
  for (const locale of ['en', 'zh']) {
    for (const setupRecording of [false, true]) {
      // Reserve 32 px for native window chrome within the 360×350 guide.
      const { page, context, errors } = await open({ mac: true, setup: true, setupRecording, locale,
        hotkeyPhase: 'permissionRequired', capturePermission: false, width: 360, height: 318 })
      try {
        await page.waitForFunction(() => !document.querySelector('[data-testid="setup-drag-app"]').disabled)
        assert.equal(await page.getByTestId('setup-drag-instruction').isVisible(), true)
        assert.equal(await page.getByTestId('setup-drag-instruction').innerText(), locale === 'zh'
          ? '把下方应用图标拖入系统设置的权限列表'
          : 'Drag the app icon below into the Settings permission list.')
        assert.equal(await page.locator('.permission-setup-drag-arrow').evaluate(node => getComputedStyle(node).pointerEvents), 'none', 'arrow must not intercept the drag')
        const layout = await page.locator('.input-monitoring-setup').evaluate(node => ({
          width: node.scrollWidth, height: node.scrollHeight, viewport: node.clientHeight,
          numberedSteps: node.querySelectorAll('ol').length,
        }))
        assert.ok(layout.width <= 360 && layout.height <= layout.viewport, `${locale}/${setupRecording}: ${JSON.stringify(layout)}`)
        assert.equal(layout.numberedSteps, 0, 'no redundant multi-paragraph numbered instructions')
        await page.screenshot({ path: `.cache/client-chrome-${engine}/compact-${setupRecording ? 'recording' : 'input'}-${locale}.png`, animations: 'disabled' })
        assert.deepEqual(errors, [])
      } finally { await context.close() }
    }
  }
})
