// Runs the customer client's window features on the Hyper-V test VMs, one Windows build after
// another, and writes what each build did. See README.md beside this file.
//
//   node run.mjs                                   every VM, checkpoint clean
//   node run.mjs --vms Win10-22H2,Win11-24H2       some of them
//   node run.mjs --vms Win10-22H2 --checkpoint patched
//   node run.mjs --vms Win10-22H2 --soak 50        also repeat the held arrow keys 100 times
//   node run.mjs --vms Win11-25H2 --keep           leave the VM running afterwards (probe.mjs)
//   node run.mjs --vms Win11-25H2 --attach         a VM left running by --keep: no restore, no install
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS, Vm, sleep } from './lib.mjs'
import { runChecks } from './checks.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const frontend = resolve(here, '..', '..')

const ALL_VMS = ['Win10-22H2', 'Win11-21H2', 'Win11-23H2', 'Win11-24H2', 'Win11-25H2', 'Win11-26H1', 'Win11-26H2']

function newest(directory, pattern) {
  if (!existsSync(directory)) return null
  const names = readdirSync(directory).filter((name) => pattern.test(name)).sort()
  return names.length ? join(directory, names[names.length - 1]) : null
}

// The development identity: its own name, install directory and WebView2 profile, so it never
// touches a released client (src-mygo-client/build-windows.ps1 without -Release).
const CLIENT = {
  label: 'MyGo client (src-mygo-client), development identity',
  installer: () => newest(join(frontend, '..', 'build', 'mygo-client'), /^sharecode-client-mygo-dev_.*-setup.exe$/),
  // Installed for the machine, under Program Files.
  installDir: 'ShareCode Client (MyGo Development)',
  exe: 'sharecode-client-mygo-dev.exe',
  // Part of the command line of the client's own WebView2 processes.
  webviewMatch: 'sharecode-client-mygo-dev',
  // What an installation consists of besides its directory: gone again after uninstalling.
  installed: [
    'C:/Program Files/ShareCode Client (MyGo Development)/sharecode-client-mygo-dev.exe',
    'C:/ProgramData/Microsoft/Windows/Start Menu/Programs/ShareCode Client (MyGo Development).lnk',
    'HKLM:/SOFTWARE/Microsoft/Windows/CurrentVersion/Uninstall/dev.sharecode.client.mygo-dev_is1',
  ],
}

function parseArguments(argv) {
  const options = { vms: ALL_VMS, checkpoint: 'clean', keep: false, attach: false, out: null, soak: 0 }
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]
    if (name === '--vms') options.vms = argv[++i].split(',').map((vm) => vm.trim()).filter(Boolean)
    else if (name === '--checkpoint') options.checkpoint = argv[++i]
    else if (name === '--out') options.out = argv[++i]
    else if (name === '--soak') options.soak = Number(argv[++i])
    else if (name === '--keep') options.keep = true
    else if (name === '--attach') options.attach = options.keep = true
    else throw new Error(`Unknown argument ${name}`)
  }
  return options
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

/** The installer on the desktop as the signed-in user, with the command line of the one-line
 *  install command (silent: a progress window only) without /LAUNCH, which would also start the
 *  client. It asks for administrator rights itself; the UAC prompt is answered like a person
 *  does. Screenshots show what the user sees. */
