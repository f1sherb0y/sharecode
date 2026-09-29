// Run via scripts/test-runner-local.sh: only its disposable database/API are used.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import * as Y from 'yjs'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'

const API = 'http://127.0.0.1:55460'
const password = 'LocalAudit#2026Strong'
const container = process.env.SHARECODE_TEST_CONTAINER
assert(container?.startsWith('sharecode-runner-test-'), 'Use the disposable test runner')
const sql = statement => execFileSync('docker', ['exec', container, 'psql', '-U', 'runner_test', '-d', 'runner_test', '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8' }).trim()
const literal = value => `'${String(value).replaceAll("'", "''")}'`
async function request(path, method = 'GET', body, token, expected = 200) {
  const response = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json()
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`)
  return data
}
const login = username => request('/api/auth/login', 'POST', { username, password })
const actors = { root: await login('audit_admin') }
for (const [username, role, flags] of [
  ['owner', 'admin', {}], ['reader', 'user', {}], ['writer', 'user', {}], ['outsider', 'user', {}],
  ['manager', 'admin', { canReadAllRooms: true, canWriteAllRooms: false, canDeleteAllRooms: false }],
  ['limited_admin', 'admin', { canReadAllRooms: false, canWriteAllRooms: false, canDeleteAllRooms: false }],
  ['global_reader', 'user', { canReadAllRooms: true }], ['global_writer', 'user', { canWriteAllRooms: true }],
  ['global_delete', 'user', { canDeleteAllRooms: true }],
]) {
  await request('/api/admin/users', 'POST', { username, role, password, ...flags }, actors.root.token, 201)
  actors[username] = await login(username)
}
const create = async (name, owner = 'owner', extra = {}) => (await request('/api/rooms', 'POST', { name, language: 'python', ...extra }, actors[owner].token, 201)).room
const share = async (room, canEdit, actor, owner = 'owner') => {
  const link = (await request(`/api/rooms/${room.id}/share-links`, 'POST', { canEdit }, actors[owner].token, 201)).shareLink
  if (actor) await request(`/api/share/${link.token}/accept`, 'POST', {}, actors[actor].token)
  return link
}
const guest = async (room, canEdit, owner = 'owner') => {
  const link = await share(room, canEdit, null, owner)
  return { link, ...await request(`/api/share/${link.token}/join`, 'POST', { username: 'Shared guest' }, undefined, 201) }
}
const path = room => `/api/rooms/${room.id}/notes`
const add = async (room, token, text) => (await request(path(room), 'POST', { text }, token, 201)).note
async function readOnly(room, token, note) {
  assert((await request(path(room), 'GET', undefined, token)).notes.some(n => n.id === note.id))
  await request(path(room), 'POST', { text: 'blocked' }, token, 404)
  await request(`${path(room)}/${note.id}`, 'PUT', { text: 'blocked' }, token, 404)
  await request(`${path(room)}/${note.id}`, 'DELETE', undefined, token, 404)
}
async function denied(room, token, note, status = 404) {
  await request(path(room), 'GET', undefined, token, status)
  await request(path(room), 'POST', { text: 'blocked' }, token, status)
  await request(`${path(room)}/${note.id}`, 'PUT', { text: 'blocked' }, token, status)
  await request(`${path(room)}/${note.id}`, 'DELETE', undefined, token, status)
}
async function writable(room, token) {
  const note = await add(room, token, 'Created note')
  assert.equal((await request(`${path(room)}/${note.id}`, 'PUT', { text: 'Updated note' }, token)).note.text, 'Updated note')
  await request(`${path(room)}/${note.id}`, 'DELETE', undefined, token)
  assert(!(await request(path(room), 'GET', undefined, token)).notes.some(n => n.id === note.id))
}

const room = await create('Readable session export')
const note = await add(room, actors.owner.token, 'Original note retained in export')
const readerLink = await share(room, false, 'reader')
await share(room, true, 'writer')
for (const name of ['root', 'owner', 'writer', 'global_writer', 'global_delete']) await writable(room, actors[name].token)
for (const name of ['reader', 'manager', 'global_reader']) await readOnly(room, actors[name].token, note)
for (const name of ['outsider', 'limited_admin']) await denied(room, actors[name].token, note)
for (const name of ['owner', 'writer', 'reader', 'manager', 'global_writer', 'global_reader']) {
  const detail = (await request(`/api/rooms/${room.id}`, 'GET', undefined, actors[name].token)).room
  assert.equal(detail.canReadNotes, true)
  assert.equal(detail.canWriteNotes, detail.canEdit)
}
const guestReader = await guest(room, false), guestWriter = await guest(room, true)
await readOnly(room, guestReader.token, note)
await writable(room, guestWriter.token)
await denied(room, undefined, note, 401)
const claims = JSON.parse(Buffer.from(guestWriter.token.split('.')[1], 'base64url'))
const signGuest = changes => {
  const payload = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString('base64url')
  const input = `${guestWriter.token.split('.')[0]}.${payload}`
  return `${input}.${createHmac('sha256', 'local-runner-test-key-not-production').update(input).digest('base64url')}`
}
await denied(room, signGuest({ exp: 1 }), note, 401)
await denied(room, signGuest({ sessionToken: 'wrong-session' }), note)
await denied(room, signGuest({ shareLinkId: guestReader.link.id }), note)
await denied(room, signGuest({ roomId: 'wrong-room' }), note)
console.log('PASS account/guest note CRUD, readonly readers, unauthenticated and invalid guest sessions')

const direct = await create('Direct memberships', 'owner', { allowedUsers: [
  { userId: actors.reader.user.id, canEdit: false }, { userId: actors.writer.user.id, canEdit: true },
] })
const directNote = await add(direct, actors.owner.token, 'Direct membership note')
await readOnly(direct, actors.reader.token, directNote)
await writable(direct, actors.writer.token)
await denied(direct, guestWriter.token, directNote)
await request(`${path(direct)}/${note.id}`, 'PUT', { text: 'wrong room' }, actors.owner.token, 404)
await request(`${path(direct)}/${note.id}`, 'DELETE', undefined, actors.owner.token, 404)
const privateRoom = await create('Private notes', 'writer', { isPrivate: true })
const privateNote = await add(privateRoom, actors.writer.token, 'Private note')
await readOnly(privateRoom, actors.limited_admin.token, privateNote)
await denied(privateRoom, actors.global_writer.token, privateNote)
await share(privateRoom, false, 'reader', 'writer')
await readOnly(privateRoom, actors.reader.token, privateNote)
const privateGuest = await guest(privateRoom, true, 'writer')
await writable(privateRoom, privateGuest.token)
const narrowed = await create('Explicit readonly grant')
const narrowedNote = await add(narrowed, actors.owner.token, 'Keep readonly')
await share(narrowed, false, 'global_writer')
await readOnly(narrowed, actors.global_writer.token, narrowedNote)
// Current DB grants, rather than stale JWT claims, control subsequent calls.
await request(`/api/admin/users/${actors.global_delete.user.id}`, 'PATCH', { canDeleteAllRooms: false, canWriteAllRooms: false, canReadAllRooms: true }, actors.root.token)
await readOnly(room, actors.global_delete.token, note)
const locked = await create('Guest editing disabled')
const lockedNote = await add(locked, actors.owner.token, 'Guest cannot change this')
const lockedGuest = await guest(locked, true)
sql(`UPDATE "Room" SET "allowEdit"=false WHERE id=${literal(locked.id)}`)
await readOnly(locked, lockedGuest.token, lockedNote)
console.log('PASS direct/private membership, role visibility, cross-room isolation, readonly overrides and live grant changes')

// Seed a real CRDT history in the disposable DB; exported content is reconstructed below.
const doc = new Y.Doc()
doc.getText('codemirror').insert(0, 'print("Session export content")')
sql(`INSERT INTO "DocumentUpdate" (id,"documentId",update,"userId") VALUES (${literal(randomUUID())},${literal(room.id)},decode(${literal(Buffer.from(Y.encodeStateAsUpdate(doc)).toString('hex'))},'hex'),${literal(actors.owner.user.id)})`)
doc.destroy()
await request(`/api/rooms/${room.id}/end`, 'POST', {}, actors.owner.token)
for (const name of ['root', 'owner', 'reader', 'writer', 'manager', 'global_reader']) {
  await readOnly(room, actors[name].token, note)
  assert((await request(`/api/rooms/${room.id}/playback/updates`, 'GET', undefined, actors[name].token)).updates.length)
}
for (const token of [guestReader.token, guestWriter.token, actors.outsider.token]) await denied(room, token, note)
await request(`/api/rooms/${direct.id}/end`, 'POST', {}, actors.owner.token)
for (const name of ['reader', 'writer']) await denied(direct, actors[name].token, directNote)
await request(`/api/rooms/${privateRoom.id}/end`, 'POST', {}, actors.writer.token)
await denied(privateRoom, actors.reader.token, privateNote)
await denied(privateRoom, privateGuest.token, privateNote)
await readOnly(privateRoom, actors.limited_admin.token, privateNote)
const revokedGuest = await guest(narrowed, true)
await request(`/api/rooms/${narrowed.id}/share-links/${revokedGuest.link.id}`, 'DELETE', undefined, actors.owner.token)
await denied(narrowed, revokedGuest.token, narrowedNote)
await request(`/api/rooms/${privateRoom.id}`, 'DELETE', undefined, actors.root.token)
await denied(privateRoom, actors.root.token, privateNote)
const auditActions = sql(`SELECT DISTINCT action FROM "AuditEvent" WHERE "actorId"=${literal(guestWriter.guest.id)} ORDER BY action`).split('\n')
assert.deepEqual(auditActions.filter(a => a.startsWith('note.')), ['note.created', 'note.deleted', 'note.updated'])
console.log('PASS ended/deleted room and revoked share restrictions; guest note audit trail')

const uiRoom = await create('Active note controls')
await share(uiRoom, false, 'reader')
await share(uiRoom, true, 'writer')
const uiGuest = await guest(uiRoom, false)
await add(uiRoom, actors.owner.token, 'Visible note for every room reader')
const artifacts = await mkdtemp(join(tmpdir(), 'sharecode-notes-'))
const web = await createServer({ server: { host: '127.0.0.1', port: 55461, strictPort: true, proxy: { '/api': { target: API, changeOrigin: true, ws: true } } }, logLevel: 'error' })
await web.listen()
try {
  for (const [engine, type] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await type.launch()
    try {
      for (const actor of [actors.reader, actors.manager, actors.writer, uiGuest]) {
        const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } })
        try {
          await context.addInitScript(token => {
            sessionStorage.setItem('sharecode-tab-auth', JSON.stringify({ state: { token }, version: 0 }))
            localStorage.setItem('i18nextLng', 'en')
          }, actor.token)
          const page = await context.newPage(), errors = []
          page.setDefaultTimeout(30_000)
          page.on('pageerror', e => errors.push(e.message))
          await page.goto(`http://127.0.0.1:55461/room/${uiRoom.id}?runner=bottom`)
          await page.locator('.monaco-editor').waitFor()
          await page.getByText('Code Runner', { exact: true }).click()
          await page.getByRole('button', { name: 'Notes', exact: true }).click()
          await page.getByText('Visible note for every room reader', { exact: true }).waitFor()
          const input = page.getByPlaceholder('Type a note...')
          if (actor === actors.writer) {
            await input.waitFor()
            await input.fill(`Writer note ${engine}`)
            await page.getByRole('button', { name: 'Add', exact: true }).click()
            await page.getByText(`Writer note ${engine}`, { exact: true }).waitFor()
          } else {
            assert.equal(await input.count(), 0)
            assert.equal(await page.getByRole('button', { name: 'Edit', exact: true }).count(), 0)
            assert.equal(await page.getByRole('button', { name: 'Delete', exact: true }).count(), 0)
          }
          if (actor === actors.reader || actor === actors.manager) {
            await page.goto(`http://127.0.0.1:55461/playback/${room.id}`)
            await page.getByRole('button', { name: 'Notes', exact: true }).click()
            await page.getByText(note.text, { exact: true }).waitFor()
            assert.equal(await input.count(), 0)
            await page.goto('http://127.0.0.1:55461/rooms')
            await page.getByRole('button', { name: new RegExp(room.name) }).click()
            const downloaded = page.waitForEvent('download')
            await page.getByRole('menuitem', { name: 'Export session', exact: true }).click()
            const download = await downloaded
            assert.equal(download.suggestedFilename(), 'session-replay.html')
            const filename = join(artifacts, `${engine}-${actor.user.username}.html`)
            await download.saveAs(filename)
            const html = await readFile(filename, 'utf8')
            const session = JSON.parse(gunzipSync(Buffer.from(html.match(/id="session-data"[^>]*>([^<]+)</)[1], 'base64')))
            assert.deepEqual(session.notes, [note.text])
            const replay = new Y.Doc()
            for (const update of session.updates) Y.applyUpdate(replay, Buffer.from(update.data, 'base64'))
            assert.equal(replay.getText('codemirror').toString(), 'print("Session export content")')
            replay.destroy()
            assert(!JSON.stringify(session).includes(actors.owner.user.id))
          }
          assert.deepEqual(errors, [])
        } finally { await context.close() }
      }
      console.log(`PASS ${engine}: reader/manager/guest notes, writer controls, readable-session menu export with original content and notes`)
    } finally { await browser.close() }
  }
} finally { await web.close() }
await request(`/api/rooms/${room.id}/share-links/${readerLink.id}`, 'DELETE', undefined, actors.owner.token)
await denied(room, actors.reader.token, note)
await request(`/api/rooms/${room.id}/playback/updates`, 'GET', undefined, actors.reader.token, 404)
console.log(`PASS revoked replay grants; artifacts: ${artifacts}`)
