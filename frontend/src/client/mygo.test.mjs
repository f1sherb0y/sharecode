import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

// Native calls are mocked, not silently accepted. These tests cover the real UI and
// the build-only MyGo adapters, independently of the existing Tauri IPC tests.
let server, browser, base
before(async () => {
  server = await createServer({
    configFile: resolve('vite.client-mygo.config.ts'), logLevel: 'error',
    cacheDir: 'node_modules/.vite/client-mygo-tests',
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  })
  await server.listen()
  base = server.resolvedUrls.local[0]
  browser = await chromium.launch({ headless: true })
})
after(async () => { await browser?.close(); await server?.close() })

async function open({ mac = false, setup = false, update = false } = {}) {
  const context = await browser.newContext({
    userAgent: mac ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  })
  await context.addInitScript(({ mac, setup, update }) => {
    localStorage.setItem('i18nextLng', 'en')
    const listeners = new Set()
    window.nativeCalls = []
    window.nativeState = { clickThrough: false, hideFromTaskbar: true, screenCaptureProtection: true }
    window.hotkey = { revision: 0, phase: 'listening', ready: true, received: 0, testing: false, lastAction: null, error: null }
    window.updateResult = update ? { id: 'update-1', version: '9.9.9', currentVersion: '0.2.7' } : null
    window.locked = true
    window.failCommand = null
    window.emitNative = (event, payload) => { for (const handler of [...listeners]) handler({ event, payload }) }
    window.nativeListenerCount = () => listeners.size
    window.mygo = {
      on(event, handler) {
        if (event !== 'sharecode:native-event') throw new Error(`Unexpected event: ${event}`)
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
      async call(method, command, args) {
        if (method !== 'Desktop.Invoke') throw new Error(`Unexpected method: ${method}`)
        window.nativeCalls.push({ command, args })
        if (window.failCommand === command) throw new Error(`Native failure: ${command}`)
        switch (command) {
          case 'client_update_check': return window.updateResult
          case 'client_update_download': return new Promise((resolve, reject) => {
            window.download = { args, resolve, reject: () => reject(new Error('Signature rejected')),
              emit: (event, data, patch = {}) => window.emitNative('sharecode:update-download', { ...args, event, data, ...patch }) }
          })
          case 'client_update_install': case 'client_update_close': case 'client_relaunch': return null
          case 'set_client_update_locked': window.locked = args.locked; return null
          case 'get_stealth_state': return window.nativeState
          case 'set_stealth_state':
            window.nativeState = { ...window.nativeState, ...args }; return window.nativeState
          case 'get_hotkey_status': return { nativeListener: true, globalShortcut: true, permissionRequired: false, error: null }
          case 'get_client_hotkey_status': return window.hotkey
          case 'get_meeting_privacy_status': return { enabled: false, state: 'disabled', meetingProcesses: 0, protectedWindows: 0, hiddenTaskbarWindows: 0, error: null }
          case 'set_meeting_privacy_enabled': return { enabled: args.enabled, state: args.enabled ? 'waiting' : 'disabled', meetingProcesses: 0, protectedWindows: 0, hiddenTaskbarWindows: 0, error: null }
          case 'client_is_maximized': return false
          case 'client_set_pinned': return null
          case 'client_window_set_title': case 'client_window_minimize': case 'client_window_close':
          case 'client_window_toggle_maximize': case 'client_window_focus': case 'client_window_start_dragging': return null
          case 'client_screen_share': return { supported: mac, permission: true, running: false, phase: 'idle', displays: [] }
          case 'show_client_main': case 'open_client_recording_setup': case 'open_client_hotkey_setup': return null
          case 'get_client_application': return { name: 'ShareCode MyGo Test', path: '/Applications/ShareCode MyGo Test.app', canDrag: true }
          default: throw new Error(`Unimplemented native command: ${command} (${setup})`)
        }
      },
    }
  }, { mac, setup, update })
  // No production accounts, meeting applications or update servers are touched.
  await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(base).origin
    ? route.continue() : route.fulfill({ status: 404, body: '' }))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(base + 'client.html' + (setup ? '#/input-monitoring' : ''))
  await page.locator(setup ? '.input-monitoring-setup' : update ? '.client-update-progress' : '.client-shell').waitFor()
  return { page, errors, close: () => context.close() }
}

