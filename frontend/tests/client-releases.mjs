// Disposable localhost database/API only; see scripts/test-runner-local.sh, which starts the API
// with CLIENT_UPDATER_PUBKEY set to the throwaway key that signed the payloads below.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'

const API = 'http://127.0.0.1:55460'
const WEB = 'http://127.0.0.1:55461'
const password = 'LocalAudit#2026Strong'

// `tauri signer sign` output (the .sig files' content) for each payload.
const WINDOWS_020 = 'ShareCode test installer 0.2.0 windows-x86_64\n'
const WINDOWS_020_SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRc1pPOHhlc05QdU5wYzBsMW13R2JZN29zZjZYbElWcmJ3NU54TU00WmRnUUd1WHVMK3ZURUpCank5aUYrVkRjWU1HL0JiWDZndUc3UHJvSUVBaytoM0F2MW85Rmt4UEFnPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyODM5ODY2CWZpbGU6d2luLTAuMi4wLmJpbgo3Ymw5TEdCM3lHZWN0YmE3bEhlMEM0M3IrcHJYbGFRWEJST1VLMVBJMTBjdlprL1VPN3hvUGVuVnp1V05iN1cwdDdPakNGbWZuZEl5YkdicXRUQnpEUT09Cg=='
const MAC_UPDATE_020 = 'ShareCode test update 0.2.0 darwin-aarch64\n'
const MAC_UPDATE_020_SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRc1pPOHhlc05QdUcxcVhDU0orSU13V1ljMHFjL2xPaFFlTUpxTTZPU2tyM011eW4wcjJCWVg3elN6Z2pyY0hjK2FjQVg1ajQ5UkRjeUlTbG9kMFNwTUp5am1XQ2lQelFNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyODM5ODY2CWZpbGU6bWFjLTAuMi4wLmJpbgpZZmlVajlUVkZUeVdiUlJpYlpqNEdFR1hMNUxIOW5sTW1Xdk9TN0EydE9aOEM0L2IwY0hqQkxLcW5XSE1zblNZek9LeFp1aUk1ZWE5T1dNMmZUalJEZz09Cg=='
const WINDOWS_030 = 'ShareCode test installer 0.3.0 windows-x86_64\n'
const WINDOWS_030_SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRc1pPOHhlc05QdUcxWWNzaDJndVFndngwWEgvV1Zhc3kvYUpzTTkvVm9UQ1hqR0wxa0lNNjBRYXQyRjd0cDc1bFJwaTBldXY0dWR1MERIcE5pNUxMLzlOS1RPODVmTVFVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyODM5ODY2CWZpbGU6d2luLTAuMy4wLmJpbgpUZ1ptKzNuaEUwMEU4VGIvVXRHTDNuTCtWUXdITnNDbC83YkU5MjI4d0hVRkJqZWNXaU5SeVJYUGRZaUJxcGRVVVdTVlQwd0lMWEpLbVcrenU3YTZCdz09Cg=='

