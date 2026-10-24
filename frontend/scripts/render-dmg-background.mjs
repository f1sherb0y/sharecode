// node frontend/scripts/render-dmg-background.mjs (needs Inter and Noto Sans CJK SC, or the macOS system fonts)
// The committed PNG pair is used by dmgbuild; Playwright is needed only to edit the artwork.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const directory = new URL('../../docs/macos/', import.meta.url)
const svg = await readFile(new URL('dmg-background.svg', directory), 'utf8')
const browser = await chromium.launch({ headless: true })
try {
  for (const scale of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 720, height: 480 }, deviceScaleFactor: scale })
    await page.setContent(`<style>html,body{margin:0;overflow:hidden}svg{display:block}</style>${svg}`)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: fileURLToPath(new URL(`dmg-background${scale === 2 ? '@2x' : ''}.png`, directory)) })
    await page.close()
  }
} finally {
  await browser.close()
}