test('MyGo opens the unchanged client, without masquerading as Tauri', async () => {
  const view = await open()
  try {
    assert.equal(await view.page.evaluate(() => '__TAURI_INTERNALS__' in window), false)
    assert.equal(await view.page.evaluate(() => window.locked), false)
    const endpoints = await view.page.evaluate(async () => {
      localStorage.setItem('sharecode_settings', JSON.stringify({ serverUrl: 'https://example.test', wsUrl: 'wss://example.test' }))
      const api = await import('/src/api/client.ts')
      return [api.getApiBaseUrl(), api.getWebSocketUrl()]
    })
    assert.deepEqual(endpoints, ['https://example.test', 'wss://example.test'])
    const commands = await view.page.evaluate(() => window.nativeCalls.map(({ command }) => command))
    for (const command of ['client_update_check', 'get_stealth_state', 'get_hotkey_status', 'get_meeting_privacy_status']) assert.ok(commands.includes(command), command)
    assert.deepEqual(view.errors, [])
  } finally { await view.close() }
})

test('window actions, drag hit targets and native events keep their contracts', async () => {
  const view = await open()
  try {
    const result = await view.page.evaluate(async () => {
      const { getCurrentWindow } = await import('/src/lib/mygo-window.ts')
      const { listen } = await import('/src/lib/mygo-event.ts')
      const win = getCurrentWindow()
      await win.minimize(); await win.toggleMaximize(); await win.setFocus(); await win.setTitle('A title')
      let count = 0
      const off = await listen('example', (event) => { count += event.payload })
      window.emitNative('other', 99); window.emitNative('example', 2)
      off(); window.emitNative('example', 3)
      const title = document.querySelector('.client-title-bar')
      const button = title.querySelector('button')
      const unmarked = document.createElement('span')
      title.append(unmarked)
      const nested = document.createElement('span')
      nested.setAttribute('data-tauri-drag-region', '')
      unmarked.append(nested)
      const regions = [title, button, button.querySelector('svg'), unmarked, nested]
        .map((element) => getComputedStyle(element).getPropertyValue('--app-region').trim())
      return { count, calls: window.nativeCalls, regions }
    })
    assert.equal(result.count, 2)
    assert.deepEqual(result.regions, ['drag', 'no-drag', 'no-drag', 'no-drag', 'drag'])
    assert.equal(result.calls.filter(({ command }) => command === 'client_window_start_dragging').length, 0)
    assert.equal(result.calls.filter(({ command }) => command === 'client_window_toggle_maximize').length, 1)
    assert.ok(result.calls.some(({ command, args }) => command === 'client_window_set_title' && args.title === 'A title'))
    assert.deepEqual(view.errors, [])
  } finally { await view.close() }
})