async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
  const isForm = body instanceof FormData
  const response = await fetch(API + path, {
    method,
    headers: {
      ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body && !isForm ? JSON.stringify(body) : body,
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* empty or binary */ }
  return { status: response.status, headers: response.headers, text, body: json }
}
async function ok(path, options) {
  const result = await request(path, options)
  assert.ok(result.status < 300, `${options?.method ?? 'GET'} ${path}: ${result.status} ${result.text}`)
  return result.body
}

const admin = (await ok('/api/auth/login', { method: 'POST', body: { username: 'audit_admin', password } })).token
await ok('/api/admin/users', { method: 'POST', token: admin, body: { username: 'release_tech', role: 'tech', password } })
const tech = (await ok('/api/auth/login', { method: 'POST', body: { username: 'release_tech', password } })).token

function upload(releaseId, { platform, kind, name, content, signature }, token = admin) {
  const form = new FormData()
  form.append('platform', platform)
  form.append('kind', kind)
  if (signature) form.append('signature', signature)
  form.append('file', new Blob([content]), name)
  return request(`/api/admin/client-releases/${releaseId}/assets`, { method: 'POST', token, body: form })
}
const latest = async () => (await ok('/api/client/releases/latest')).downloads
const updateFor = (target, arch, version) => request(`/api/client/update/${target}/${arch}/${version}`)
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

// Nothing is offered before a release is published.
assert.deepEqual(await latest(), [])
assert.equal((await updateFor('windows', 'x86_64', '0.1.0')).status, 204)

// Admins only, like the rest of the admin API.
assert.equal((await request('/api/admin/client-releases', { token: tech })).status, 404)
assert.equal((await request('/api/admin/client-releases', { method: 'POST', token: tech, body: { version: '9.9.9' } })).status, 404)
assert.equal((await request('/api/admin/client-releases')).status, 401)

// Drafts: semantic versions, one release per version.
assert.equal((await request('/api/admin/client-releases', { method: 'POST', token: admin, body: { version: 'v0.2' } })).status, 400)
const v020 = (await ok('/api/admin/client-releases', { method: 'POST', token: admin, body: { version: ' 0.2.0 ', notes: 'First signed release' } })).release
assert.equal(v020.version, '0.2.0')
assert.equal(v020.publishedAt, null)
assert.equal((await request('/api/admin/client-releases', { method: 'POST', token: admin, body: { version: '0.2.0' } })).status, 409)

// Uploads are checked: file type, signature format, signature against the file, update bundles signed.
const windowsName = 'ShareCode Client_0.2.0_x64-setup.exe'
let rejected = await upload(v020.id, { platform: 'windows-x86_64', kind: 'installer', name: `${windowsName}.sig`, content: WINDOWS_020_SIG })
assert.equal(rejected.status, 400)
assert.match(rejected.body.error, /installer or update bundle/)
rejected = await upload(v020.id, { platform: 'windows-x86_64', kind: 'installer', name: windowsName, content: WINDOWS_020, signature: 'not a signature' })
assert.equal(rejected.body.error, 'The signature must be the content of the .sig file')
rejected = await upload(v020.id, { platform: 'windows-x86_64', kind: 'installer', name: windowsName, content: WINDOWS_020 + 'tampered', signature: WINDOWS_020_SIG })
assert.equal(rejected.status, 400)
assert.match(rejected.body.error, /does not match this file/)
rejected = await upload(v020.id, { platform: 'darwin-aarch64', kind: 'update', name: 'ShareCode Client.app.tar.gz', content: MAC_UPDATE_020 })
assert.equal(rejected.body.error, 'Update bundles need their signature (.sig)')
rejected = await upload(v020.id, { platform: 'windows-ia64', kind: 'installer', name: windowsName, content: WINDOWS_020 })
assert.equal(rejected.body.error, 'Unknown platform')
rejected = await upload(v020.id, { platform: 'windows-x86_64', kind: 'installer', name: windowsName, content: '' })
assert.equal(rejected.body.error, 'The file is empty')

// A first unsigned Windows upload is replaced by the signed one (one file per platform and kind).
const unsigned = (await upload(v020.id, { platform: 'windows-x86_64', kind: 'installer', name: windowsName, content: WINDOWS_020 })).body.asset
assert.equal(unsigned.signed, false)
const windows = (await upload(v020.id, { platform: 'windows-x86_64', kind: 'installer', name: windowsName, content: WINDOWS_020, signature: `${WINDOWS_020_SIG}\n` })).body.asset
assert.equal(windows.signed, true)
assert.equal(windows.size, Buffer.byteLength(WINDOWS_020))
assert.equal(windows.sha256, sha256(WINDOWS_020))
assert.equal(windows.downloadUrl, `/api/client/downloads/${windows.id}/ShareCode%20Client_0.2.0_x64-setup.exe`)
const macUpdate = (await upload(v020.id, { platform: 'darwin-aarch64', kind: 'update', name: 'ShareCode Client.app.tar.gz', content: MAC_UPDATE_020, signature: MAC_UPDATE_020_SIG })).body.asset
const dmg = 'macOS installer image (unsigned, not an update)'
await ok(`/api/admin/client-releases/${v020.id}/assets`, { method: 'POST', token: admin, body: (() => {
  const form = new FormData()
  form.append('platform', 'darwin-aarch64')
  form.append('kind', 'installer')
  form.append('file', new Blob([dmg]), 'ShareCode Client_0.2.0_aarch64.dmg')
  return form
})() })
let listed = (await ok('/api/admin/client-releases', { token: admin })).releases
assert.deepEqual(listed[0].assets.map((asset) => `${asset.platform}:${asset.kind}:${asset.signed}`).sort(),
  ['darwin-aarch64:installer:false', 'darwin-aarch64:update:true', 'windows-x86_64:installer:true'])
assert.equal(listed[0].createdBy, 'audit_admin')

// Drafts stay private.
assert.deepEqual(await latest(), [])
assert.equal((await updateFor('windows', 'x86_64', '0.1.0')).status, 204)
assert.equal((await request(windows.downloadUrl)).status, 404)
assert.equal((await request(`/api/client/downloads/${unsigned.id}/${encodeURIComponent(windowsName)}`)).status, 404)

// Publishing needs an installer.
const empty = (await ok('/api/admin/client-releases', { method: 'POST', token: admin, body: { version: '0.1.5' } })).release
assert.equal((await request(`/api/admin/client-releases/${empty.id}`, { method: 'PATCH', token: admin, body: { published: true } })).body.error,
  'Upload at least one installer before publishing')
await ok(`/api/admin/client-releases/${empty.id}`, { method: 'DELETE', token: admin })

const published = (await ok(`/api/admin/client-releases/${v020.id}`, { method: 'PATCH', token: admin, body: { published: true } })).release
assert.ok(published.publishedAt)

// The download button gets each platform's installer.
assert.deepEqual((await latest()).map(({ platform, version, fileName, size, sha256, url }) => ({ platform, version, fileName, size, sha256, url })), [
  { platform: 'windows-x86_64', version: '0.2.0', fileName: windowsName, size: windows.size, sha256: windows.sha256, url: windows.downloadUrl },
  { platform: 'darwin-aarch64', version: '0.2.0', fileName: 'ShareCode Client_0.2.0_aarch64.dmg', size: Buffer.byteLength(dmg), sha256: sha256(dmg), url: listed[0].assets.find((a) => a.kind === 'installer' && a.platform === 'darwin-aarch64').downloadUrl },
])

// The updater (Tauri dynamic update server format): absolute URL on a configured origin, signature, 204 when current.
let check = await updateFor('windows', 'x86_64', '0.1.0')
assert.equal(check.status, 200)
assert.equal(check.headers.get('cache-control'), 'no-store')
assert.deepEqual({ ...check.body, pub_date: undefined }, {
  version: '0.2.0', notes: 'First signed release', pub_date: undefined, url: `${WEB}${windows.downloadUrl}`, signature: WINDOWS_020_SIG,
})
assert.ok(!Number.isNaN(Date.parse(check.body.pub_date)))
assert.equal((await updateFor('windows', 'x86_64', '0.2.0')).status, 204)
assert.equal((await updateFor('windows', 'x86_64', '0.3.0')).status, 204)
assert.equal((await updateFor('windows', 'x86_64', '0.2.0-beta.1')).status, 200)
assert.equal((await updateFor('windows', 'x86_64', 'garbage')).status, 204)
assert.equal((await updateFor('windows', 'aarch64', '0.1.0')).status, 204)
assert.equal((await updateFor('linux', 'x86_64', '0.1.0')).status, 204)
assert.equal((await updateFor('beos', 'x86_64', '0.1.0')).status, 204)
// macOS updates come from the .app.tar.gz, never the .dmg.
check = await updateFor('darwin', 'aarch64', '0.1.0')
assert.equal(check.body.url, `${WEB}${macUpdate.downloadUrl}`)
assert.equal(check.body.signature, MAC_UPDATE_020_SIG)

// Downloads: the file, named, cacheable for good, resumable; the name in the URL must match.
let download = await request(windows.downloadUrl)
assert.equal(download.status, 200)
assert.equal(download.text, WINDOWS_020)
assert.equal(download.headers.get('content-type'), 'application/octet-stream')
assert.equal(download.headers.get('content-disposition'),
  `attachment; filename="${windowsName}"; filename*=UTF-8''ShareCode%20Client_0.2.0_x64-setup.exe`)
assert.equal(download.headers.get('cache-control'), 'public, max-age=31536000, immutable')
download = await request(windows.downloadUrl, { headers: { Range: 'bytes=0-8' } })
assert.equal(download.status, 206)
assert.equal(download.text, WINDOWS_020.slice(0, 9))
assert.equal(download.headers.get('content-range'), `bytes 0-8/${windows.size}`)
download = await request(windows.downloadUrl, { method: 'HEAD' })
assert.equal(download.status, 200)
assert.equal(download.headers.get('content-length'), String(windows.size))
assert.equal((await request(`/api/client/downloads/${windows.id}/other.exe`)).status, 404)

// Published releases are frozen apart from their notes.
assert.equal((await upload(v020.id, { platform: 'linux-x86_64', kind: 'installer', name: 'a.AppImage', content: 'x' })).status, 409)
assert.equal((await request(`/api/admin/client-releases/${v020.id}/assets/${windows.id}`, { method: 'DELETE', token: admin })).status, 409)
assert.equal((await request(`/api/admin/client-releases/${v020.id}`, { method: 'DELETE', token: admin })).status, 409)
assert.equal((await ok(`/api/admin/client-releases/${v020.id}`, { method: 'PATCH', token: admin, body: { notes: 'Signed release' } })).release.notes, 'Signed release')

// A newer release takes over where it has files; older ones still serve the other platforms.
const v030 = (await ok('/api/admin/client-releases', { method: 'POST', token: admin, body: { version: '0.3.0' } })).release
const windows030 = (await upload(v030.id, { platform: 'windows-x86_64', kind: 'installer', name: 'ShareCode Client_0.3.0_x64-setup.exe', content: WINDOWS_030, signature: WINDOWS_030_SIG })).body.asset
await ok(`/api/admin/client-releases/${v030.id}`, { method: 'PATCH', token: admin, body: { published: true } })
assert.deepEqual((await latest()).map((d) => `${d.platform}@${d.version}`), ['windows-x86_64@0.3.0', 'darwin-aarch64@0.2.0'])
assert.equal((await updateFor('windows', 'x86_64', '0.2.0')).body.version, '0.3.0')
assert.equal((await updateFor('darwin', 'aarch64', '0.1.0')).body.version, '0.2.0')
listed = (await ok('/api/admin/client-releases', { token: admin })).releases
assert.deepEqual(listed.map((release) => release.version), ['0.3.0', '0.2.0'])

// Withdrawing it puts the previous release back; deleting removes its files.
await ok(`/api/admin/client-releases/${v030.id}`, { method: 'PATCH', token: admin, body: { published: false } })
assert.equal((await updateFor('windows', 'x86_64', '0.1.0')).body.version, '0.2.0')
assert.equal((await updateFor('windows', 'x86_64', '0.2.0')).status, 204)
assert.equal((await request(windows030.downloadUrl)).status, 404)
await ok(`/api/admin/client-releases/${v030.id}`, { method: 'DELETE', token: admin })
assert.equal((await ok('/api/admin/client-releases', { token: admin })).releases.length, 1)

// The release workflow's token opens a draft (again on a rerun) and uploads signed files to it,
// and does nothing else: no published version, no listing, publishing or deleting.
const CI = 'ci-test-token-not-a-secret'
const openDraft = (version, token = CI, body = {}) => request(`/api/ci/client-releases/${version}`, { method: 'PUT', token, body })
const opened = await openDraft('0.4.0', CI, { notes: 'Built by CI' })
assert.equal(opened.status, 201, opened.text)
assert.deepEqual([opened.body.release.version, opened.body.release.notes, opened.body.release.createdBy, opened.body.release.publishedAt], ['0.4.0', 'Built by CI', null, null])
const reopened = await openDraft('0.4.0', CI, { notes: 'Rerun' })
assert.deepEqual([reopened.status, reopened.body.release.id, reopened.body.release.notes], [200, opened.body.release.id, 'Built by CI'])
for (const [version, token, status] of [['0.2.0', CI, 409], ['v0.4', CI, 400], ['0.4.0', 'wrong-token', 401], ['0.4.0', '', 401], ['0.4.0', admin, 401]]) {
  assert.equal((await openDraft(version, token)).status, status, `${version} ${status}`)
}
const ciDraft = opened.body.release.id
const ciFile = { platform: 'windows-x86_64', kind: 'installer', name: 'ShareCode Client_0.4.0_x64-setup.exe', content: WINDOWS_030, signature: WINDOWS_030_SIG }
const ciAsset = await upload(ciDraft, ciFile, CI)
assert.equal(ciAsset.status, 201, ciAsset.text)
assert.equal(ciAsset.body.asset.signed, true)
assert.equal((await upload(ciDraft, { ...ciFile, signature: MAC_UPDATE_020_SIG }, CI)).status, 400)
assert.equal((await upload(ciDraft, { ...ciFile, kind: 'update', signature: undefined }, CI)).status, 400)
assert.equal((await upload(v020.id, ciFile, CI)).status, 409)
assert.equal((await upload(ciDraft, ciFile, 'wrong-token')).status, 401)
for (const [path, method, body] of [
  ['/api/admin/client-releases', 'GET'], ['/api/admin/client-releases', 'POST', { version: '0.5.0' }],
  [`/api/admin/client-releases/${ciDraft}`, 'PATCH', { published: true }], [`/api/admin/client-releases/${ciDraft}`, 'DELETE'],
  [`/api/admin/client-releases/${ciDraft}/assets/${ciAsset.body.asset.id}`, 'DELETE'], ['/api/admin/audit', 'GET'],
]) assert.equal((await request(path, { method, body, token: CI })).status, 401, `${method} ${path}`)
assert.equal((await updateFor('windows', 'x86_64', '0.2.0')).status, 204, 'a CI draft is not offered')
const ciListed = (await ok('/api/admin/client-releases', { token: admin })).releases.find((release) => release.id === ciDraft)
assert.deepEqual([ciListed.createdBy, ciListed.assets.length], [null, 1])
const ciEvents = (await ok('/api/admin/audit?pageSize=100', { token: admin })).events.filter((event) => event.targetId === ciDraft)
assert.deepEqual(ciEvents.map((event) => [event.action, event.username, event.actorId ?? null]).reverse(),
  [['client_release.created', 'CI workflow', null], ['client_release.asset_uploaded', 'CI workflow', null]])
await ok(`/api/admin/client-releases/${ciDraft}`, { method: 'DELETE', token: admin })
assert.equal((await ok('/api/admin/client-releases', { token: admin })).releases.length, 1)

// Every change is audited.
const actions = (await ok('/api/admin/audit?pageSize=100', { token: admin })).events.map((event) => event.action)
for (const action of ['client_release.created', 'client_release.asset_uploaded', 'client_release.published', 'client_release.notes_updated', 'client_release.unpublished', 'client_release.deleted']) {
  assert.ok(actions.includes(action), action)
}
console.log('PASS client release API: drafts, signature checks, publishing, latest downloads, updater responses, ranged downloads, freezing, rollback, CI drafts and uploads only, and audit')

// ----- Browser: publishing from the admin page, and the download button -----
const fixtures = mkdtempSync(join(tmpdir(), 'sharecode-client-release-'))
const setupName = 'ShareCode Client_0.4.0_x64-setup.exe'
writeFileSync(join(fixtures, setupName), WINDOWS_030)
writeFileSync(join(fixtures, `${setupName}.sig`), WINDOWS_030_SIG)

const web = await createServer({ server: { host: '127.0.0.1', port: 55461, strictPort: true, proxy: { '/api': { target: API, changeOrigin: true, ws: true } } }, logLevel: 'error' })
await web.listen()
try {
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript((token) => {
      sessionStorage.setItem('sharecode-tab-auth', JSON.stringify({ state: { token }, version: 0 }))
      localStorage.setItem('i18nextLng', 'en')
    }, admin)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${WEB}/admin?section=releases`)
    await page.getByRole('heading', { name: 'v0.2.0' }).waitFor()

    await page.getByRole('button', { name: 'New version' }).click()
    await page.getByRole('textbox', { name: 'Version', exact: true }).fill('0.4.0')
    await page.getByRole('dialog').getByRole('button', { name: 'New version' }).click()
    const card = page.locator('section', { has: page.getByRole('heading', { name: 'v0.4.0' }) })
    await card.waitFor()
    assert.equal(await card.getByText('Draft', { exact: true }).count(), 1)
    assert.equal(await card.getByRole('button', { name: 'Publish' }).isDisabled(), true)

    // The .sig pairs with its file, and the bundler's file name gives the platform and kind.
    await card.locator('input[type=file]').setInputFiles([join(fixtures, setupName), join(fixtures, `${setupName}.sig`)])
    await card.getByText(`Signature: ${setupName}.sig`).waitFor()
    assert.equal(await card.getByRole('combobox', { name: 'System' }).textContent(), 'Windows · x64')
    assert.equal(await card.getByRole('combobox', { name: 'Type' }).textContent(), 'Installer')
    await card.getByRole('button', { name: 'Upload', exact: true }).click()
    await card.getByRole('cell', { name: setupName, exact: true }).waitFor()
    assert.equal(await card.getByRole('cell', { name: 'Signed', exact: true }).count(), 1)

    await card.getByRole('button', { name: 'Publish' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click()
    await card.getByText(/^Published /).waitFor()
    assert.equal((await updateFor('windows', 'x86_64', '0.2.0')).body.version, '0.4.0')
    assert.deepEqual(errors, [])
    await context.close()
  } finally {
    await browser.close()
  }

  // The button follows the visitor's system: client hints in Chromium, the user agent elsewhere.
  // Every case names its system, so the result does not depend on the machine running the test.
  const windowsChrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
  const windowsHints = { platform: 'Windows', architecture: 'x86' }
  const macSafari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
  const linuxFirefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  const cases = [
    { name: 'Windows (client hints)', type: chromium, path: '/login', userAgent: windowsChrome, hints: windowsHints, button: 'Download the desktop client for Windows', details: 'x64 · version 0.4.0', file: setupName, content: WINDOWS_030 },
    { name: 'Apple silicon Mac (client hints)', type: chromium, path: '/join', hints: { platform: 'macOS', architecture: 'arm' }, button: 'Download the desktop client for macOS', details: 'Apple silicon · version 0.2.0', file: 'ShareCode Client_0.2.0_aarch64.dmg', content: dmg },
    { name: 'Mac Safari (user agent)', type: webkit, path: '/login', userAgent: macSafari, button: 'Download the desktop client for macOS', details: 'Apple silicon · version 0.2.0' },
    { name: 'Linux (nothing published)', type: firefox, path: '/login', userAgent: linuxFirefox, menu: 'Download the desktop client' },
    { name: 'Chinese', type: chromium, path: '/login', locale: 'zh', userAgent: windowsChrome, hints: windowsHints, button: '下载 Windows 桌面客户端', details: 'x64 · 版本 0.4.0' },
    { name: 'phone', type: webkit, path: '/login', userAgent: iphone, hidden: true },
  ]
  for (const item of cases) {
    const browser = await item.type.launch()
    try {
      const context = await browser.newContext({ acceptDownloads: true, ...(item.userAgent ? { userAgent: item.userAgent } : {}) })
      await context.addInitScript(({ locale, hints }) => {
        localStorage.setItem('i18nextLng', locale)
        if (hints) {
          Object.defineProperty(navigator, 'userAgentData', {
            value: { mobile: false, platform: hints.platform, getHighEntropyValues: async () => ({ architecture: hints.architecture }) },
          })
        }
      }, { locale: item.locale ?? 'en', hints: item.hints })
      const page = await context.newPage()
      await page.goto(`${WEB}${item.path}`)
      await page.waitForLoadState('networkidle')
      const section = page.getByRole('region', { name: item.locale === 'zh' ? '桌面客户端' : 'Desktop client' })
      if (item.hidden) {
        assert.equal(await section.count(), 0, item.name)
        continue
      }
      if (item.menu) {
        await section.getByRole('button', { name: item.menu }).click()
        assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Windows · x64 · 0.4.0', 'macOS · Apple silicon · 0.2.0'], item.name)
        continue
      }
      const link = section.getByRole('link', { name: item.button })
      await link.waitFor()
      assert.ok((await section.textContent()).includes(item.details), `${item.name}: ${await section.textContent()}`)
      if (item.file) {
        const [file] = await Promise.all([page.waitForEvent('download'), link.click()])
        assert.equal(file.suggestedFilename(), item.file, item.name)
        const stream = await file.createReadStream()
        let body = ''
        for await (const chunk of stream) body += chunk
        assert.equal(body, item.content, item.name)
      }
    } finally {
      await browser.close()
    }
  }
  console.log('PASS admin publishing page and download button (client hints, user agents, fallback menu, Chinese, phones)')
} finally {
  await web.close()
}
