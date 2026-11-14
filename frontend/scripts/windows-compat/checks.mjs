// The checks themselves. Everything the client is asked to do arrives as hardware input (Hyper-V's
// keyboard and mouse); everything asserted is read from Windows (styles, Z order, hit tests, the
// foreground window, pixels of the hypervisor's screen), never from the client's own state.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodePng, sleep, stripeContrast } from './lib.mjs'

const STEP = 60                 // logical pixels per Alt+Shift+arrow (MOVE_STEP in lib.rs)
const OPACITY_STEP = 0.1        // per Alt+Shift+[ or ] (window.ts)
const DEFAULT_OPACITY = 0.65
const MIN_OPACITY = 0.1
const TOLERANCE = 9             // of 255, for a measured stripe contrast
const WEBVIEW2_MINIMUM = 111    // the page's CSS (packaging/installer.iss)
const HIGH_INTEGRITY = 0x3000   // the integrity level of an elevated process

const round2 = (value) => Math.round(value * 100) / 100
const expectedContrast = (alpha) => 255 * (1 - alpha)

export async function runChecks(context) {
  const { vm, client, directory, log, process: processName, exePath } = context
  const checks = []
  const record = (id, title, status, detail = '') => {
    checks.push({ id, title, status, detail })
    log(`${status.padEnd(4)} ${id} ${title}${status === 'pass' && detail.length > 110 ? '' : detail ? ` :: ${detail}` : ''}`)
  }
  const check = (id, title, ok, detail) => record(id, title, ok ? 'pass' : 'fail', detail)

  // Every reading of the window is also held against two things that must never show, whatever
  // the client is doing at that moment (starting, closing): a system menu, with which Windows
  // draws its own close button over the page's, and being on screen while open to capture.
  const exposed = { systemMenu: [], capture: [] }
  const state = async (drain = false) => {
    const current = await vm.agent({ cmd: 'state', process: processName, drain })
    if (current.client?.visible && !current.client.iconic) {
      const reading = `${new Date().toTimeString().slice(0, 8)} [${current.client.flags.join(',')}] affinity 0x${current.client.affinity.toString(16)}`
      if (current.client.style & 0x80000) exposed.systemMenu.push(reading)
      if (current.client.affinity !== 17) exposed.capture.push(reading)
    }
    // The stand-in for "another app" must be an ordinary window, or every Z-order result is void.
    if (current.backdrop.flags.includes('TOPMOST')) throw new Error('Test error: the backdrop window became topmost')
    return current
  }
  const until = async (predicate, timeout = 6000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const current = await state()
      if (predicate(current) || Date.now() > deadline) return current
      await sleep(150)
    }
  }
  const has = (current, flag) => Boolean(current.client?.flags.includes(flag))
  const hitSummary = (current) => {
    const counts = {}
    for (const hit of current.hits) counts[hit.who] = (counts[hit.who] ?? 0) + 1
    return Object.entries(counts).map(([who, count]) => `${count}× ${who}`).join(', ') || 'no points'
  }
  const allHits = (current, who) => current.hits.length > 0 && current.hits.every((hit) => hit.who === who)
  const eventSummary = (current) => current.events.map((event) =>
    event.type + (event.key ? `:${event.key}` : event.char ? `:${event.char}` : event.button ? `:${event.button}@${event.x},${event.y}` : event.culture ? `:${event.culture}` : '')).join(' ') || 'none'
  const flags = (current) => `[${current.client?.flags.join(',') ?? 'no window'}]`

  let display = null
  let backdrop = null
  let alpha = DEFAULT_OPACITY

  // A strip of the window without controls on the start screen: under the title bar, above the
  // form. (Windows' notifications appear at the bottom right, so the top is the quiet part.)
  const band = (frame) => [frame[0] + 40, frame[1] + 60, frame[2] - 40, frame[1] + 200]
  const plainPoint = (frame) => [frame[0] + 150, frame[1] + 130]
  const outsidePoint = (current) => {
    const [left, top, width, height] = display.work
    const rect = current.client?.rect ?? [0, 0, 0, 0]
    const candidates = [[left + 60, top + height / 2], [left + width - 60, top + height / 2], [left + width / 2, top + 40], [left + width / 2, top + height - 40]]
    return candidates.find(([x, y]) => x < rect[0] - 20 || x > rect[2] + 20 || y < rect[1] - 20 || y > rect[3] + 20) ?? null
  }

  /** The contrast of the backdrop's stripes inside the client's strip, on the hypervisor's screen. */
  const measure = async (label, frame) => {
    await sleep(450)
    const shot = await vm.screenshot(label, directory)
    return stripeContrast(shot, band(frame), { x: backdrop.bounds[0], stripe: backdrop.stripe })
  }
  const near = (value, expected) => value !== null && Math.abs(value - expected) <= TOLERANCE

  // On a tool window with WS_SYSMENU, DWM draws its own small close button in the corner; it
  // shows through a translucent title bar, over the page's own. The title bar is gray, the native
  // button is tinted, so coloured pixels in the window's top right corner give it away (about
  // 270 of them).
  const nativeButtonPixels = (shot, frame) => {
    const [, top, right] = frame
    let coloured = 0
    for (let y = top + 1; y < top + 24; y++) {
      for (let x = right - 26; x < right - 1; x++) {
        const index = (y * shot.width + x) * 4
        const [r, g, b] = [shot.data[index], shot.data[index + 1], shot.data[index + 2]]
        if (Math.max(r, g, b) - Math.min(r, g, b) > 24) coloured++
      }
    }
    return coloured
  }

  const focusBackdrop = async () => {
    const current = await state()
    const point = outsidePoint(current)
    if (!point) throw new Error('no free point beside the client window')
    await vm.click(point[0], point[1])
    return until((next) => next.foregroundWho === 'backdrop', 4000)
  }
  const park = async () => {
    const point = outsidePoint(await state())
    if (point) await vm.input(`move:${Math.round(point[0])},${Math.round(point[1])}`)
  }
  const ensure = async ({ clickThrough, pinned }) => {
    let current = await state()
    if (current.client && !current.client.visible) { await vm.chord('h'); current = await until((next) => next.client?.visible) }
    if (clickThrough !== undefined && has(current, 'TRANSPARENT') !== clickThrough) {
      await vm.chord('f'); current = await until((next) => has(next, 'TRANSPARENT') === clickThrough)
    }
    if (pinned !== undefined && has(current, 'TOPMOST') !== pinned) {
      await vm.chord('t'); current = await until((next) => has(next, 'TOPMOST') === pinned)
    }
    return current
  }
  const stepOpacity = async (key, count, modifiers) => {
    for (let i = 0; i < count; i++) {
      await vm.chord(key, modifiers)
      alpha = round2(Math.min(1, Math.max(MIN_OPACITY, alpha + (key === ']' ? OPACITY_STEP : -OPACITY_STEP))))
    }
  }
  // Started through the shell by the app in front, as a double click in Explorer starts it. The
  // client needs administrator rights, so Windows asks for consent (UAC) on the secure desktop;
  // the answer is Alt+Y on the keyboard. The app in front is the backdrop, after a real click:
  // asked for by a background process, the prompt would wait minimized on the taskbar.
  let consents = 0
  const inFront = async () => {
    if (!(await state()).backdrop.visible) await vm.agent({ cmd: 'backdrop', show: true })
    const current = await focusBackdrop()
    if (current.foregroundWho !== 'backdrop') throw new Error(`the test window did not come to the front (${current.foregroundWho})`)
  }
  const start = async (ready, timeout = 40_000) => {
    await inFront()
    await vm.agent({ cmd: 'launch', path: exePath, shell: true })
    const started = Date.now()
    let prompts = 0
    for (;;) {
      if (await vm.consent(directory, `uac-${consents + 1}`)) { consents++; prompts++ }
      const current = await state()
      if (ready(current) || Date.now() - started > timeout) return { current, prompts, seconds: Math.round((Date.now() - started) / 100) / 10 }
      await sleep(200)
    }
  }
  const launch = () => start((next) => Boolean(next.client?.visible))
  // The client's WebView2 processes are elevated like it: only an administrator reads their command lines.
  const webviews = async () => (await vm.admin('webviews', client.webviewMatch)).count
  // WebView2's processes end a little after their host; gone within six seconds counts as gone.
  const webviewsLeft = async () => {
    let count = await webviews()
    for (let i = 0; i < 12 && count > 0; i++) { await sleep(500); count = await webviews() }
    return count
  }
  const group = async (name, body) => {
    try { await body() } catch (error) {
      // A lost connection to the VM says nothing about the client: the whole run is void.
      if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|agent timeout|without an answer|Input timed out/.test(String(error?.code) + String(error?.message))) {
        throw new Error(`Lost the connection to the VM during the ${name} checks: ${error.message}`)
      }
      record(`${name}!`, `${name} checks stopped`, 'fail', String(error?.message ?? error))
    }
  }

  // --- install -------------------------------------------------------------------------------
  if (context.system) {
    const runtime = (found) => Object.entries(found ?? {}).map(([scope, version]) => `${version} (${scope})`).join(', ') || 'absent'
    const system = context.system
    check('I1', 'Silent install started from the desktop', system.installerExit === 0 && system.installed,
      `installer exit ${system.installerExit} in ${system.installSeconds} s; installed: ${system.installed}`)
    check('I2', 'The installer asks for administrator rights once (UAC)', system.consentPrompts === 1, `${system.consentPrompts} prompt(s)`)
    const newest = Math.max(0, ...Object.values(system.webview2After ?? {}).map((version) => Number(version.split('.')[0])))
    check('I3', `It leaves a WebView2 runtime the page can use (Chromium ${WEBVIEW2_MINIMUM} or newer)`, newest >= WEBVIEW2_MINIMUM,
      `before: ${runtime(system.webview2Before)}, after: ${runtime(system.webview2After)}`)
    // The checks start the client themselves.
    await vm.ssh(`Stop-Process -Name ${processName} -Force -ErrorAction SilentlyContinue`, { allowFailure: true })
  }

  // --- the VM's own screen: the window is larger than 1024×768 -----------------------------------
  await group('A', async () => {
    // A Windows notification that holds the foreground (the new-network panel on a fresh
    // Windows 10) would stand in for the "app in front" in every check below.
    for (let i = 0; i < 3 && /^Shell_Charm|^NativeHWNDHost/.test((await state()).foreground?.class ?? ''); i++) {
      await vm.input('tap:esc')
      await sleep(700)
    }
    // 1366×768 is the common small laptop screen: lower than the window's own 760 px plus the taskbar.
    display = await vm.agent({ cmd: 'display', width: 1366, height: 768 })
    const { current, seconds } = await launch()
    check('A1', `Opens on a small ${display.bounds[2]}×${display.bounds[3]} screen`, Boolean(current.client?.visible), `window after ${seconds} s`)
    await sleep(2500)
    await vm.screenshot('a-own-screen', directory)
    const frame = current.client.frame
    const [left, top, width, height] = display.work
    const outside = frame[0] < left || frame[1] < top || frame[2] > left + width || frame[3] > top + height
    record('A2', 'Fits the work area of that screen', outside ? 'fail' : 'pass',
      `window ${frame[2] - frame[0]}×${frame[3] - frame[1]} at ${frame[0]},${frame[1]}; work area ${width}×${height}` +
      (outside ? `: ${[frame[0] < left && 'left', frame[1] < top && 'top', frame[2] > left + width && 'right', frame[3] > top + height && 'bottom'].filter(Boolean).join(', ')} edge off-screen` : ''))
    await vm.chord('q')
    const after = await until((next) => next.processCount === 0, 8000)
    await sleep(1500)
    const left2 = await webviewsLeft()
    check('A3', 'Alt+Shift+Q quits, WebView2 processes included', after.processCount === 0 && left2 === 0,
      `client processes ${after.processCount}, its WebView2 processes ${left2}`)
    if (after.processCount) await vm.ssh(`Stop-Process -Name ${processName} -Force -ErrorAction SilentlyContinue`, { allowFailure: true })
  })

  // --- launch on a 1920×1080 screen ------------------------------------------------------------
  let launched = false
  await group('L', async () => {
    const changed = await vm.agent({ cmd: 'display', width: 1920, height: 1080 })
    display = changed
    if (changed.result !== 'ok') record('L0', '1920×1080 display mode', 'info', `not available (${changed.result}); using ${changed.bounds[2]}×${changed.bounds[3]}`)
    backdrop = await vm.agent({ cmd: 'backdrop', show: true })
    const { current: first, seconds, prompts } = await launch()
    check('L1', 'Window appears', Boolean(first.client?.visible), `${seconds} s after start, the UAC answer included; class "${first.client?.class}"`)
    launched = Boolean(first.client)
    const tokens = (await vm.admin('elevation', processName)).processes
    check('L4', 'Runs as administrator, after one UAC prompt', prompts === 1 && tokens.length === 1 && tokens[0].elevated && tokens[0].integrity === HIGH_INTEGRITY,
      `${prompts} prompt(s); ${tokens.map((token) => `elevated=${token.elevated}, integrity 0x${token.integrity.toString(16)}`).join('; ') || 'no process'}`)
    for (let i = 0; i < 40 && await webviews() === 0; i++) await sleep(250)
    await sleep(3000)
    backdrop = await vm.agent({ cmd: 'backdrop', show: true, below: first.client.hwnd })
    const current = await until((next) => next.backdrop.z > next.client.z, 3000)
    alpha = DEFAULT_OPACITY

    const wanted = has(current, 'TOOLWINDOW') && !has(current, 'APPWINDOW') && !has(current, 'TRANSPARENT') && !has(current, 'NOACTIVATE') &&
      !has(current, 'TOPMOST') && current.client.affinity === 17
    check('L2', 'Starts hidden from capture and taskbar, not click-through, not pinned', wanted,
      `${flags(current)} display affinity 0x${current.client.affinity.toString(16)}, taskbar-eligible ${current.client.taskbarEligible}`)
    record('L3', 'Takes the keyboard when started', current.foregroundWho === 'client' ? 'pass' : 'info',
      current.foregroundWho === 'client' ? '' : `started by a background process; the foreground window stayed ${current.foregroundWho}`)

    const contrast = await measure('l-default', current.client.frame)
    check('L5', 'Page drawn, default background 65 % see-through to the desktop', near(contrast, expectedContrast(alpha)),
      `stripe contrast ${contrast} of 255 through the window, ${expectedContrast(alpha).toFixed(1)} expected`)

    const taskbar = await vm.agent({ cmd: 'taskbar' })
    const names = taskbar.items.map((item) => item.name)
    const control = names.some((name) => name.includes('SCCompat Backdrop'))
    const shown = names.filter((name) => /sharecode/i.test(name))
    if (!control) record('L6', 'No taskbar button', current.client.taskbarEligible ? 'fail' : 'info',
      `the taskbar's buttons cannot be listed on this build (${names.length} items, the test window's is not among them); by its styles the window is ${current.client.taskbarEligible ? '' : 'not '}eligible`)
    else check('L6', 'No taskbar button', shown.length === 0 && !current.client.taskbarEligible,
      shown.length ? `taskbar shows: ${shown.join(' | ')}` : `taskbar lists the test window but nothing named ShareCode (${names.length} items)`)

    const capture = decodePng(Buffer.from((await vm.agent({ cmd: 'capture' }, 60_000)).png, 'base64'))
    writeFileSync(join(directory, 'l-capture-api.txt'), `${capture.width}x${capture.height}`)
    const captured = stripeContrast(capture, band(current.client.frame), { x: backdrop.bounds[0], stripe: backdrop.stripe })
    check('L7', 'Absent from a screen capture (BitBlt) while visible on the screen', captured !== null && captured >= 250 && near(contrast, expectedContrast(alpha)),
      `stripe contrast in the capture ${captured} (255 = the window is not in it), on the real screen ${contrast}`)

    const coloured = nativeButtonPixels({ ...decodePng(readFileSync(join(directory, 'l-default.png'))) }, current.client.frame)
    const systemMenu = Boolean(current.client.style & 0x80000)
    check('L8', 'One close button: no native one drawn over the page\'s', coloured < 12 && !systemMenu,
      `${coloured} tinted pixels in the window's top right corner (a native button is about 270); WS_SYSMENU ${systemMenu ? 'set' : 'not set'}`)
  })
  if (!launched) return checks

  // --- transparency ----------------------------------------------------------------------------
  await group('T', async () => {
    const frame = (await ensure({ clickThrough: false })).client.frame
    const steps = [
      ['T1', '[', 3, {}, 'Alt+Shift+[ three times: 35 % background'],
      ['T2', ']', 10, {}, 'Alt+Shift+] to the top: opaque'],
      ['T3', '[', 12, {}, 'Alt+Shift+[ to the bottom: 10 % background'],
      ['T4', ']', 4, { alt: 'ralt', shift: 'rshift' }, 'Right Alt+Right Shift+] four times: 50 % background'],
    ]
    const corners = []
    for (const [id, key, count, modifiers, title] of steps) {
      await stepOpacity(key, count, modifiers)
      await sleep(450)
      const shot = await vm.screenshot(`t-${id.toLowerCase()}`, directory)
      const contrast = stripeContrast(shot, band(frame), { x: backdrop.bounds[0], stripe: backdrop.stripe })
      check(id, title, near(contrast, expectedContrast(alpha)), `stripe contrast ${contrast}, ${expectedContrast(alpha).toFixed(1)} expected for ${Math.round(alpha * 100)} %`)
      corners.push(`${Math.round(alpha * 100)} %: ${nativeButtonPixels(shot, frame)}`)
    }
    check('T5', 'One close button at every transparency', corners.every((corner) => Number(corner.split(': ')[1]) < 12),
      `tinted pixels in the window's top right corner at a background of ${corners.join(', ')} (a native button is about 270)`)
  })

  // --- pinning ---------------------------------------------------------------------------------
  await group('P', async () => {
    let current = await ensure({ clickThrough: false, pinned: false })
    const frame = current.client.frame
    current = await focusBackdrop()
    let contrast = await measure('p1-behind', frame)
    check('P1', 'Unpinned, it goes behind an app that is clicked', allHits(current, 'backdrop') && contrast >= 250,
      `hit test: ${hitSummary(current)}; stripe contrast ${contrast} (255 = covered)`)

    await state(true)
    await vm.chord('t')
    current = await until((next) => has(next, 'TOPMOST'))
    contrast = await measure('p2-pinned', frame)
    check('P2', 'Alt+Shift+T pins it above the app in front', has(current, 'TOPMOST') && current.client.z < current.backdrop.z && allHits(current, 'client') && near(contrast, expectedContrast(alpha)),
      `${flags(current)} z ${current.client.z} above the app's ${current.backdrop.z}; hit test: ${hitSummary(current)}; stripe contrast ${contrast}, ${expectedContrast(alpha).toFixed(1)} expected`)
    check('P3', 'Pinning by shortcut takes no focus', current.foregroundWho === 'backdrop', `foreground: ${current.foregroundWho}`)
    const leaked = current.events.filter((event) => (event.type === 'keydown' && event.key === 'T') || event.type === 'char')
    check('P4', 'The chord is not typed into the app in front', leaked.length === 0, `the app in front received: ${eventSummary(current)}`)

    current = await focusBackdrop()
    contrast = await measure('p5-stays', frame)
    check('P5', 'Pinned, it stays above when the other app is clicked', allHits(current, 'client') && near(contrast, expectedContrast(alpha)),
      `hit test: ${hitSummary(current)}; stripe contrast ${contrast}`)

    await vm.chord('t')
    current = await until((next) => !has(next, 'TOPMOST'))
    const unpinned = !has(current, 'TOPMOST')
    const [x, y] = plainPoint(frame)
    await vm.click(x, y)
    await until((next) => next.foregroundWho === 'client', 3000)
    current = await focusBackdrop()
    check('P6', 'Alt+Shift+T again unpins: it goes behind once more', unpinned && allHits(current, 'backdrop'),
      `${flags(current)}; hit test after clicking the client, then the other app: ${hitSummary(current)}`)
  })

  // --- click-through ---------------------------------------------------------------------------
  await group('C', async () => {
    let current = await ensure({ clickThrough: false, pinned: false })
    const frame = current.client.frame
    const [x, y] = plainPoint(frame)
    await vm.click(x, y)
    await until((next) => next.foregroundWho === 'client', 3000)
    current = await focusBackdrop()
    await state(true)

    await vm.chord('f')
    current = await until((next) => has(next, 'TRANSPARENT'))
    check('C1', 'Alt+Shift+F turns click-through on and pins the window',
      ['TRANSPARENT', 'LAYERED', 'NOACTIVATE', 'TOPMOST'].every((flag) => has(current, flag)), flags(current))
    let contrast = await measure('c2-click-through', frame)
    check('C2', 'Still drawn above the app in front', current.client.z < current.backdrop.z && near(contrast, expectedContrast(alpha)),
      `z ${current.client.z} above ${current.backdrop.z}; stripe contrast ${contrast}, ${expectedContrast(alpha).toFixed(1)} expected`)
    check('C3', "Windows' hit test skips the window everywhere", allHits(current, 'backdrop'), `hit test: ${hitSummary(current)}`)

    await state(true)
    await vm.click(x, y)
    await sleep(500)
    current = await state()
    const clicks = current.events.filter((event) => event.type === 'mousedown')
    check('C4', 'A real click on it lands in the app behind', clicks.length === 1 && Math.abs(clicks[0].x - x) <= 1 && Math.abs(clicks[0].y - y) <= 1,
      `clicked ${x},${y}; the app behind received: ${eventSummary(current)}`)
    await state(true)
    await vm.input('tap:f8')
    await sleep(400)
    current = await state()
    check('C5', 'Typing still goes to the app in front', current.events.some((event) => event.type === 'keydown' && event.key === 'F8') && current.foregroundWho === 'backdrop',
      `foreground: ${current.foregroundWho}; it received: ${eventSummary(current)}`)

    await vm.chord('f', { alt: 'ralt', shift: 'rshift' })
    current = await until((next) => !has(next, 'TRANSPARENT'))
    check('C6', 'Right Alt+Right Shift+F turns it off; pinning stays', !has(current, 'TRANSPARENT') && !has(current, 'NOACTIVATE') && has(current, 'TOPMOST') && allHits(current, 'client'),
      `${flags(current)}; hit test: ${hitSummary(current)}`)
    check('C7', 'Neither toggle took the focus', current.foregroundWho === 'backdrop', `foreground: ${current.foregroundWho}`)
    contrast = await measure('c8-after', frame)
    check('C8', 'Transparency unchanged afterwards', near(contrast, expectedContrast(alpha)), `stripe contrast ${contrast}, ${expectedContrast(alpha).toFixed(1)} expected`)

    await state(true)
    await vm.click(x, y)
    current = await until((next) => next.foregroundWho === 'client', 3000)
    check('C9', 'With it off, the same click reaches the client', current.foregroundWho === 'client' && !current.events.some((event) => event.type === 'mousedown'),
      `foreground: ${current.foregroundWho}; the app behind received: ${eventSummary(current)}`)
  })

  // --- hide and show ---------------------------------------------------------------------------
  await group('H', async () => {
    let current = await ensure({ clickThrough: false, pinned: true })
    const before = current.client
    current = await focusBackdrop()
    await vm.chord('h')
    current = await until((next) => next.client && !next.client.visible)
    let contrast = await measure('h1-hidden', before.frame)
    check('H1', 'Alt+Shift+H hides the window', !current.client.visible && contrast >= 250 && current.foregroundWho === 'backdrop',
      `visible ${current.client.visible}; stripe contrast ${contrast} (255 = gone); foreground: ${current.foregroundWho}`)
    await vm.chord('h')
    current = await until((next) => next.client?.visible)
    contrast = await measure('h2-shown', before.frame)
    check('H2', 'Alt+Shift+H shows it again in place, pinned, without taking focus',
      current.client.visible && String(current.client.rect) === String(before.rect) && has(current, 'TOPMOST') && current.foregroundWho === 'backdrop' && near(contrast, expectedContrast(alpha)),
      `visible ${current.client.visible}, rectangle ${current.client.rect} (was ${before.rect}), ${flags(current)}, foreground: ${current.foregroundWho}, stripe contrast ${contrast}`)

    // A held key repeats its key-down. The action must happen once and nothing may be typed.
    await state(true)
    await vm.input('down:lalt down:lshift down:h down:h down:h down:h up:h up:lshift up:lalt')
    await sleep(900)
    current = await state()
    const typed = current.events.filter((event) => (event.type === 'keydown' && event.key === 'H') || event.type === 'char')
    const once = !current.client.visible
    await vm.chord('h')
    current = await until((next) => next.client.visible)
    check('H3', 'Holding Alt+Shift+H hides once and types nothing into the app in front', once && typed.length === 0 && current.client.visible,
      `after four key-downs hidden=${once}; the app in front received: ${eventSummary({ events: typed.length ? typed : [] })}; shown again: ${current.client.visible}`)
  })

  // --- an elevated app in front ----------------------------------------------------------------
  await group('E', async () => {
    let current = await ensure({ clickThrough: false, pinned: true })
    const title = 'Shortcuts act while an administrator (elevated) app is in front'
    const step = Math.round(STEP * display.dpi / 96)
    // Task Manager runs elevated for an administrator without a prompt. A keyboard hook of a
    // process that is not elevated sees no keys while such a window has the focus (UIPI); the
    // client runs as administrator for that reason.
    await vm.agent({ cmd: 'backdrop', show: false })
    await vm.agent({ cmd: 'launch', path: 'C:/Windows/System32/Taskmgr.exe' })
    let manager = null
    for (let i = 0; i < 30 && !manager; i++) { await sleep(400); manager = (await vm.agent({ cmd: 'find', class: 'TaskManagerWindow' })).window }
    try {
      if (!manager) { record('E1', title, 'skip', 'Task Manager did not open'); return }
      current = await state()
      const point = [manager.rect[0] + 140, manager.rect[1] + 12]
      const covered = point[0] >= current.client.rect[0] && point[0] <= current.client.rect[2] && point[1] >= current.client.rect[1] && point[1] <= current.client.rect[3]
      if (current.foreground?.class !== 'TaskManagerWindow' && !covered) await vm.click(...point)
      current = await until((next) => next.foreground?.class === 'TaskManagerWindow', 4000)
      if (current.foreground?.class !== 'TaskManagerWindow') { record('E1', title, 'skip', `Task Manager did not take the focus (${current.foreground?.class})`); return }
      const held = (key, count) => vm.input(`down:lalt down:lshift ${Array(count).fill(`down:${key}`).join(' ')} up:${key} up:lshift up:lalt`)
      const start = current.client.rect[0]
      await vm.chord('right')
      current = await until((next) => next.client.rect[0] !== start, 2500)
      const moved = current.client.rect[0] - start
      await held('right', 3)
      await sleep(900)
      const repeated = (await state()).client.rect[0] - start - moved
      const wasPinned = has(await state(), 'TOPMOST')
      await vm.chord('t')
      const unpinned = has(await until((next) => has(next, 'TOPMOST') !== wasPinned, 2500), 'TOPMOST') !== wasPinned
      await vm.chord('t')
      const repinned = has(await until((next) => has(next, 'TOPMOST') === wasPinned, 2500), 'TOPMOST') === wasPinned
      await vm.chord('f')
      const through = has(await until((next) => has(next, 'TRANSPARENT'), 2500), 'TRANSPARENT')
      await vm.chord('f')
      const solid = !has(await until((next) => !has(next, 'TRANSPARENT'), 2500), 'TRANSPARENT')
      // Held: four key-downs must hide it once, not toggle four times.
      await held('h', 4)
      await sleep(900)
      const hidden = !(await state()).client.visible
      await vm.chord('h')
      const shownAgain = (await until((next) => next.client.visible, 2500)).client.visible
      await vm.screenshot('e1-elevated-front', directory)
      await vm.ssh('Stop-Process -Name Taskmgr -Force -ErrorAction SilentlyContinue', { allowFailure: true })
      await sleep(800)
      current = await ensure({})
      await vm.agent({ cmd: 'backdrop', show: true, below: current.client.hwnd })
      await focusBackdrop()
      // The control, and the way back: the arrows with an ordinary app in front again.
      const back = (await state()).client.rect[0]
      await vm.chord('right')
      const control = (await until((next) => next.client.rect[0] !== back, 2500)).client.rect[0] - back
      const steps = Math.round(((await state()).client.rect[0] - start) / step)
      for (let i = 0; i < steps; i++) await vm.chord('left')
      await sleep(400)
      check('E1', title, moved === step,
        `with Task Manager focused Alt+Shift+Right moved the window ${moved} px; with an ordinary app in front it moved ${control} px`)
      check('E2', 'There, a held arrow repeats', repeated === 3 * step, `three key-downs without a key-up moved it ${repeated} px`)
      check('E3', 'There, Alt+Shift+T unpins and pins', unpinned && repinned, `first press changed pinning: ${unpinned}, second changed it back: ${repinned}`)
      check('E5', 'There, Alt+Shift+F turns click-through on and off', through && solid, `on after the first press: ${through}; off after the second: ${solid}`)
      check('E4', 'There, a held Alt+Shift+H hides once, and H shows again', hidden && shownAgain, `after four key-downs hidden=${hidden}; after the next press visible=${shownAgain}`)
    } finally {
      await vm.ssh('Stop-Process -Name Taskmgr -Force -ErrorAction SilentlyContinue', { allowFailure: true })
      current = await state()
      if (current.client) await vm.agent({ cmd: 'backdrop', show: true, below: current.client.hwnd })
    }
  })

  // --- a stalled client --------------------------------------------------------------------------
  await group('S', async () => {
    await ensure({ clickThrough: false, pinned: true })
    await focusBackdrop()
    // Frozen for five seconds while keys are typed: Windows stops calling a hook that does not
    // answer in time. The shortcuts have to work again afterwards.
    const frozen = vm.admin('suspend', processName, { milliseconds: 5000 })
    await sleep(2500) // SSH and compiling the helper come first; the keys below must fall into the freeze
    await vm.input(Array(14).fill('tap:a').join(' '))
    await frozen
    const results = []
    for (const wait of [1500, 3000, 3000]) {
      await sleep(wait)
      const before = has(await state(), 'TOPMOST')
      await vm.chord('t')
      const after = has(await until((next) => has(next, 'TOPMOST') !== before, 2000), 'TOPMOST')
      results.push(after !== before)
    }
    check('S1', 'Shortcuts work again after the client was frozen for 5 s', results[1] && results[2],
      `Alt+Shift+T acted 1.5 s after the freeze: ${results[0]}, 4.5 s after: ${results[1]}, 7.5 s after: ${results[2]}`)
    await ensure({ clickThrough: false, pinned: true })
  })

  // --- moving ----------------------------------------------------------------------------------
  await group('M', async () => {
    let current = await ensure({ clickThrough: false, pinned: true })
    current = await focusBackdrop()
    const step = Math.round(STEP * display.dpi / 96)
    const start = current.client.rect
    const position = (next) => [next.client.rect[0], next.client.rect[1]]
    const moved = []
    for (const [key, dx, dy] of [['right', 1, 0], ['down', 0, 1], ['left', -1, 0], ['up', 0, -1]]) {
      const from = position(await state())
      await vm.chord(key)
      const to = position(await until((next) => next.client.rect[0] !== from[0] || next.client.rect[1] !== from[1], 2500))
      moved.push({ key, ok: to[0] - from[0] === dx * step && to[1] - from[1] === dy * step, text: `${key} ${to[0] - from[0]},${to[1] - from[1]}` })
    }
    current = await state()
    check('M1', `Alt+Shift+arrows move the window ${step} px each way`, moved.every((move) => move.ok) && String(current.client.rect) === String(start), moved.map((move) => move.text).join('; '))

    // A held key: the keyboard repeats the key-down without a key-up in between.
    const repeat = (key, count) => vm.input(`down:lalt down:lshift ${Array(count).fill(`down:${key}`).join(' ')} up:${key} up:lshift up:lalt`)
    await repeat('left', 3)
    await sleep(600)
    current = await state()
    check('M2', 'Holding the arrow repeats the move', current.client.rect[0] === start[0] - 3 * step, `three key-downs without a key-up moved it ${current.client.rect[0] - start[0]} px`)

    // Optional (--soak <rounds>): the same key-downs many times over, each round right and back,
    // counting the rounds in which the window moved by anything but one step per key-down.
    if (context.soak) {
      const position = async () => { await sleep(350); return (await state()).client.rect[0] }
      const taps = (key, count) => vm.input(`down:lalt down:lshift ${Array(count).fill(`tap:${key}`).join(' ')} up:lshift up:lalt`)
      const run = async (press) => {
        const wrong = []
        let at = await position()
        for (let round = 0; round < context.soak; round++) {
          for (const [key, sign] of [['right', 1], ['left', -1]]) {
            await press(key, 3)
            const next = await position()
            if (next - at !== sign * 3 * step) wrong.push(`${key} ${next - at}`)
            at = next
          }
        }
        return wrong
      }
      const held = await run(repeat)
      const tapped = await run(taps)
      // One key held down for 1.5 s, with a single key-down sent: does the guest repeat it itself?
      const before = await position()
      await vm.input('down:lalt down:lshift down:right wait:1500 up:right up:lshift up:lalt')
      const own = ((await position()) - before) / step
      for (let i = 0; i < own; i++) await vm.chord('left')
      record('M5', `Soak: ${2 * context.soak} times three key-downs, held and tapped`, held.length + tapped.length ? 'fail' : 'pass',
        `held without key-up: ${held.length} wrong (${held.slice(0, 8).join('; ') || 'none'}); pressed and released: ${tapped.length} wrong (${tapped.slice(0, 8).join('; ') || 'none'}); ` +
        `one key-down held for 1.5 s moved the window ${own} step(s)`)
    }

    const [workLeft, workTop, workWidth] = display.work
    await repeat('left', Math.ceil(start[0] / step) + 3)
    await repeat('up', Math.ceil(start[1] / step) + 3)
    await sleep(700)
    const corner = (await state()).client.rect
    await repeat('right', Math.ceil(workWidth / step) + 3)
    await sleep(900)
    const far = (await state()).client.rect
    check('M3', 'It stops at the edges of the work area', corner[0] === workLeft && corner[1] === workTop && far[2] === workLeft + workWidth,
      `left edge ${corner[0]} (work area ${workLeft}), top ${corner[1]} (${workTop}), then right edge ${far[2]} (${workLeft + workWidth})`)
    current = await state()
    check('M4', 'Moving takes no focus', current.foregroundWho === 'backdrop', `foreground: ${current.foregroundWho}`)

    // Back near the middle for the checks that follow.
    await repeat('left', Math.round((far[0] - start[0]) / step))
    await repeat('down', Math.round((start[1] - far[1]) / step))
    await sleep(700)
  })

  // --- the title bar, with the real mouse ------------------------------------------------------
  await group('U', async () => {
    if (display.dpi !== 96) { record('U0', 'Title bar buttons', 'skip', 'button positions are known at 100 % scaling only'); return }
    let current = await ensure({ clickThrough: false, pinned: false })
    const button = (frame, offset) => [frame[2] - offset, frame[1] + 16]
    const CLICK_THROUGH = 184, PIN = 120, MINIMIZE = 79, MAXIMIZE = 47
    // Bring the client to the front first: unpinned, it may be behind the other app.
    await vm.chord('t')
    current = await until((next) => has(next, 'TOPMOST'))
    let frame = current.client.frame

    // Dragging the title bar.
    const from = [Math.round((frame[0] + frame[2]) / 2), frame[1] + 16]
    const path = [1, 2, 3, 4, 5].map((i) => `move:${from[0] + i * 24},${from[1] + i * 12} wait:60`).join(' ')
    // The page starts the native drag from its mouse-down handler; on a loaded host that has taken
    // over 200 ms, and a move made before then is not part of the drag.
    await vm.input(`move:${from[0]},${from[1]} wait:200 mdown:left wait:500 ${path} wait:200 mup:left`)
    await sleep(600)
    current = await state()
    const drag = [current.client.frame[0] - frame[0], current.client.frame[1] - frame[1]]
    check('U1', 'Dragging the title bar moves the window', Math.abs(drag[0] - 120) <= 3 && Math.abs(drag[1] - 60) <= 3, `dragged 120,60; the window moved ${drag[0]},${drag[1]}`)
    frame = current.client.frame

    // The pin button.
    await vm.click(...button(frame, PIN))
    current = await until((next) => !has(next, 'TOPMOST'), 3000)
    const off = !has(current, 'TOPMOST')
    await sleep(800) // a second click within the double-click time would be a double click
    await vm.click(...button(frame, PIN))
    current = await until((next) => has(next, 'TOPMOST'), 3000)
    check('U2', 'The pin button unpins and pins', off && has(current, 'TOPMOST'), `after the first click pinned=${!off}, after the second ${flags(current)}`)
    await park()

    // Maximize and restore.
    await vm.click(...button(frame, MAXIMIZE))
    current = await until((next) => next.client.frame[2] - next.client.frame[0] >= display.work[2] - 2, 4000)
    const full = current.client.frame
    const fills = full[0] <= display.work[0] && full[1] <= display.work[1] && full[2] >= display.work[0] + display.work[2] && full[3] >= display.work[1] + display.work[3]
    await vm.input(`move:${Math.round(full[2] / 2)},${Math.round(full[3] / 2)}`)
    const contrast = await measure('u3-maximized', full)
    check('U3', 'Maximized, it fills the work area and stays see-through', fills && near(contrast, expectedContrast(alpha)),
      `frame ${full}, rectangle ${current.client.rect}, on work area ${display.work}; stripe contrast ${contrast}, ${expectedContrast(alpha).toFixed(1)} expected`)
    await vm.click(...button(full, MAXIMIZE))
    current = await until((next) => String(next.client.frame) === String(frame), 4000)
    check('U4', 'Restore returns it to its place', String(current.client.frame) === String(frame), `frame ${current.client.frame}, was ${frame}`)
    await park()

    // The click-through button; only the shortcut can turn it off again.
    await vm.click(...button(frame, CLICK_THROUGH))
    current = await until((next) => has(next, 'TRANSPARENT'), 4000)
    const on = has(current, 'TRANSPARENT') && has(current, 'TOPMOST')
    await park()
    await sleep(300)
    current = await state()
    const through = allHits(current, 'backdrop')
    await vm.chord('f')
    current = await until((next) => !has(next, 'TRANSPARENT'), 4000)
    check('U5', 'The click-through button turns it on; Alt+Shift+F gets the window back', on && through && !has(current, 'TRANSPARENT'),
      `after the button: on=${on}, hit test all through=${through}; after the shortcut ${flags(current)}`)

    // Minimized, the window has no taskbar button to come back from: the hide shortcut restores it.
    await vm.click(...button(frame, MINIMIZE))
    current = await until((next) => next.client.iconic, 4000)
    const minimized = current.client.iconic
    await park()
    await vm.chord('h')
    current = await until((next) => next.client.visible && !next.client.iconic, 4000)
    check('U6', 'Minimize, then Alt+Shift+H brings the window back', minimized && current.client.visible && !current.client.iconic && String(current.client.frame) === String(frame),
      `minimized=${minimized}; after the shortcut: visible=${current.client.visible}, minimized=${current.client.iconic}, frame ${current.client.frame} (was ${frame})`)
    const restored = await measure('u7-restored', frame)
    check('U7', 'The page is drawn again after that', near(restored, expectedContrast(alpha)),
      `stripe contrast ${restored}, ${expectedContrast(alpha).toFixed(1)} expected (255 = an empty frame)`)
    const wasPinned = has(current, 'TOPMOST')
    await vm.click(...button(frame, PIN))
    current = await until((next) => has(next, 'TOPMOST') !== wasPinned, 3000)
    const responds = has(current, 'TOPMOST') !== wasPinned
    check('U8', 'And its buttons respond', responds, responds ? '' : 'a click on the pin button changed nothing')
    if (responds) { await sleep(800); await vm.click(...button(frame, PIN)); await until((next) => has(next, 'TOPMOST') === wasPinned, 3000) }
    await park()
    if (!near(restored, expectedContrast(alpha)) || !responds) {
      // Start over so the checks that follow do not inherit a dead page.
      await vm.chord('q')
      await until((next) => next.processCount === 0, 8000)
      await vm.ssh(`Stop-Process -Name ${processName} -Force -ErrorAction SilentlyContinue`, { allowFailure: true })
      const again = (await launch()).current
      await sleep(3000)
      backdrop = await vm.agent({ cmd: 'backdrop', show: true, below: again.client.hwnd })
    }

    // The other way back: starting the client a second time.
    current = await ensure({ clickThrough: false, pinned: true })
    frame = current.client.frame
    await vm.click(...button(frame, MINIMIZE))
    current = await until((next) => next.client.iconic, 4000)
    await park()
    current = (await start((next) => next.client?.visible && !next.client.iconic, 20_000)).current
    const second = await measure('u9-second-start', frame)
    current = await state()
    check('U9', 'Starting the client again restores a minimized window, page drawn', current.client.visible && !current.client.iconic && current.processCount === 1 && near(second, expectedContrast(alpha)),
      `visible=${current.client.visible}, minimized=${current.client.iconic}, processes ${current.processCount}, stripe contrast ${second} (${expectedContrast(alpha).toFixed(1)} expected)`)
    if (!near(second, expectedContrast(alpha))) {
      await vm.chord('q')
      await until((next) => next.processCount === 0, 8000)
      await vm.ssh(`Stop-Process -Name ${processName} -Force -ErrorAction SilentlyContinue`, { allowFailure: true })
      const again = (await launch()).current
      await sleep(3000)
      backdrop = await vm.agent({ cmd: 'backdrop', show: true, below: again.client.hwnd })
    }
  })

  // --- input language --------------------------------------------------------------------------
  await group('K', async () => {
    const before = context.system?.inputLanguages ?? []
    const second = before[0]?.toLowerCase().startsWith('en') ? 'zh-CN' : 'en-US'
    const list = (await vm.agent({ cmd: 'languages', list: [before[0] ?? 'zh-CN', second] }, 60_000)).list
    await sleep(2500)
    let current = await focusBackdrop()
    const layout = current.layout
    await state(true)
    await vm.input('down:lalt down:lshift up:lshift up:lalt')
    await sleep(900)
    current = await state()
    const switches = current.layout !== layout || current.events.some((event) => event.type === 'inputlanguage')
    if (!switches) {
      record('K1', 'The shortcuts do not switch the input language', 'skip',
        `not measurable here: with ${list.join(' + ')} installed, Alt+Shift alone did not switch the language either (layout ${layout})`)
      return
    }
    await vm.input('down:lalt down:lshift up:lshift up:lalt')
    await sleep(900)
    const base = (await state(true)).layout
    await vm.chord('t')
    await sleep(500)
    await vm.chord('t')
    await sleep(700)
    current = await state()
    check('K1', 'The shortcuts do not switch the input language', current.layout === base && !current.events.some((event) => event.type === 'inputlanguage'),
      `with ${list.join(' + ')}: Alt+Shift alone switched ${layout} -> another layout (control); after two Alt+Shift+T the layout is ${current.layout} (was ${base}); events: ${eventSummary(current)}`)
  })

  // --- closing ---------------------------------------------------------------------------------
  await group('X', async () => {
    let current = await ensure({ clickThrough: false, pinned: true })
    const CLOSE = 15
    const button = (frame, offset) => [frame[2] - offset, frame[1] + 16]
    await vm.click(...button(current.client.frame, CLOSE))
    current = await until((next) => next.processCount === 0, 8000)
    await sleep(1500)
    const left = await webviewsLeft()
    check('X1', 'The close button ends the client and its WebView2 processes', current.processCount === 0 && left === 0, `client processes ${current.processCount}, WebView2 processes ${left}`)
  })

  await group('X2', async () => {
    const title = 'Alt+Shift+Q quits while an administrator (elevated) app is in front'
    await vm.ssh(`Stop-Process -Name ${processName} -Force -ErrorAction SilentlyContinue`, { allowFailure: true })
    await sleep(1000)
    await launch()
    await sleep(3000)
    await vm.agent({ cmd: 'backdrop', show: false })
    await vm.agent({ cmd: 'launch', path: 'C:/Windows/System32/Taskmgr.exe' })
    let manager = null
    for (let i = 0; i < 30 && !manager; i++) { await sleep(400); manager = (await vm.agent({ cmd: 'find', class: 'TaskManagerWindow' })).window }
    try {
      let current = await state()
      if (manager && current.foreground?.class !== 'TaskManagerWindow') await vm.click(manager.rect[0] + 140, manager.rect[1] + 12)
      current = await until((next) => next.foreground?.class === 'TaskManagerWindow', 4000)
      if (current.foreground?.class !== 'TaskManagerWindow') { record('X2', title, 'skip', `Task Manager did not take the focus (${current.foreground?.class})`); return }
      await vm.chord('q')
      current = await until((next) => next.processCount === 0, 8000)
      await sleep(1500)
      const left = await webviewsLeft()
      check('X2', title, current.processCount === 0 && left === 0, `client processes ${current.processCount}, WebView2 processes ${left}`)
    } finally {
      await vm.ssh('Stop-Process -Name Taskmgr -Force -ErrorAction SilentlyContinue', { allowFailure: true })
    }
  })

  // --- the installer over a running client, and the uninstaller ----------------------------------
  // Both are started from the desktop, not elevated, and ask for administrator rights themselves.
  const setup = async (path, args, label) => {
    await inFront()
    await vm.agent({ cmd: 'install', path, arguments: args })
    let prompts = 0
    for (;;) {
      await sleep(700)
      if (await vm.consent(directory, `${label}-uac-${prompts + 1}`)) prompts++
      const status = await vm.agent({ cmd: 'installStatus', exe: exePath })
      if (status.done || status.seconds > 300) return { ...status, prompts }
    }
  }
  const installed = async () => (await vm.ssh(`(Test-Path '${client.installed.join("'),(Test-Path '")}') -join ','`)).stdout.trim()
  await group('R', async () => {
    await vm.ssh(`Stop-Process -Name ${processName} -Force -ErrorAction SilentlyContinue`, { allowFailure: true })
    await sleep(1000)
    const before = (await launch()).current
    await sleep(3000)
    // What the client's updater runs, and the one-line install command on a PC that has the client.
    const again = await setup('C:/test/setup.exe', ['/SILENT', '/NORESTART', '/LAUNCH'], 'r1')
    let current = await until((next) => next.client?.visible && next.client.pid !== before.client?.pid, 20_000)
    await sleep(3000)
    const tokens = (await vm.admin('elevation', processName)).processes
    const present = await installed()
    check('R1', 'The installer over a running client closes it, installs and starts it again, with one UAC prompt',
      again.exitCode === 0 && again.prompts === 1 && Boolean(current.client?.visible) && current.client.pid !== before.client?.pid && current.processCount === 1 &&
      tokens.length === 1 && tokens[0].elevated && !/False/.test(present),
      `installer exit ${again.exitCode} after ${again.seconds} s, ${again.prompts} prompt(s); client process ${before.client?.pid} before, ${current.client?.pid} after, ` +
      `visible=${Boolean(current.client?.visible)}, elevated=${tokens.map((token) => token.elevated).join(',')}; executable, Start menu entry, uninstall entry present: ${present}`)
    await vm.screenshot('r1-reinstalled', directory)

    const removal = await setup(`%ProgramFiles%/${client.installDir}/unins000.exe`, ['/VERYSILENT', '/NORESTART'], 'r2')
    current = await until((next) => next.processCount === 0, 10_000)
    await sleep(1500)
    const left = await installed()
    const webviewsAfter = await webviewsLeft()
    check('R2', 'The uninstaller closes the running client and removes it, with one UAC prompt',
      removal.exitCode === 0 && removal.prompts === 1 && current.processCount === 0 && webviewsAfter === 0 && !/True/.test(left),
      `uninstaller exit ${removal.exitCode}, ${removal.prompts} prompt(s); client processes ${current.processCount}, WebView2 processes ${webviewsAfter}; ` +
      `executable, Start menu entry, uninstall entry present: ${left}`)
  })

  const readings = (list) => list.length ? `${list.length} reading(s): ${list.slice(0, 6).join('; ')}${list.length > 6 ? '; ...' : ''}` : 'no reading'
  check('Z1', 'On screen, the window never has a system menu (a second, native close button)', exposed.systemMenu.length === 0, readings(exposed.systemMenu))
  check('Z2', 'On screen, the window is never open to screen capture', exposed.capture.length === 0, readings(exposed.capture))

  // Make sure nothing is left running.
  await vm.ssh(`Stop-Process -Name ${processName} -Force -ErrorAction SilentlyContinue`, { allowFailure: true })
  return checks
}
