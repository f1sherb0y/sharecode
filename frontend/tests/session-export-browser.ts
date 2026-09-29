import assert from 'node:assert/strict'
import sharp from 'sharp'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, firefox, webkit, type Page } from 'playwright'
import { createServer, preview } from 'vite'
import { gunzipSync } from 'node:zlib'
import { fixture, checkSanitizer } from './session-export-data'
import { unpackSession, packSession } from '../src/export/data'

await checkSanitizer()
const temp = await mkdtemp(join(tmpdir(), 'session-export-'))
const dev = process.env.SESSION_EXPORT_DEV === '1'
const server = dev
  ? await createServer({ cacheDir: 'node_modules/.vite-session-export-tests', server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  : await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
if ('listen' in server) await server.listen()
const user = { id: 'private-user-alice', username: 'PRIVATE-USERNAME', email: 'private@example.invalid', role: 'superuser', color: '#ff0000' }
const room = { id: 'PRIVATE-ROOM-ID', name: 'PRIVATE-ROOM-NAME', language: 'markdown', ownerId: user.id, owner: user, isEnded: true, isDeleted: false, createdAt: '2026-09-17T00:00:00Z', participants: [] }
const remoteImage = 'https://images.example.invalid/original.png'
const { history, secret, pixel } = fixture(remoteImage)
async function seek(page: Page, value: number) {
  await page.getByRole('slider', { name: 'Progress' }).evaluate((el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, String(value)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}
try {
  for (const [engine, type] of Object.entries({ chromium, firefox, webkit })) {
    if (process.env.ENGINE && process.env.ENGINE !== engine) continue
    const browser = await type.launch()
    try {
      const context = await browser.newContext({ acceptDownloads: true, locale: 'en-US' })
      await context.addInitScript(() => {
        localStorage.setItem('i18nextLng', 'en')
        sessionStorage.setItem('sharecode-tab-auth', JSON.stringify({ state: { token: 'PRIVATE-AUTH-TOKEN' }, version: 0 }))
      })
      await context.route(remoteImage, route => route.fulfill({ body: Buffer.from(pixel.split(',')[1]!, 'base64'), contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }))
      await context.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname
        if (!path.startsWith('/api/')) return route.continue()
        let data: unknown = {}
        if (path === '/api/auth/profile') data = { actorType: 'user', user }
        else if (path === '/api/rooms') data = { rooms: [room], pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 } }
        else if (path.includes('/playback/updates')) data = history
        else if (path.endsWith('/notes')) data = { notes: [{ id: secret, roomId: room.id, createdAt: room.createdAt, text: 'Original note Alice' }] }
        else if (path.includes('users')) data = { users: [user] }
        else if (path.includes('notifications')) data = { notifications: [] }
        return route.fulfill({ json: data })
      })
      const page = await context.newPage()
      page.setDefaultTimeout(30_000)
      const errors: string[] = []
      page.on('pageerror', e => { errors.push(e.message); console.error(engine, e.message) })
      await page.goto(server.resolvedUrls.local[0]! + 'rooms')
      await page.getByRole('button', { name: /PRIVATE-ROOM-NAME/ }).click()
      const downloadEvent = page.waitForEvent('download', { timeout: 60_000 })
      await page.getByRole('menuitem', { name: 'Export session', exact: true }).click()
      const download = await downloadEvent
      assert.equal(download.suggestedFilename(), 'session-replay.html')
      const filename = join(temp, `${engine}.html`)
      await download.saveAs(filename)
      const html = await readFile(filename, 'utf8')
      const player = JSON.parse(gunzipSync(Buffer.from(html.match(/id="player-code"[^>]*>([^<]+)</)![1]!, 'base64')).toString())
      assert(!player.js.includes('jsxDEV'), 'Export must use production JSX even inside the dev server')
      assert(!player.js.includes('unicodeRange'), 'Font subset declarations must remain on the CDN, outside the HTML')
      assert(!player.js.includes('/home/') && !player.js.includes('/Users/'), 'Export must not contain development source paths')
      for (const privateValue of [room.id, room.name, user.username, user.email, 'PRIVATE-AUTH-TOKEN', secret, 'collabcode.cc']) assert(!html.includes(privateValue), privateValue)
      const data = unpackSession(html.match(/id="session-data"[^>]*>([^<]+)</)![1]!)
      assert.equal(data.users, 2)
      assert.equal(data.duration, 6000)
      assert.equal(data.images[remoteImage], pixel)
      assert.deepEqual(errors, [])
      if (engine === 'chromium') {
        await context.route(remoteImage, route => route.fulfill({ status: 403, headers: { 'Access-Control-Allow-Origin': '*' } }))
        const unexpectedDownloads: unknown[] = []
        page.on('download', event => unexpectedDownloads.push(event))
        await page.getByRole('button', { name: /PRIVATE-ROOM-NAME/ }).click()
        await page.getByRole('menuitem', { name: 'Export session', exact: true }).click()
        await page.getByRole('alert').filter({ hasText: 'Could not include an image' }).waitFor()
        assert.deepEqual(unexpectedDownloads, [])
      }
      await context.close()
      const offline = await browser.newContext({ locale: 'en-US' })
      const replay = await offline.newPage()
      replay.setDefaultTimeout(90_000)
      const network: string[] = [], replayErrors: string[] = [], violations: unknown[] = [], fileOriginErrors: string[] = []
      replay.on('console', message => { if (/Unsafe attempt to load URL|unique security origins/i.test(message.text())) fileOriginErrors.push(message.text()) })
      replay.on('request', req => { if (/^https?:/.test(req.url())) network.push(req.url()) })
      replay.on('requestfailed', r => console.error('REQUEST FAILED', r.url(), r.failure()?.errorText))
      replay.on('pageerror', e => { replayErrors.push(e.message); console.error(engine, e.stack) })
      await replay.addInitScript(() => {
        (window as unknown as { violations: unknown[] }).violations = []
        document.addEventListener('securitypolicyviolation', e => (window as unknown as { violations: unknown[] }).violations.push({ directive: e.violatedDirective, uri: e.blockedURI }))
        const fonts: string[] = []
        ;(window as unknown as { canvasTextFonts: string[] }).canvasTextFonts = fonts
        const fillText = CanvasRenderingContext2D.prototype.fillText
        CanvasRenderingContext2D.prototype.fillText = function (...args: Parameters<typeof fillText>) {
          if (args[0].includes('Canvas')) fonts.push(this.font)
          return fillText.apply(this, args)
        }
      })
      console.log(engine, 'opening local HTML')
      await replay.goto(pathToFileURL(filename).href)
      console.log(engine, 'loaded local HTML')
      await replay.getByText('Session replay', { exact: true }).waitFor()
      await replay.locator('.monaco-editor').waitFor()
      await replay.getByText('user1', { exact: true }).waitFor()
      await replay.waitForFunction(() => document.querySelector('.view-lines')?.textContent?.replace(/\s/g, ' ').includes('original content'))
      await seek(replay, 1000)
      await replay.waitForFunction(() => document.querySelector('.view-lines')?.textContent?.replace(/\s/g, ' ').includes('second step'))
      console.log(engine, 'code verified')
      await seek(replay, 2000)
      await replay.getByRole('heading', { name: 'Original Markdown' }).waitFor()
      await replay.locator('.katex').first().waitFor()
      await replay.locator('.md-mermaid-svg svg').waitFor()
      await replay.waitForFunction(() => { const img = document.querySelector<HTMLImageElement>('img[alt="Original image"]'); return img?.complete && img.naturalWidth > 0 })
      await replay.getByRole('button', { name: 'Notes', exact: true }).click()
      await replay.getByText('Original note Alice', { exact: true }).waitFor()
      await replay.getByRole('button', { name: 'Notes', exact: true }).click()
      console.log(engine, 'Markdown verified')
      // Seek while Canvas is unmounted; switching views must render this frame
      // without another seek, including after the lazy library has been cached.
      await seek(replay, 6000)
      await replay.getByRole('button', { name: 'Canvas', exact: true }).click()
      await replay.locator('.excalidraw canvas').first().waitFor()
      await replay.getByText('00:06 / 00:06', { exact: true }).waitFor()
      console.log(engine, 'Canvas mounted')
      const assertCanvasImage = async () => {
        let redPixels = 0
        for (let attempt = 0; attempt < 40 && redPixels < 100; attempt++) {
          const { data: pixels, info } = await sharp(await replay.locator('.excalidraw').screenshot()).raw().toBuffer({ resolveWithObject: true })
          redPixels = 0
          for (let i = 0; i < pixels.length; i += info.channels) if (pixels[i]! > 240 && pixels[i + 1]! < 15 && pixels[i + 2]! < 15) redPixels++
          console.log(engine, 'Canvas image pixels', redPixels)
          if (redPixels < 100) await replay.waitForTimeout(100)
        }
        if (redPixels < 100) await replay.screenshot({ path: join(temp, `${engine}-canvas-failure.png`) })
        assert(redPixels >= 100, `Canvas image did not render; artifacts: ${temp}`)
      }
      await assertCanvasImage()
      await replay.waitForFunction(() => (window as unknown as { canvasTextFonts: string[] }).canvasTextFonts.some(font => font.includes('Sarasa Mono') && font.includes('monospace')))
      console.log(engine, 'Canvas font family verified; loading CJK glyphs')
      await replay.evaluate(async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          // Keep FontFace host objects in the browser. Returning them to the
          // Playwright driver can stall Firefox's serialization indefinitely.
          const faces = await Promise.race([
            document.fonts.load('20px "Sarasa Mono"', '中文 日本語 한글'),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`CJK font loading timed out (FontFaceSet: ${document.fonts.status})`)), 30_000) }),
          ])
          if (!faces.length || faces.some(face => face.status !== 'loaded')) throw new Error('CJK font faces did not load')
        } finally { clearTimeout(timer) }
      })
      console.log(engine, 'Canvas CJK glyphs loaded')
      await replay.getByRole('button', { name: 'Editor', exact: true }).click()
      await seek(replay, 3000)
      await replay.getByRole('button', { name: 'Canvas', exact: true }).click()
      await assertCanvasImage()
      await seek(replay, 0)
      await seek(replay, 6000)
      await assertCanvasImage()
      await replay.screenshot({ path: join(temp, `${engine}-canvas.png`) })
      console.log(engine, 'Canvas verified')
      await replay.getByRole('button', { name: 'Toggle theme' }).click()
      await replay.getByRole('button', { name: 'Go to start' }).click()
      await replay.getByRole('button', { name: 'Editor', exact: true }).click()
      await replay.locator('.monaco-editor').waitFor()
      assert(!(await replay.locator('.view-lines').innerText()).replace(/\s/g, ' ').includes('second step'))
      await replay.getByRole('button', { name: 'Play', exact: true }).click()
      await replay.getByRole('button', { name: 'Pause', exact: true }).waitFor()
      await replay.getByRole('button', { name: 'Pause', exact: true }).click()
      await replay.getByRole('combobox', { name: 'Speed' }).click()
      await replay.getByRole('option', { name: '5x', exact: true }).click()
      await replay.setViewportSize({ width: 375, height: 740 })
      assert(await replay.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await replay.screenshot({ path: join(temp, `${engine}-mobile.png`) })
      await replay.getByRole('button', { name: 'Language / 语言' }).click()
      await replay.getByText('会话回放', { exact: true }).waitFor()
      violations.push(...await replay.evaluate(() => (window as unknown as { violations: unknown[] }).violations))
      assert(network.length > 0); assert(network.every(url => new URL(url).hostname === 'cdn.jsdelivr.net' || (new URL(url).hostname === 'esm.sh' && url.endsWith('.woff2'))), 'Player requested a non-CDN URL')
      assert(!network.some(url => /\/fonts\/(Cascadia|Xiaolai|Excalifont|Nunito|Virgil)\//.test(url)), 'Replay must not download vendor drawing fonts')
      assert.deepEqual(violations, [], 'CDN player violated CSP')
      assert.deepEqual(replayErrors, [], 'CDN player errors')
      assert.deepEqual(fileOriginErrors, [], 'Local file origin errors')
      // A single-event / zero-duration replay must still open; user content must not escape its data script.
      data.updates = data.updates.slice(0, 1); data.duration = 0; data.notes = ['</script><script>window.injected = true</script>']
      const one = join(temp, `${engine}-single.html`)
      await writeFile(one, html.replace(/(id="session-data"[^>]*>)[^<]+/, `$1${packSession(data)}`))
      await replay.goto(pathToFileURL(one).href)
      await replay.getByText('00:00 / 00:00', { exact: true }).waitFor()
      assert.equal(await replay.evaluate(() => (window as unknown as { injected?: boolean }).injected), undefined)
      await offline.close()
      console.log(`${engine}: menu download, file:// CDN code/Markdown/math/mermaid/images/Canvas, seek, notes, theme, speed, mobile, i18n, privacy and CSP passed`)
    } finally { await browser.close() }
  }
} finally { if ('close' in server) await server.close(); else await new Promise<void>(resolve => server.httpServer.close(() => resolve())) }
console.log(`Artifacts: ${temp}`)
