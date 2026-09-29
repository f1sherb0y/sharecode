import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium, firefox, webkit } from 'playwright'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const temp = await mkdtemp(join(tmpdir(), 'sarasa-font-'))
const server = await createServer({ cacheDir: join(temp, 'vite'), server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
await server.listen()
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    if (process.env.ENGINE && process.env.ENGINE !== name) continue
    console.log('Testing', name)
    const browser = await engine.launch()
    try {
      const page = await browser.newPage(), errors = [], fonts = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', req => { if (req.resourceType() === 'font') fonts.push(req.url()) })
      await page.goto(server.resolvedUrls.local[0] + 'tests/sarasa-font.html')
      await page.waitForFunction(() => typeof window.exportFontSvg === 'function')
      const svg = await page.evaluate(() => window.exportFontSvg())
      assert(/font-family="[^\n]*Sarasa Mono/.test(svg), 'SVG must render text in Sarasa Mono')
      assert(/data:font\/woff2;base64,/.test(svg), 'SVG must embed the selected font')
      assert(svg.includes('中文日本語한글'))
      assert(fonts.length > 0 && fonts.length < 25, 'load only required font subsets')
      assert(fonts.every(url => url.startsWith('https://cdn.jsdelivr.net/npm/sarasa-mono-web@0.1.0/')))
      assert.deepEqual(errors, [])
      await writeFile(join(temp, `${name}.svg`), svg)
      await page.screenshot({ path: join(temp, `${name}.png`) })
      // A fresh context ensures font cache cannot mask a blocked CDN.
      const fallback = await browser.newContext()
      await fallback.route('https://cdn.jsdelivr.net/**', route => route.abort())
      const blocked = await fallback.newPage()
      await blocked.goto(server.resolvedUrls.local[0] + 'tests/sarasa-font.html')
      await blocked.waitForFunction(() => typeof window.exportFontSvg === 'function')
      await blocked.evaluate(() => window.fontReady)
      const metrics = await blocked.locator('#sample').evaluate(el => ({ family: getComputedStyle(el).fontFamily, width: el.getBoundingClientRect().width, text: el.textContent }))
      assert.match(metrics.family, /Sarasa Mono.*monospace/)
      assert(metrics.width > 0 && metrics.text.includes('中文'))
      await fallback.close()
      console.log(`PASS ${name}: CJK subsets, SVG font embedding, dev adapter, CDN fallback`)
    } finally { await browser.close() }
  }
  console.log('Artifacts:', temp)
} finally { await server.close() }
