// Real two-browser collaboration against the disposable local API/database.
import assert from 'node:assert/strict'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'
const API = 'http://127.0.0.1:55460'
async function request(path, method = 'GET', body, token) {
  const response = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data
}
const password = 'LocalAudit#2026Strong'
const admin = (await request('/api/auth/login', 'POST', { username: 'audit_admin', password })).token
await request('/api/admin/users', 'POST', { username: 'blink_viewer', password, role: 'admin', canReadAllRooms: true, canWriteAllRooms: false }, admin)
const viewer = (await request('/api/auth/login', 'POST', { username: 'blink_viewer', password })).token
const web = await createServer({ plugins: [{ name: 'capture-blink-test-editor', enforce: 'pre', transform(source, id) {
  if (id.endsWith('/hooks/use-monaco-editor.ts')) return source.replace('editorInstanceRef.current = editor', 'editorInstanceRef.current = editor; (window as any).__blinkTest = { editor, ytext, provider, monaco }')
  if (id.endsWith('/features/markdown-editor.tsx')) return source.replace('collabService.connect()', 'collabService.connect(); (window as any).__markdownBlinkTest = { view: ctx.get(editorViewCtx), provider, ydoc, TextSelection }')
} }], cacheDir: 'node_modules/.vite-blink-tests', server: { host: '127.0.0.1', port: 55461, strictPort: true, proxy: { '/api': { target: API, changeOrigin: true, ws: true } } }, define: { 'import.meta.env.VITE_API_URL': JSON.stringify(API), 'import.meta.env.VITE_WS_URL': JSON.stringify(API.replace('http', 'ws')) }, logLevel: 'error' })
await web.listen()
const pulse = page => page.evaluate(() => window.__blinkTest.editor.getModel().getAllDecorations().filter(d => d.options.className?.includes('selection-blink')).map(d => ({ range: d.range, className: d.options.className, wholeLine: d.options.isWholeLine })))
const waitPulse = page => page.waitForFunction(() => window.__blinkTest?.editor.getModel().getAllDecorations().some(d => d.options.className?.includes('selection-blink')))
try {
  for (const [name, type] of Object.entries({ chromium, firefox, webkit })) {
    if (process.env.ENGINE && process.env.ENGINE !== name) continue
    const { room } = await request('/api/rooms', 'POST', { name: 'Blink reliability', language: 'python' }, admin)
    const browser = await type.launch()
    try {
      const pages = [], errors = []
      for (const token of [admin, viewer]) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
        await context.addInitScript(token => { sessionStorage.setItem('sharecode-tab-auth', JSON.stringify({ state: { token }, version: 0 })); localStorage.setItem('i18nextLng', 'en') }, token)
        const page = await context.newPage(); pages.push(page); page.on('pageerror', e => errors.push(e.message))
        await page.goto('http://127.0.0.1:55461/room/' + room.id)
        await page.waitForFunction(() => !!window.__blinkTest && window.__blinkTest.provider.synced)
        await page.getByRole('button', { name: 'Blink Selection', exact: true }).waitFor()
      }
      const [sender, receiver] = pages
      await sender.waitForFunction(() => window.__blinkTest.provider.awareness.getStates().size >= 2)
      const raw = '\ufeff' + Array.from({ length: 200 }, (_, i) => `line ${i + 1} 中文😀`).join('\r\n')
      await sender.evaluate(raw => { const { ytext } = window.__blinkTest; ytext.insert(0, raw) }, raw)
      await receiver.waitForFunction(() => window.__blinkTest.editor.getModel().getLineCount() === 200)
      const select = (page, line, start, end) => page.evaluate(({ line, start, end }) => {
        const { editor, monaco } = window.__blinkTest; editor.setSelection(new monaco.Selection(line, start, line, end)); editor.revealLineInCenter(line)
      }, { line, start, end })
      for (const page of pages) assert.deepEqual(await page.evaluate(() => {
        const { editor, monaco } = window.__blinkTest
        return [editor.getOption(monaco.editor.EditorOption.selectionHighlight), editor.getOption(monaco.editor.EditorOption.occurrencesHighlight)]
      }), [false, 'off'])
      await select(sender, 150, 2, 8)
      await receiver.evaluate(() => { const { editor, monaco } = window.__blinkTest; editor.setSelection(new monaco.Selection(1, 1, 1, 1)); editor.setScrollTop(0) })
      // No follow mode is needed, and the receiving editor remains read-only.
      assert.equal(await receiver.evaluate(() => window.__blinkTest.editor.getOption(window.__blinkTest.monaco.editor.EditorOption.readOnly)), true)
      await sender.getByRole('button', { name: 'Blink Selection', exact: true }).click()
      await sender.waitForFunction(() => /selection-blink-local-[01]/.test(window.__blinkTest.editor.getDomNode().className)); await waitPulse(receiver)
      assert.deepEqual((await pulse(receiver))[0].range, { startLineNumber: 150, startColumn: 2, endLineNumber: 150, endColumn: 8 })
      assert(await receiver.evaluate(() => window.__blinkTest.editor.getScrollTop() > 0))
      assert.equal(await receiver.evaluate(() => window.__blinkTest.editor.getSelection().startLineNumber), 1)
      await receiver.locator('.yRemoteSelection[class*="selection-blink-"]').first().waitFor()
      const highlight = await receiver.locator('.yRemoteSelection[class*="selection-blink-"]').first().evaluate(el => {
        const style = getComputedStyle(el)
        return { outline: style.outlineStyle, border: style.borderWidth, easing: style.animationTimingFunction, duration: style.animationDuration }
      })
      assert.equal(highlight.outline, 'none'); assert.equal(highlight.border, '0px')
      assert.equal(highlight.easing, 'cubic-bezier(0.8, 0, 0.2, 1)'); assert.equal(highlight.duration, '0.5s')
      const first = (await pulse(receiver))[0].className
      await sender.getByRole('button', { name: 'Blink Selection', exact: true }).click()
      await receiver.waitForFunction(first => window.__blinkTest.editor.getModel().getAllDecorations().some(d => d.options.className?.includes('selection-blink') && d.options.className !== first), first)
      // Empty selection has no region to blink; never highlight an entire line.
      await select(sender, 50, 1, 1)
      await sender.waitForFunction(() => document.querySelector('button[aria-label="Blink Selection"]')?.disabled)
      await sender.waitForFunction(() => !/selection-blink-local-[01]/.test(window.__blinkTest.editor.getDomNode().className))
      await receiver.waitForFunction(() => !window.__blinkTest.editor.getModel().getAllDecorations().some(d => d.options.className?.includes('selection-blink')))
      // Cursor/presence updates do not replay an expired pulse.
      await select(sender, 2, 1, 2); await receiver.waitForTimeout(100)
      assert.deepEqual(await pulse(receiver), [])
      // Read-only attendees can also point out a selection without editing code.
      await select(receiver, 20, 2, 5)
      await receiver.getByRole('button', { name: 'Blink Selection', exact: true }).click(); await waitPulse(sender)
      assert.equal((await pulse(sender))[0].range.startLineNumber, 20)
      assert.equal(await sender.evaluate(() => window.__blinkTest.ytext.toString()), raw)
      await sender.getByRole('button', { name: 'Toggle theme', exact: true }).click()
      await sender.getByRole('button', { name: 'More actions', exact: true }).click()
      assert.equal(await sender.getByRole('menuitem', { name: 'Toggle theme', exact: true }).count(), 0)
      assert.equal(await sender.getByRole('menuitem', { name: 'Blink Selection', exact: true }).count(), 0)
      await sender.keyboard.press('Escape')
      await sender.evaluate(() => window.__blinkTest.provider.disconnect())
      await sender.waitForFunction(() => document.querySelector('button[aria-label="Blink Selection"]')?.disabled)
      await sender.evaluate(() => { void window.__blinkTest.provider.connect() })
      await sender.waitForFunction(() => !document.querySelector('button[aria-label="Blink Selection"]')?.disabled)
      await select(sender, 10, 2, 5); await sender.getByRole('button', { name: 'Blink Selection', exact: true }).click(); await waitPulse(receiver)
      // Visible toolbar controls must fit narrow touch layouts, including 3x DPI.
      const mobile = await browser.newContext({ viewport: { width: 320, height: 700 }, hasTouch: true, deviceScaleFactor: 3, ...(name !== 'firefox' ? { isMobile: true } : {}) })
      await mobile.addInitScript(token => { sessionStorage.setItem('sharecode-tab-auth', JSON.stringify({ state: { token }, version: 0 })); localStorage.setItem('i18nextLng', 'en') }, admin)
      const phone = await mobile.newPage(); await phone.goto('http://127.0.0.1:55461/room/' + room.id)
      for (const width of [320, 360, 390, 767]) {
        await phone.setViewportSize({ width, height: 700 }); await phone.getByRole('button', { name: 'Blink Selection', exact: true }).waitFor()
        const boxes = await phone.locator('header button').evaluateAll(buttons => buttons.filter(b => b.getBoundingClientRect().width > 0).map(b => { const r = b.getBoundingClientRect(); return { name: b.getAttribute('aria-label'), left: r.left, right: r.right, top: r.top, bottom: r.bottom } }))
        for (const box of boxes) assert(box.left >= 0 && box.right <= width, JSON.stringify(box))
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert(!(Math.min(boxes[i].right, boxes[j].right) > Math.max(boxes[i].left, boxes[j].left) + 1 && Math.min(boxes[i].bottom, boxes[j].bottom) > Math.max(boxes[i].top, boxes[j].top) + 1), JSON.stringify(boxes))
      }
      await phone.screenshot({ path: `/tmp/sharecode-blink-mobile-${name}.png` }); await mobile.close()
      const markdownRoom = (await request('/api/rooms', 'POST', { name: 'Markdown blink', language: 'python' }, admin)).room
      for (const page of pages) {
        await page.goto('http://127.0.0.1:55461/room/' + markdownRoom.id)
        await page.waitForFunction(() => window.__blinkTest?.provider.synced)
      }
      await sender.evaluate(() => window.__blinkTest.ytext.insert(0, 'Legacy code converted to Markdown'))
      await sender.getByRole('combobox').first().click()
      await sender.getByRole('option', { name: 'markdown', exact: true }).click()
      for (const page of pages) {
        await page.waitForFunction(() => window.__markdownBlinkTest?.provider.synced)
        assert.equal(await page.evaluate(() => window.__markdownBlinkTest.ydoc.clientID === window.__markdownBlinkTest.provider.awareness.clientID), true, 'Markdown seeding must not rotate the Y.Doc client ID')
      }
      await sender.evaluate(() => {
        const { view } = window.__markdownBlinkTest, { schema } = view.state
        const paragraphs = Array.from({ length: 120 }, (_, i) => schema.nodes.paragraph.create(null, [
          schema.text(`Line ${i + 1} 中文😀 `), schema.text('bold text', [schema.marks.strong.create()]), schema.text(' tail'),
        ]))
        view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, paragraphs))
      })
      await receiver.waitForFunction(() => window.__markdownBlinkTest.view.state.doc.childCount === 120)
      const selectMarkdown = async (page, index, empty = false) => {
        await page.waitForFunction(() => window.__markdownBlinkTest?.view.dom.isConnected && !window.__markdownBlinkTest.view.isDestroyed)
        return page.evaluate(({ index, empty }) => {
        const { view, TextSelection } = window.__markdownBlinkTest
        let pos = 1
        for (let i = 0; i < index; i++) pos += view.state.doc.child(i).nodeSize
        view.focus()
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos, empty ? pos : pos + view.state.doc.child(index).nodeSize + 10)))
        }, { index, empty })
      }
      const markdownPulse = page => page.locator('.ProseMirror-yjs-selection[class*="selection-blink-"]').first()
      await selectMarkdown(receiver, 0, true)
      await selectMarkdown(sender, 100)
      await receiver.locator('.ProseMirror-yjs-cursor').waitFor()
      // The peer has a real remote caret; the sender must never render its own.
      assert.equal(await sender.locator('.ProseMirror-yjs-cursor').count(), 0)
      assert(await sender.evaluate(() => window.getSelection()?.toString().includes('Line 101')))
      await receiver.evaluate(() => { document.querySelector('.md-editor-body').scrollTop = 0 })
      const before = await receiver.evaluate(() => {
        const { view, ydoc } = window.__markdownBlinkTest
        window.__markdownUpdates = 0; ydoc.on('update', () => window.__markdownUpdates++)
        return { content: view.state.doc.toJSON(), selection: view.state.selection.toJSON() }
      })
      await sender.getByRole('button', { name: 'Blink Selection', exact: true }).click()
      await markdownPulse(receiver).waitFor()
      await markdownPulse(sender).waitFor()
      await receiver.screenshot({ path: `/tmp/sharecode-markdown-blink-${name}.png` })
      assert(await receiver.locator('.md-editor-body').evaluate(el => el.scrollTop > 0))
      const markdownStyle = await markdownPulse(receiver).evaluate(el => {
        const style = getComputedStyle(el)
        return { outline: style.outlineStyle, border: style.borderWidth, easing: style.animationTimingFunction, duration: style.animationDuration }
      })
      assert.deepEqual(markdownStyle, highlight)
      assert.deepEqual(await receiver.evaluate(() => window.__markdownBlinkTest.view.state.selection.toJSON()), before.selection)
      const mdFirst = await markdownPulse(receiver).getAttribute('class')
      await sender.getByRole('button', { name: 'Blink Selection', exact: true }).click()
      await receiver.waitForFunction(first => [...document.querySelectorAll('.ProseMirror-yjs-selection[class*="selection-blink-"]')].some(el => el.className !== first), mdFirst)
      const caretStyle = await receiver.locator('.ProseMirror-yjs-cursor').first().evaluate(el => ({
        width: getComputedStyle(el).borderLeftWidth, dot: getComputedStyle(el, '::after').width, label: el.children.length,
      }))
      assert.deepEqual(caretStyle, { width: '2px', dot: '6px', label: 0 })
      // Read-only Markdown users can also select and signal without mutating XML.
      assert.equal(await receiver.locator('.ProseMirror').getAttribute('contenteditable'), 'false')
      const readOnlyParagraph = receiver.locator('.ProseMirror p').nth(20)
      await readOnlyParagraph.scrollIntoViewIfNeeded()
      const paragraphBox = await readOnlyParagraph.boundingBox()
      await receiver.mouse.move(paragraphBox.x + 4, paragraphBox.y + paragraphBox.height / 2)
      await receiver.mouse.down()
      await receiver.mouse.move(paragraphBox.x + 110, paragraphBox.y + paragraphBox.height / 2, { steps: 6 })
      await receiver.mouse.up()
      await receiver.waitForFunction(() => !window.__markdownBlinkTest.view.state.selection.empty)
      await receiver.getByRole('button', { name: 'Blink Selection', exact: true }).click()
      await sender.locator('.ProseMirror .yRemoteSelection[class*="selection-blink-"]').first().waitFor()
      await selectMarkdown(sender, 0, true)
      await sender.waitForFunction(() => document.querySelector('button[aria-label="Blink Selection"]')?.disabled)
      await receiver.waitForFunction(() => !document.querySelector('.selection-blink-local'))
      await receiver.waitForFunction(() => !document.querySelector('.ProseMirror-yjs-selection[class*="selection-blink-"]'))
      await selectMarkdown(sender, 2)
      await receiver.waitForTimeout(100)
      assert.equal(await markdownPulse(receiver).count(), 0)
      assert.deepEqual(await receiver.evaluate(() => window.__markdownBlinkTest.view.state.doc.toJSON()), before.content)
      assert.equal(await receiver.evaluate(() => window.__markdownUpdates), 0)
      // Mode changes clean up listeners and retain the toolbar action.
      await sender.getByRole('combobox').first().click()
      await sender.getByRole('option', { name: 'python', exact: true }).click()
      await receiver.locator('.monaco-editor').waitFor()
      await sender.getByRole('combobox').first().click()
      await sender.getByRole('option', { name: 'markdown', exact: true }).click()
      await receiver.locator('.ProseMirror').waitFor()
      await selectMarkdown(sender, 3)
      assert.equal(await sender.evaluate(() => window.__markdownBlinkTest.ydoc.clientID === window.__markdownBlinkTest.provider.awareness.clientID), true)
      assert.equal(await sender.locator('.ProseMirror-yjs-cursor').count(), 0)
      assert(await sender.evaluate(() => !window.getSelection()?.isCollapsed && window.__markdownBlinkTest.view.hasFocus()))
      await sender.getByRole('button', { name: 'Blink Selection', exact: true }).click()
      await markdownPulse(receiver).waitFor()
      await receiver.emulateMedia({ reducedMotion: 'reduce' })
      const reduced = await markdownPulse(receiver).evaluate(el => ({ animation: getComputedStyle(el).animationName, color: getComputedStyle(el).backgroundColor }))
      assert.equal(reduced.animation, 'none')
      assert.notEqual(reduced.color, 'rgba(0, 0, 0, 0)')
      assert.deepEqual(errors, [])
      console.log('PASS', name, 'Monaco + Markdown selection blink, repeat, CRLF/BOM/Unicode, empty-selection disabled, offscreen reveal, read-only, expiry, reconnect, mode switching, shared caret styles and responsive toolbar')
    } finally { await browser.close() }
  }
} finally { await web.close() }
