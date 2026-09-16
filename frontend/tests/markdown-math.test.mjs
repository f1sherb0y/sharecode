// Run from frontend: node --test tests/markdown-math.test.mjs
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { chromium } from 'playwright'
import { createServer } from 'vite'

let server
let browser
let page
const errors = []

before(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  await server.listen()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${server.resolvedUrls.local[0]}tests/markdown-math.html`)
  await page.waitForFunction(() => window.mathTest)
})

after(async () => {
  await browser?.close()
  await server?.close()
})

test('renders inline and multiline block math and preserves Markdown through playback reload', async () => {
  const markdown = '行内 $x^2 + y^2$ 公式\n\n$$\n\\frac{a}{b} + \\sum_{i=1}^{n} i\n$$\n\n`$literal$`\n\n```js\nconst x = "$literal$"\n```'
  await page.evaluate((text) => window.mathTest.replace(text), markdown)
  assert.equal(await page.locator('.md-math-inline .katex').count(), 1)
  assert.equal(await page.locator('.md-math-block .katex-display').count(), 1)
  assert.equal(await page.locator('code .katex').count(), 0)
  const before = await page.evaluate(() => window.mathTest.json())
  const serialized = await page.evaluate(() => window.mathTest.markdown())
  assert.match(serialized, /\$x\^2 \+ y\^2\$/)
  assert.ok(serialized.includes('$$\n\\frac{a}{b} + \\sum_{i=1}^{n} i\n$$'))
  await page.evaluate((text) => window.mathTest.replace(text), serialized)
  assert.deepEqual(await page.evaluate(() => window.mathTest.json()), before)
})

test('typing converts inline math, supports source editing and leaves following text outside', async () => {
  await page.evaluate(() => window.mathTest.replace(''))
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('Formula $x^2$ after')
  assert.equal(await page.locator('.md-math-inline .katex').count(), 1)
  await page.locator('.md-math-inline .md-math-preview').click()
  assert.equal(await page.locator('.md-math-inline .md-math-source').isVisible(), true)
  await page.evaluate(() => window.mathTest.selectText())
  await page.keyboard.type('y^3')
  assert.equal(await page.locator('.md-math-inline annotation').textContent(), 'y^3')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.md-math-source').isVisible(), false)
  assert.match(await page.evaluate(() => window.mathTest.markdown()), /Formula \$y\^3\$ after/)
})

test('typing $$ space creates block math with a live preview and keyboard exit', async () => {
  await page.evaluate(() => window.mathTest.replace(''))
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('$$ ')
  await page.keyboard.type('E = mc^2')
  assert.equal(await page.locator('.md-math-block annotation').textContent(), 'E = mc^2')
  await page.keyboard.press('Control+Enter')
  await page.keyboard.type('Next paragraph')
  assert.match(await page.evaluate(() => window.mathTest.markdown()), /\$\$\nE = mc\^2\n\$\$\n\nNext paragraph/)
})

test('pasting Markdown recognizes math but preserves escaped dollars and code', async () => {
  await page.evaluate(() => window.mathTest.replace(''))
  await page.locator('.ProseMirror').click()
  await page.evaluate(() => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'Inline $a+b$\n\n$$\n\\sqrt{x}\n$$\n\n\\$price\\$ and `$code$`')
    document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  })
  assert.equal(await page.locator('.md-math-inline').count(), 1)
  assert.equal(await page.locator('.md-math-block').count(), 1)
  assert.equal(await page.locator('code').textContent(), '$code$')
})

test('$$ followed by Enter starts a block, while escaped dollars and inline code stay literal', async () => {
  await page.evaluate(() => window.mathTest.replace(''))
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('$$')
  await page.keyboard.press('Enter')
  await page.keyboard.type('x^2')
  assert.equal(await page.locator('.md-math-block annotation').textContent(), 'x^2')
  await page.evaluate(() => window.mathTest.replace(''))
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('\\$literal$')
  assert.equal(await page.locator('.md-math').count(), 0)
  await page.evaluate(() => window.mathTest.replace('`code`'))
  await page.locator('code').click()
  await page.keyboard.type('$literal$')
  assert.equal(await page.locator('.md-math').count(), 0)
})

test('concurrent formula edits converge through Yjs and update both previews', async () => {
  const peers = await page.evaluate(() => window.mathTest.collaborate())
  assert.deepEqual(peers[0], peers[1])
  assert.ok(peers[0].preview.includes('a+'))
  assert.ok(peers[0].preview.includes('b+'))
  assert.equal(peers[0].blocks, 1)
})

test('toolbar insertion renders math and read-only viewers cannot edit formulas', async () => {
  await page.evaluate(() => {
    window.mathTest.replace('')
    window.mathTest.insert('$x^2$')
    window.mathTest.insert('$$\nE = mc^2\n$$')
  })
  assert.equal(await page.locator('.md-math-inline .katex').count(), 1)
  assert.equal(await page.locator('.md-math-block .katex-display').count(), 1)
  const before = await page.evaluate(() => window.mathTest.markdown())
  await page.evaluate(() => window.mathTest.readonly(true))
  await page.locator('.md-math-block .md-math-preview').click()
  await page.keyboard.type('must not be written')
  assert.equal(await page.locator('.md-math-block .md-math-source').isVisible(), false)
  assert.equal(await page.evaluate(() => window.mathTest.markdown()), before)
  await page.evaluate(() => window.mathTest.readonly(false))
})

test('invalid LaTeX remains editable and untrusted commands cannot create links', async () => {
  await page.evaluate(() => window.mathTest.replace('$\\notACommand{x}$ and $\\href{javascript:alert(1)}{click}$'))
  assert.equal(await page.locator('.md-math').count(), 2)
  assert.equal(await page.locator('.md-math a').count(), 0)
  await page.locator('.md-math-preview').first().click()
  assert.equal(await page.locator('.md-math-source').first().isVisible(), true)
  assert.deepEqual(errors, [])
})