async function install(vm, client, directory, log) {
  const exe = `%ProgramFiles%/${client.installDir}/${client.exe}`
  // Started by the app in front (the test window, after a real click), as from Explorer or a
  // terminal: asked for by a background process, the UAC prompt would wait on the taskbar.
  await vm.agent({ cmd: 'backdrop', show: true })
  for (let i = 0; i < 3; i++) {
    // The first click may only dismiss a Windows flyout (the new-network panel of a fresh install).
    await vm.click(300, 300)
    await sleep(600)
    if ((await vm.agent({ cmd: 'state', process: client.exe.replace(/\.exe$/, '') })).foregroundWho === 'backdrop') break
  }
  const started = await vm.agent({ cmd: 'install', path: 'C:/test/setup.exe', arguments: ['/SILENT', '/NORESTART', '/LOG=C:/test/out/install.log'] })
  log(`installing on the desktop (WebView2 before: ${JSON.stringify(started.webview2)})`)
  const result = { webview2Before: started.webview2, consentPrompts: 0 }
  const shots = [3, 12, 30, 60, 120, 240]
  let status
  for (;;) {
    await sleep(1000)
    if (await vm.consent(directory, `i-consent-${result.consentPrompts + 1}`)) {
      result.consentPrompts++
      log('the installer asked for administrator rights (UAC); answered Yes')
    }
    status = await vm.agent({ cmd: 'installStatus', exe })
    if (shots.length && status.seconds >= shots[0]) await vm.screenshot(`i-install-${String(shots.shift()).padStart(3, '0')}s`, directory)
    if (status.done) break
    if (status.seconds > 900) throw new Error('The installer did not finish in 15 minutes')
  }
  await sleep(1500)
  status = await vm.agent({ cmd: 'installStatus', exe })
  await vm.screenshot('i-installed', directory)
  await vm.agent({ cmd: 'backdrop', show: false })
  log(`installer exit ${status.exitCode} after ${status.seconds} s (WebView2 after: ${JSON.stringify(status.webview2)})`)
  try { writeFileSync(join(directory, 'install.log'), (await vm.agent({ cmd: 'file', path: 'C:/test/out/install.log' })).text) } catch { /* evidence only */ }
  return { ...result, installerExit: status.exitCode, installSeconds: status.seconds, installed: status.installed, webview2After: status.webview2 }
}

