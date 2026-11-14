// A hand tool for a VM that is already running with the agent started (see run.mjs --keep):
//   node probe.mjs Win11-25H2 agent '{"cmd":"state","process":"sharecode-client-compat"}'
//   node probe.mjs Win11-25H2 input 'down:lalt down:lshift tap:t up:lshift up:lalt'
//   node probe.mjs Win11-25H2 shot look
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vm } from './lib.mjs'

const [name, action, ...rest] = process.argv.slice(2)
const vm = new Vm(name)
try {
  if (action === 'agent') {
    await vm.openTunnel()
    for (const request of rest) console.log(JSON.stringify(await vm.agent(JSON.parse(request)), null, 1))
  } else if (action === 'input' || action === 'shot') {
    await vm.openInput()
    if (action === 'input') for (const steps of rest) console.log((await vm.input(steps)).trim())
    else {
      const directory = join(tmpdir(), 'sccompat-probe')
      mkdirSync(directory, { recursive: true })
      const shot = await vm.screenshot(rest[0] ?? 'shot', directory)
      console.log(`${shot.path} ${shot.width}x${shot.height}`)
    }
  } else {
    console.error('usage: node probe.mjs <vm> agent <json>... | input <steps>... | shot <label>')
    process.exitCode = 2
  }
} finally {
  await vm.closeInput()
  vm.closeTunnel()
}
