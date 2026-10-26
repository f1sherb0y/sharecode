import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

const version = await getVersion()
const application = await invoke('get_client_application')
const label = getCurrentWindow().label
document.getElementById('version').textContent = `版本 ${version} · ${label} · 仅连接 127.0.0.1`
document.getElementById('path').textContent = application.path
const action = (id, run) => { document.getElementById(id).onclick = () => Promise.resolve().then(run).catch(e => {
  document.getElementById('error').textContent = String(e)
}) }
action('input', () => invoke('open_client_hotkey_settings'))
action('recording', () => invoke('open_client_recording_settings'))
action('main', () => invoke('show_client_main'))
action('update', async () => {
  const update = await check()
  if (!update) throw new Error('本机没有更新')
  await update.downloadAndInstall()
  await relaunch()
})
if (label !== 'main') document.getElementById('update').disabled = true
let pending = false
setInterval(async () => {
  if (pending) return
  pending = true
  try {
    const hotkey = await invoke('get_client_hotkey_status')
    const recording = await invoke('client_screen_share', { action: 'status', language: 'zh' })
    const sample = { version, label, application, hotkey, recording, timestamp: Date.now() }
    document.getElementById('status').textContent = JSON.stringify(sample, null, 2)
    await fetch('http://127.0.0.1:18766/sample', { method: 'POST', body: JSON.stringify(sample) })
  } catch (e) { document.getElementById('error').textContent = String(e) }
  finally { pending = false }
}, 1000)
