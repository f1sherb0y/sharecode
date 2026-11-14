// Host side of the Windows compatibility run: the Hyper-V test VMs (D:\VirtualMachines\tools),
// SSH, the desktop agent in the guest, hardware-level input and screenshots through Hyper-V.
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'

export const TOOLS = 'D:\\VirtualMachines\\tools'
const SCRIPTS = join(TOOLS, 'scripts')
const ELEVATED = join(TOOLS, 'elev')
const SSH_OPTIONS = ['-F', 'NUL', '-i', join(homedir(), '.ssh', 'vmtest_ed25519'), '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=NUL', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=10']

// Windows' own OpenSSH: Git's ssh, first on the path in Git Bash, does not take the NUL device.
const OPENSSH = join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'OpenSSH')
const SSH = join(OPENSSH, 'ssh.exe')
const SCP = join(OPENSSH, 'scp.exe')

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
}

function run(file, args, { timeout = 120_000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error && !allowFailure) reject(new Error(`${file} ${args.join(' ')}\n${stdout}${stderr}${error.message}`))
      else resolve({ stdout, stderr, code: error ? (error.code ?? 1) : 0 })
    })
  })
}

/** Runs one of the VM tooling's scripts through its elevated runner (see tools\scripts\Elevated-Runner.ps1). */
export async function elevated(script, args, { wait = true, timeout = 600_000 } = {}) {
  const heartbeat = join(ELEVATED, 'heartbeat')
  if (!existsSync(heartbeat)) throw new Error('The elevated runner is not running: start tools\\scripts\\Elevated-Runner.ps1 as administrator')
  const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`
  const queue = join(ELEVATED, 'queue')
  writeFileSync(join(queue, `${id}.tmp`), JSON.stringify({ id, file: join(SCRIPTS, script), args }))
  renameSync(join(queue, `${id}.tmp`), join(queue, `${id}.json`))
  if (!wait) return { id }
  const exit = join(ELEVATED, 'out', `${id}.exit`)
  const deadline = Date.now() + timeout
  while (!existsSync(exit)) {
    if (Date.now() > deadline) throw new Error(`${script} ${args.join(' ')} did not finish in ${timeout / 1000} s`)
    await sleep(300)
  }
  await sleep(100)
  const read = (name) => { try { return readFileSync(join(ELEVATED, 'out', name), 'utf8') } catch { return '' } }
  return { id, code: Number(read(`${id}.exit`).trim()), output: read(`${id}.log`) + read(`${id}.err`) }
}

export class Vm {
  constructor(name, { agentPort = 39100, localPort } = {}) {
    this.name = name
    this.target = `fish@${name.toLowerCase()}.mshome.net`
    this.agentPort = agentPort
    this.localPort = localPort
    // One folder per run: a server left over from an earlier run must never share this one's steps.
    this.inputDir = join(ELEVATED, 'input', `${name}-${process.pid}-${Date.now().toString(36)}`)
    this.sequence = 0
  }

  async start(checkpoint) {
    const args = ['start', this.name, ...(checkpoint ? ['-Checkpoint', checkpoint] : [])]
    const { code, output } = await elevated('Vm.ps1', args)
    if (code !== 0) throw new Error(`Could not start ${this.name}: ${output}`)
    const ip = /running, ip (\S+)/.exec(output)?.[1]
    // The .mshome.net name can lag behind a fresh boot; the address always works.
    if (ip) this.target = `fish@${ip}`
    return output.trim()
  }

  async restore(checkpoint = 'clean') {
    const { code, output } = await elevated('Vm.ps1', ['restore', this.name, '-Checkpoint', checkpoint])
    if (code !== 0) throw new Error(`Could not restore ${this.name}: ${output}`)
  }

  /** Runs PowerShell text in the guest (session 0, administrator). Use single quotes inside. */
  async ssh(command, options) {
    return run(SSH, [...SSH_OPTIONS, this.target, `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`], options)
  }

  /** What needs administrator rights in the guest (guest/elevated.ps1): its JSON answer. */
  async admin(command, target, { milliseconds = 0, timeout = 60_000 } = {}) {
    const { stdout } = await this.ssh(`powershell -NoProfile -ExecutionPolicy Bypass -File C:/test/elevated.ps1 ${command} '${target}' ${milliseconds}`, { timeout })
    return JSON.parse(stdout.trim().split(/\r?\n/).filter((line) => line.startsWith('{')).pop())
  }

  /** Answers a consent prompt (UAC) with Yes as the person at the keyboard does: Alt+Y on the
   *  secure desktop. Returns whether one was up; a screenshot of it goes to the directory. */
  async consent(directory, label) {
    if (!(await this.agent({ cmd: 'consent' })).consent) return false
    await sleep(1000) // the prompt takes a moment before it accepts keys
    if (directory) await this.screenshot(label, directory)
    await this.input('down:lalt tap:y up:lalt')
    for (let i = 0; i < 40 && (await this.agent({ cmd: 'consent' })).consent; i++) await sleep(200)
    return true
  }

  async upload(local, remote) {
    await run(SCP, [...SSH_OPTIONS, '-q', local, `${this.target}:${remote}`], { timeout: 300_000 })
  }

  async download(remote, local) {
    return run(SCP, [...SSH_OPTIONS, '-q', '-r', `${this.target}:${remote}`, local], { timeout: 300_000, allowFailure: true })
  }

  /** Forwards a local port to the desktop agent, which listens on the guest's loopback only. */
  async openTunnel() {
    // A port of its own: two runs side by side must never reach each other's VM.
    this.localPort ??= await freePort()
    this.tunnel = spawn(SSH, [...SSH_OPTIONS, '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `127.0.0.1:${this.localPort}:127.0.0.1:${this.agentPort}`, this.target],
      { stdio: 'ignore', windowsHide: true })
    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        const ping = await this.agent({ cmd: 'ping' })
        if (ping.computer && ping.computer.toLowerCase() !== this.name.toLowerCase()) throw new Error(`the tunnel reaches ${ping.computer}, not ${this.name}`)
        return ping
      } catch (error) {
        if (/the tunnel reaches/.test(error.message)) throw error
        if (Date.now() > deadline) throw new Error(`The desktop agent on ${this.name} does not answer: ${error.message}`)
        await sleep(500)
      }
    }
  }

  agent(request, timeout = 30_000) {
    return new Promise((resolve, reject) => {
      const socket = connect(this.localPort, '127.0.0.1')
      let text = ''
      socket.setEncoding('utf8')
      socket.setTimeout(timeout, () => socket.destroy(new Error('agent timeout')))
      socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
      socket.on('data', (chunk) => { text += chunk })
      socket.on('error', reject)
      socket.on('close', () => {
        if (!text.trim()) return reject(new Error('the agent closed the connection without an answer'))
        try {
          const answer = JSON.parse(text)
          if (answer && answer.error) reject(new Error(`agent: ${answer.error}`))
          else resolve(answer)
        } catch (error) { reject(error) }
      })
    })
  }

  /** Starts the Hyper-V input server for this VM (elevated; ends with closeInput or after 45 minutes). */
  async openInput() {
    rmSync(this.inputDir, { recursive: true, force: true })
    mkdirSync(this.inputDir, { recursive: true })
    await elevated('Hv-Input.ps1', ['-Name', this.name, '-Serve', this.inputDir, '-Minutes', '45'], { wait: false })
    const deadline = Date.now() + 30_000
    while (!existsSync(join(this.inputDir, 'ready'))) {
      if (Date.now() > deadline) throw new Error('The Hyper-V input server did not start')
      await sleep(200)
    }
  }

  /** Keyboard and mouse steps as the guest's hardware (see tools\scripts\Hv-Input.ps1 for the syntax). */
  async input(steps) {
    const id = String(++this.sequence).padStart(5, '0')
    writeFileSync(join(this.inputDir, `${id}.tmp`), steps)
    renameSync(join(this.inputDir, `${id}.tmp`), join(this.inputDir, `${id}.steps`))
    const done = join(this.inputDir, `${id}.done`)
    const deadline = Date.now() + 60_000
    while (!existsSync(done)) {
      if (Date.now() > deadline) throw new Error(`Input timed out: ${steps}`)
      await sleep(15)
    }
    const output = readFileSync(done, 'utf8')
    rmSync(done, { force: true })
    if (!/^ok\s*$/m.test(output)) throw new Error(`Input failed (${steps}): ${output}`)
    return output
  }

  /** Alt+Shift+<key> pressed and released in order, as a person does. */
  chord(key, { alt = 'lalt', shift = 'lshift', holdMs = 0 } = {}) {
    const press = holdMs ? `down:${key} wait:${holdMs} up:${key}` : `tap:${key}`
    return this.input(`down:${alt} down:${shift} ${press} up:${shift} up:${alt}`)
  }

  async click(x, y, button = 'left') {
    await this.input(`move:${Math.round(x)},${Math.round(y)} wait:120 click:${button}`)
  }

  /** The guest's screen as the hypervisor's video device shows it: no capture API is involved,
   *  so windows excluded from capture are in it. Returns { path, width, height, data (RGBA) }. */
  async screenshot(label, directory) {
    const name = `sccompat-${this.name}-${label}`
    await this.input(`shot:${name}`)
    const from = join(TOOLS, 'shots', `${name}.png`)
    const path = join(directory, `${label}.png`)
    renameSync(from, path)
    return { path, ...decodePng(readFileSync(path)) }
  }

  async closeInput() {
    if (!existsSync(this.inputDir)) return
    writeFileSync(join(this.inputDir, 'stop'), '')
    // The server removes 'ready' when it ends; then the folder can go.
    for (let i = 0; i < 20 && existsSync(join(this.inputDir, 'ready')); i++) await sleep(100)
    rmSync(this.inputDir, { recursive: true, force: true })
  }

  closeTunnel() {
    this.tunnel?.kill()
    this.tunnel = undefined
  }
}

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG (what System.Drawing writes) to RGBA. */
export function decodePng(buffer) {
  let offset = 8
  let width = 0, height = 0, colorType = 0
  const data = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); colorType = body[9]
      if (body[8] !== 8 || (colorType !== 2 && colorType !== 6) || body[12] !== 0) throw new Error('Unsupported PNG format')
    } else if (type === 'IDAT') data.push(body)
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const pixels = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = previous[i]
      const c = i >= channels ? previous[i - channels] : 0
      let add = 0
      if (filter === 1) add = a
      else if (filter === 2) add = b
      else if (filter === 3) add = (a + b) >> 1
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      line[i] = (line[i] + add) & 255
    }
    for (let x = 0; x < width; x++) {
      pixels[(y * width + x) * 4] = line[x * channels]
      pixels[(y * width + x) * 4 + 1] = line[x * channels + 1]
      pixels[(y * width + x) * 4 + 2] = line[x * channels + 2]
      pixels[(y * width + x) * 4 + 3] = channels === 4 ? line[x * channels + 3] : 255
    }
    previous = line
  }
  return { width, height, data: pixels }
}

/**
 * How much of the backdrop's black and white stripes shows through a rectangle of an image:
 * the mean brightness over white stripes minus that over black stripes, 0-255. 255 is the bare
 * backdrop, 0 an opaque window; a window whose background has opacity a gives 255 * (1 - a).
 */
export function stripeContrast(image, rect, backdrop) {
  const [left, top, right, bottom] = rect
  let white = 0, whiteCount = 0, black = 0, blackCount = 0
  for (let y = Math.max(0, top); y < Math.min(image.height, bottom); y++) {
    for (let x = Math.max(0, left); x < Math.min(image.width, right); x++) {
      const within = (x - backdrop.x) % (2 * backdrop.stripe)
      const position = within % backdrop.stripe
      // Leave the stripe edges out: scaling and antialiasing blur them.
      if (position < 5 || position >= backdrop.stripe - 5) continue
      const index = (y * image.width + x) * 4
      const luminance = (image.data[index] * 299 + image.data[index + 1] * 587 + image.data[index + 2] * 114) / 1000
      if (within >= backdrop.stripe) { white += luminance; whiteCount++ } else { black += luminance; blackCount++ }
    }
  }
  if (!whiteCount || !blackCount) return null
  return Math.round((white / whiteCount - black / blackCount) * 10) / 10
}
