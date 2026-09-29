// Exercise the actual production bundle and nginx caching, without a live account.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import * as Y from 'yjs'
import { chromium, firefox, webkit } from 'playwright'
const temp = await mkdtemp(join(tmpdir(), 'sharecode-loading-'))
const name = `sharecode-loading-${process.pid}`
const base = 'http://127.0.0.1:55463'
const user = { id: 'fixture', username: 'fixture', role: 'superuser', color: '#226699' }
const doc = new Y.Doc(); doc.getText('codemirror').insert(0, '# Shared monospace\n\n中文 English $x^2$\n')
const element = { id: 'legacy-text', type: 'text', x: 20, y: 20, width: 220, height: 25, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 123, version: 1, versionNonce: 123, isDeleted: false, boundElements: null, updated: 0, link: null, locked: false, index: 'a0', fontFamily: 5, fontSize: 20, text: 'Canvas 中文 English', originalText: 'Canvas 中文 English', textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25 }
doc.getMap('canvas-elements').set(element.id, { element })
const update = gzipSync(Y.encodeStateAsUpdate(doc)).toString('base64'); doc.destroy()
const updates = [0, 1].map(i => ({ id: String(i), timestamp: `2026-09-17T00:00:0${i}Z`, update, userId: user.id }))
const room = language => ({ id: language, language, ownerId: user.id, owner: user, isOwner: true, isEnded: true, canManageNotes: false })
const endpoints = {
  '/api/config/registration': { allowRegistration: false },
  '/api/auth/profile': { actorType: 'user', user },
  '/api/notifications/unread': { notifications: [] },
  ...Object.fromEntries(['python', 'markdown'].flatMap(lang => [
    [`/api/rooms/${lang}`, { room: room(lang) }],
    [`/api/rooms/${lang}/playback/updates`, { updates }],
    [`/api/rooms/${lang}/notes`, { notes: [] }],
  ])),
}
let conf = (await readFile('nginx.conf', 'utf8')).replace('listen 80;', 'listen 80;')
conf = conf.replace('    # Gzip compression', `    location = /api/auth/refresh { default_type application/json; return 401 '{"error":"No browser session"}'; }\n    # Gzip compression`)
conf = conf.replace('    # Gzip compression', Object.entries(endpoints).map(([path, data]) => `    location = ${path} { default_type application/json; add_header Cache-Control no-store; return 200 '${JSON.stringify(data)}'; }`).join('\n') + '\n    # Gzip compression')
await writeFile(join(temp, 'nginx.conf'), conf)
let browser
const errors = [], results = {}
try {
  execFileSync('docker', ['run', '--rm', '-d', '--name', name, '-p', '127.0.0.1:55463:80', '-v', `${resolve('dist')}:/usr/share/nginx/html:ro`, '-v', `${temp}/nginx.conf:/etc/nginx/conf.d/default.conf:ro`, 'nginx:alpine'], { stdio: 'pipe' })
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base)).ok) break } catch {} await new Promise(r => setTimeout(r, 50)) }
  for (const [engine, type] of Object.entries({ chromium, firefox, webkit })) {
    if (process.env.ENGINE && process.env.ENGINE !== engine) continue
    browser = await type.launch()
    const context = await browser.newContext({ locale: 'en-US' }), page = await context.newPage()
    page.on('pageerror', e => { errors.push(engine + ': ' + e.message); console.error(engine, e.message) })
    page.on('requestfailed', req => console.error(engine, 'request failed', req.url(), req.failure()?.errorText))
    page.on('response', response => { if (response.status() >= 400) console.error(engine, response.status(), response.url()) })
    await page.goto(base + '/login'); await page.getByRole('button', { name: 'Login', exact: true }).waitFor()
    const resources = () => page.evaluate(() => performance.getEntriesByType('resource').filter(e => e.name.includes('/assets/')).map(e => ({ name: e.name, encoded: e.encodedBodySize, decoded: e.decodedBodySize, transfer: e.transferSize })))
    const cold = await resources()
    assert(!cold.some(r => /editor\.api|canvas-view|katex|playback-markdown|yjs-/.test(r.name)), 'login must not fetch editing engines')
    assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').filter(e => /\.(woff2?|ttf)(\?|$)/.test(e.name)).length), 0)
    await page.goto(base + '/login'); await page.getByRole('button', { name: 'Login', exact: true }).waitFor()
    const warm = await resources()
    assert(warm.length > 0 && warm.every(r => r.transfer === 0), `${engine}: immutable JS/CSS should come from browser cache`)
    results[engine] = { cold, warm }
    await page.evaluate(() => { sessionStorage.setItem('sharecode-tab-auth', JSON.stringify({ state: { token: 'fixture-auth' }, version: 0 })); localStorage.setItem('i18nextLng', 'en') })
    const requests = []; page.on('request', req => requests.push(req.url()))
    await page.goto(base + '/playback/python?view=canvas')
    await page.locator('.excalidraw canvas').first().waitFor({ timeout: 30000 })
    // No hover on the editor switch: it should not prefetch until user intent.
    assert(!requests.some(url => /editor\.api|playback-markdown|markdown-editor/.test(url)), 'Canvas-only visit must not fetch hidden editors')
    await page.waitForFunction(() => [...document.fonts].some(f => f.family.replace(/"/g, '') === 'Sarasa Mono' && f.status === 'loaded'))
    const families = await page.evaluate(() => [...document.fonts].map(f => f.family))
    assert(families.every(f => f.replace(/"/g, '') === 'Sarasa Mono'), `${engine}: only the chosen drawing font may be registered: ${families}`)
    assert(!requests.some(url => /Cascadia|Xiaolai|Assistant|JuliaMono|JetBrains|KaTeX_/.test(url)))
    const fontMetrics = await page.evaluate(async () => {
      await document.fonts.load('20px "Sarasa Mono"', 'Mi中文日本語한글')
      const ctx = document.createElement('canvas').getContext('2d')
      ctx.font = '20px "Sarasa Mono", monospace'
      return { widths: [...'Mi中文日本語한글'].map(c => ctx.measureText(c).width),
        loaded: [...document.fonts].filter(f => f.status === 'loaded').length,
        registered: [...document.fonts].length }
    })
    assert.equal(fontMetrics.registered, 97, 'shared faces must not be registered twice')
    assert(fontMetrics.loaded < 25, 'a short sample must not download the complete CJK font')
    assert(Math.abs(fontMetrics.widths[0] - fontMetrics.widths[1]) < 0.05)
    for (const width of fontMetrics.widths.slice(2)) assert(Math.abs(width - 2 * fontMetrics.widths[0]) < 0.05, `${engine}: CJK glyphs must occupy two Latin cells`)
    results[engine].fontMetrics = fontMetrics
    const scripts = requests.filter(url => /\.js(\?|$)/.test(url))
    assert(scripts.every(url => url.startsWith(base)), 'website JavaScript must remain self-hosted')
    await page.screenshot({ path: join(temp, engine + '-canvas.png') })
    await page.getByRole('button', { name: 'Editor', exact: true }).click()
    await page.locator('.monaco-editor').waitFor({ timeout: 30000 })
    assert.match(await page.locator('.monaco-editor .view-lines').evaluate(el => getComputedStyle(el).fontFamily), /Sarasa Mono.*monospace/)
    await page.goto(base + '/playback/markdown')
    await page.locator('.ProseMirror h1').waitFor({ timeout: 30000 })
    await page.locator('math').waitFor()
    assert.match(await page.locator('.ProseMirror').evaluate(el => getComputedStyle(el).fontFamily), /Sarasa Mono.*monospace/)
    await page.screenshot({ path: join(temp, engine + '-markdown.png') })
    assert(!requests.some(url => /Xiaolai|Assistant|JuliaMono|JetBrains|KaTeX_/.test(url)))
    await browser.close(); browser = undefined
    console.log(`PASS ${engine}: lazy boundaries, real nginx/browser cache, one CDN font, self-hosted JS, legacy Canvas, code and MathML playback`)
  }
  assert.deepEqual(errors, [])
  assert.equal((await fetch(base + '/assets/no-longer-present.js')).status, 404)
  await writeFile(join(temp, 'network.json'), JSON.stringify(results, null, 2))
  console.log('Network and screenshots:', temp)
} finally {
  await browser?.close()
  execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
}