async function runVm(name, options, client, installer, directory) {
  const vm = new Vm(name)
  const report = { vm: name, checkpoint: options.checkpoint, startedAt: new Date().toISOString(), system: null, checks: [], error: null }
  const log = (text) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${name}: ${text}`)
  try {
    if (!options.attach) {
      log(`restoring '${options.checkpoint}' and booting`)
      await vm.start(options.checkpoint)
      await vm.ssh('New-Item -ItemType Directory -Force C:\\test | Out-Null')
      await vm.upload(installer, 'C:/test/setup.exe')
      await vm.upload(join(here, 'guest', 'agent.ps1'), 'C:/test/')
      await vm.upload(join(here, 'guest', 'setup.ps1'), 'C:/test/')
      await vm.upload(join(here, 'guest', 'elevated.ps1'), 'C:/test/')
      const setup = await vm.ssh('powershell -NoProfile -ExecutionPolicy Bypass -File C:\\test\\setup.ps1', { timeout: 120_000 })
      report.system = JSON.parse(setup.stdout.trim().split(/\r?\n/).filter((line) => line.startsWith('{')).pop())
    } else {
      await vm.start()
    }
    const ping = await vm.openTunnel()
    await vm.openInput()
    log(`agent ready (session ${ping.session}, elevated ${ping.elevated})`)
    if (!options.attach) {
      Object.assign(report.system, await install(vm, client, directory, log))
      writeFileSync(join(directory, 'system.json'), JSON.stringify(report.system, null, 2))
    }

    const context = {
      vm, client, directory, log,
      process: client.exe.replace(/\.exe$/, ''),
      exePath: `%ProgramFiles%/${client.installDir}/${client.exe}`,
      system: report.system,
      soak: options.soak,
    }
    report.checks = await runChecks(context)
  } catch (error) {
    report.error = String(error?.stack ?? error)
    log(`ERROR ${error?.message ?? error}`)
  } finally {
    try {
      const agentLog = await vm.ssh('Get-Content C:\\test\\out\\agent.log -ErrorAction SilentlyContinue', { allowFailure: true })
      writeFileSync(join(directory, 'agent.log'), agentLog.stdout)
    } catch { /* evidence only */ }
    await vm.closeInput()
    vm.closeTunnel()
    if (!options.keep) {
      try { await vm.restore(options.checkpoint) } catch (error) { log(`cleanup failed: ${error.message}`) }
    } else log('left running (--keep); restore with: Vm.ps1 restore ' + name)
  }
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  return report
}

function summarize(reports, options, client, installer) {
  const ids = []
  for (const report of reports) for (const check of report.checks) if (!ids.includes(check.id)) ids.push(check.id)
  const titles = Object.fromEntries(reports.flatMap((report) => report.checks.map((check) => [check.id, check.title])))
  const mark = { pass: 'ok', fail: 'FAIL', info: 'note', skip: 'skip' }
  const column = (report) => `${report.vm}${report.checkpoint === 'clean' ? '' : ` (${report.checkpoint})`}`
  const lines = [
    `# Windows compatibility run: ${client.label}`,
    '',
    `Installer: \`${installer}\``,
    '',
    `| Check | ${reports.map(column).join(' | ')} |`,
    `|---|${reports.map(() => '---').join('|')}|`,
    `| Build | ${reports.map((report) => report.system ? `${report.system.build}` : '?').join(' | ')} |`,
    `| WebView2 before | ${reports.map((report) => Object.values(report.system?.webview2Before ?? {})[0] ?? 'none').join(' | ')} |`,
    `| WebView2 after | ${reports.map((report) => Object.values(report.system?.webview2After ?? {})[0] ?? '?').join(' | ')} |`,
  ]
  for (const id of ids) {
    lines.push(`| ${id} ${titles[id]} | ${reports.map((report) => {
      const check = report.checks.find((candidate) => candidate.id === id)
      return check ? mark[check.status] : (report.error ? 'error' : '-')
    }).join(' | ')} |`)
  }
  lines.push('')
  for (const report of reports) {
    const notable = report.checks.filter((check) => check.status !== 'pass')
    if (!notable.length && !report.error) continue
    lines.push(`## ${column(report)}`, '')
    if (report.error) lines.push('Run error:', '', '```', report.error, '```', '')
    for (const check of notable) lines.push(`- **${check.id} ${check.title}** (${mark[check.status]}): ${check.detail}`)
    lines.push('')
  }
  return lines.join('\n')
}

const options = parseArguments(process.argv.slice(2))
const client = CLIENT
const installer = client.installer()
if (!installer) throw new Error('No installer: run src-mygo-client\build-windows.ps1 first')
const out = options.out ?? join(TOOLS, 'results', stamp())
mkdirSync(out, { recursive: true })
console.log(`client: ${client.label}\ninstaller: ${installer}\nresults: ${out}`)

const reports = []
for (const name of options.vms) {
  const directory = join(out, options.checkpoint === 'clean' ? name : `${name}-${options.checkpoint}`)
  mkdirSync(directory, { recursive: true })
  let report = await runVm(name, options, client, installer, directory)
  // The VM or its network can drop out (the host sleeping, a power change): one more try.
  if (report.error && !options.attach) {
    console.log(`=== ${name}: run error, trying once more`)
    report = await runVm(name, options, client, installer, directory)
  }
  reports.push(report)
  const failed = report.checks.filter((check) => check.status === 'fail')
  console.log(`=== ${name}: ${report.error ? 'RUN ERROR, ' : ''}${report.checks.filter((check) => check.status === 'pass').length} ok, ${failed.length} failed` +
    (failed.length ? ` (${failed.map((check) => check.id).join(', ')})` : ''))
  writeFileSync(join(out, 'summary.md'), summarize(reports, options, client, installer))
  writeFileSync(join(out, 'summary.json'), JSON.stringify(reports, null, 2))
}
console.log(`\nresults: ${out}`)
process.exitCode = reports.some((report) => report.error || report.checks.some((check) => check.status === 'fail')) ? 1 : 0