test('mandatory update blocks UI, correlates progress and waits for verification before restart', async () => {
  const view = await open({ update: true })
  try {
    assert.equal(await view.page.locator('.client-shell').count(), 0)
    await view.page.evaluate(() => {
      window.download.emit('Started', { contentLength: 100 })
      window.download.emit('Progress', { chunkLength: 70 }, { id: 'stale' })
      window.download.emit('Progress', { chunkLength: 30 })
    })
    await view.page.waitForFunction(() => document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') === '30')
    await view.page.evaluate(() => window.download.emit('Finished'))
    assert.equal(await view.page.locator('.client-update-action').count(), 0)
    await view.page.evaluate(() => window.download.resolve())
    await view.page.locator('.client-update-action').waitFor()
    await view.page.locator('.client-update-action').click()
    await view.page.waitForFunction(() => window.nativeCalls.some(({ command }) => command === 'client_relaunch'))
    const calls = await view.page.evaluate(() => window.nativeCalls.map(({ command }) => command))
    assert.ok(calls.indexOf('client_update_install') < calls.indexOf('client_relaunch'))
    assert.equal(await view.page.evaluate(() => window.locked), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.close() }
})

test('signature failure stays locked and download listeners are removed', async () => {
  const view = await open({ update: true })
  try {
    assert.equal(await view.page.evaluate(() => window.nativeListenerCount()), 1)
    await view.page.evaluate(() => window.download.reject())
    await view.page.locator('.client-update-error').waitFor()
    assert.equal(await view.page.evaluate(() => window.nativeListenerCount()), 0)
    assert.equal(await view.page.locator('.client-shell').count(), 0)
    assert.equal(await view.page.evaluate(() => window.locked), true)
    assert.ok(await view.page.evaluate(() => window.nativeCalls.some(({ command }) => command === 'client_update_close')))
    assert.deepEqual(view.errors, [])
  } finally { await view.close() }
})

test('malformed checks and native command failures reject rather than report success', async () => {
  const view = await open()
  try {
    const results = await view.page.evaluate(async () => {
      const { check } = await import('/src/lib/mygo-updater.ts')
      const { invoke } = await import('/src/lib/mygo-core.ts')
      const errors = []
      for (const value of [undefined, {}, { id: '', version: '1', currentVersion: '0' }]) {
        window.updateResult = value
        try { await check() } catch (error) { errors.push(error.message) }
      }
      try { await invoke('unknown-command') } catch (error) { errors.push(error.message) }
      return errors
    })
    assert.equal(results.length, 4)
    assert.match(results[3], /Unimplemented native command/)
  } finally { await view.close() }
})

test('restart failure retries relaunch without reinstalling the verified resource', async () => {
  const view = await open({ update: true })
  try {
    await view.page.evaluate(() => { window.download.resolve(); window.failCommand = 'client_relaunch' })
    await view.page.locator('.client-update-action').click()
    await view.page.locator('.client-update-error').waitFor()
    assert.equal(await view.page.locator('.client-shell').count(), 0)
    await view.page.evaluate(() => { window.failCommand = null })
    await view.page.locator('.client-update-action').click()
    await view.page.waitForFunction(() => window.nativeCalls.filter(({ command }) => command === 'client_relaunch').length === 2)
    assert.equal(await view.page.evaluate(() => window.nativeCalls.filter(({ command }) => command === 'client_update_install').length), 1)
    assert.deepEqual(view.errors, [])
  } finally { await view.close() }
})

test('withdrawal releases a verified update while failed background checks keep it ready', async () => {
  const view = await open({ update: true })
  try {
    await view.page.evaluate(() => window.download.resolve())
    await view.page.locator('.client-update-action').waitFor()
    await view.page.evaluate(async () => {
      window.failCommand = 'client_update_check'
      await (await import('/src/client/updater.ts')).checkForUpdate()
    })
    assert.equal(await view.page.locator('.client-shell').count(), 0)
    assert.equal(await view.page.locator('.client-update-action:disabled').count(), 0)
    await view.page.evaluate(async () => {
      window.failCommand = null
      window.updateResult = null
      await (await import('/src/client/updater.ts')).checkForUpdate()
    })
    await view.page.locator('.client-shell').waitFor()
    assert.equal(await view.page.evaluate(() => window.locked), false)
    assert.ok(await view.page.evaluate(() => window.nativeCalls.some(({ command, args }) => command === 'client_update_close' && args.id === 'update-1')))
    assert.deepEqual(view.errors, [])
  } finally { await view.close() }
})

test('MyGo adapter rejects a missing bridge rather than claiming native success', async () => {
  const view = await open()
  try {
    const error = await view.page.evaluate(async () => {
      const bridge = window.mygo
      try {
        delete window.mygo
        const { invoke } = await import('/src/lib/mygo-core.ts')
        try { await invoke('client_window_minimize') } catch (error) { return error.message }
      } finally { window.mygo = bridge }
    })
    assert.match(error, /bridge is unavailable/)
  } finally { await view.close() }
})

test('macOS helper stays separate, uses caller-window close and does not run updates', async () => {
  const view = await open({ mac: true, setup: true })
  try {
    await view.page.waitForFunction(() => window.nativeCalls.some(({ command }) => command === 'get_client_application'))
    await view.page.evaluate(async () => (await import('/src/lib/mygo-window.ts')).getCurrentWindow().close())
    const calls = await view.page.evaluate(() => window.nativeCalls.map(({ command }) => command))
    assert.ok(calls.includes('get_client_hotkey_status'))
    assert.ok(calls.includes('client_window_close'))
    assert.equal(calls.includes('client_update_check'), false)
    assert.deepEqual(view.errors, [])
  } finally { await view.close() }
})
