// Role matrix for admin (超级管理员), agent (管理) and tech (技术) accounts plus share
// guests. Run with scripts/test-runner-local.sh; all accounts and rooms are disposable.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
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
const login = name => request('/api/auth/login', 'POST', { username: name, password })
const actors = { root: await login('audit_admin') }
const root = actors.root.token
assert.equal(actors.root.user.role, 'admin')
assert.equal('canReadAllRooms' in actors.root.user, false, 'the role is the only account permission')
for (const [username, role] of [
  ['admin_peer', 'admin'], ['agent_owner', 'agent'], ['agent_peer', 'agent'], ['tech_owner', 'tech'], ['tech_peer', 'tech'],
]) {
  assert.equal((await request('/api/admin/users', 'POST', { username, role, password }, root, 201)).user.role, role)
  actors[username] = await login(username)
}
const as = name => actors[name].token
const rank = role => ({ tech: 0, agent: 1, admin: 2 })[role]
const staff = actor => rank(actor.user.role) > 0
const wait = async (predicate, label) => { for (let i = 0; i < 150; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 20)) } throw Error('Timed out: ' + label) }

const rooms = []
const create = async (actor, name, isPrivate) => {
  const room = (await request('/api/rooms', 'POST', { name, language: 'python', ...(isPrivate === undefined ? {} : { isPrivate }) }, as(actor), 201)).room
  assert.equal(room.isPrivate, isPrivate ?? false)
  return { ...room, actor }
}
// Only admins create private rooms; agents' and techs' private rooms predate that rule.
for (const actor of ['agent_owner', 'tech_owner']) {
  await request('/api/rooms', 'POST', { name: 'Not allowed', language: 'python', isPrivate: true }, as(actor), 403)
}
const legacyPrivate = async (actor, name) => {
  const room = await create(actor, name)
  sql(`UPDATE "Room" SET "isPrivate"=true WHERE id=${literal(room.id)}`)
  return { ...room, isPrivate: true }
}
for (const actor of ['root', 'admin_peer', 'agent_owner', 'agent_peer', 'tech_owner', 'tech_peer']) {
  rooms.push(actors[actor].user.role === 'admin' ? await create(actor, `${actor} private`, true) : await legacyPrivate(actor, `${actor} private`))
  rooms.push(await create(actor, `${actor} standard`))
}
// Pinning is for agents and admins; a pinned room is shared read-only with every tech.
const pinned = await create('agent_owner', 'Pinned demo')
await request(`/api/rooms/${pinned.id}/pin`, 'PUT', { isPinned: true }, as('tech_owner'), 404)
await request(`/api/rooms/${pinned.id}/pin`, 'PUT', { isPinned: true }, as('agent_peer'))
rooms.push({ ...pinned, isPinned: true })

const isOwner = (actor, room) => actor.user.id === room.ownerId
const visible = (actor, room) => isOwner(actor, room) ||
  (room.isPrivate ? rank(actor.user.role) > rank(actors[room.actor].user.role) : staff(actor) || !!room.isPinned)
const editable = (actor, room) => visible(actor, room) && (isOwner(actor, room) || staff(actor))
async function socket(room, token, allowed) {
  const doc = new Y.Doc()
  let denied = false
  const state = { closed: false }
  const provider = new HocuspocusProvider({ url: API.replace('http', 'ws') + '/api/ws', name: room.id, document: doc, token, onAuthenticationFailed: () => { denied = true }, onClose: () => { state.closed = true } })
  try {
    for (let i = 0; i < 150 && !provider.synced && !denied; i++) await new Promise(r => setTimeout(r, 20))
    assert.equal(provider.synced, allowed, `WebSocket access ${room.name}`)
    if (!allowed) assert(denied, `Expected explicit denial ${room.name}`)
    return { provider, doc, state }
  } catch (error) { provider.destroy(); doc.destroy(); throw error }
}
const close = connection => { connection.provider.destroy(); connection.doc.destroy() }
async function probe(room, token, allowed, scope) {
  const connection = await socket(room, token, allowed)
  if (allowed && scope) assert.equal(connection.provider.authorizedScope, scope, `WebSocket scope ${room.name}`)
  close(connection)
}
for (const [name, actor] of Object.entries(actors)) {
  const expected = rooms.filter(room => visible(actor, room)).map(room => room.id).sort()
  const list = await request('/api/rooms?pageSize=100', 'GET', undefined, actor.token)
  assert.deepEqual(list.rooms.map(r => r.id).sort(), expected, name)
  assert.equal(list.pagination.total, expected.length)
  // The admin dashboard is admin-only; agents see every room on the rooms page instead.
  if (actor.user.role === 'admin') {
    const adminList = await request('/api/admin/rooms?pageSize=100', 'GET', undefined, actor.token)
    assert.deepEqual(adminList.rooms.map(r => r.id).sort(), expected, `admin list ${name}`)
    assert.equal(adminList.pagination.total, expected.length)
    const filtered = await request('/api/admin/rooms?q=private&pageSize=100', 'GET', undefined, actor.token)
    assert.deepEqual(filtered.rooms.map(r => r.id).sort(), rooms.filter(r => r.isPrivate && visible(actor, r)).map(r => r.id).sort())
  } else {
    await request('/api/admin/rooms', 'GET', undefined, actor.token, 404)
  }
  for (const room of rooms) {
    if (!visible(actor, room)) { await request('/api/rooms/' + room.id, 'GET', undefined, actor.token, 404); continue }
    const detail = (await request('/api/rooms/' + room.id, 'GET', undefined, actor.token)).room
    assert.equal(detail.canEdit, editable(actor, room), `${name} edits ${room.name}`)
  }
  // Cover every role direction, same-role admins/agents and pinned rooms over WS.
  for (const room of rooms.filter(r => r.isPrivate || r.isPinned)) {
    await probe(room, actor.token, visible(actor, room), editable(actor, room) ? 'read-write' : 'readonly')
  }
}
console.log('PASS role matrix: room and admin lists, counts, filters, edit rights, REST and WebSocket; pinned rooms read-only for techs')

const techRoom = rooms.find(r => r.actor === 'tech_owner' && !r.isPrivate)
// Agents manage every room except deleting it.
await request('/api/rooms/' + techRoom.id, 'PUT', { name: 'Renamed by agent' }, as('agent_peer'))
await request('/api/rooms/' + techRoom.id, 'PUT', { language: 'java' }, as('agent_peer'))
await request('/api/rooms/' + techRoom.id + '/share-links', 'POST', { canEdit: false }, as('agent_peer'), 201)
await request('/api/rooms/' + techRoom.id + '/notes', 'POST', { text: 'Agent helps debug' }, as('agent_peer'), 201)
await request('/api/rooms/' + techRoom.id, 'DELETE', undefined, as('agent_peer'), 404)
await request('/api/admin/rooms/' + techRoom.id, 'DELETE', undefined, as('agent_peer'), 404)
// Techs manage their own rooms but never delete or pin them.
await request('/api/rooms/' + techRoom.id, 'PUT', { name: 'Renamed by owner', language: 'python' }, as('tech_owner'))
await request('/api/rooms/' + techRoom.id + '/pin', 'PUT', { isPinned: true }, as('tech_owner'), 404)
await request('/api/rooms/' + techRoom.id, 'DELETE', undefined, as('tech_owner'), 404)
// Pinned rooms are view-only for techs.
for (const [suffix, method, body] of [
  ['', 'PUT', { name: 'blocked' }], ['', 'PUT', { language: 'java' }], ['', 'DELETE'], ['/end', 'POST', {}], ['/pin', 'PUT', { isPinned: false }],
  ['/share-links', 'GET'], ['/share-links', 'POST', {}], ['/notes', 'POST', { text: 'blocked' }], ['/playback/updates', 'GET'],
]) await request('/api/rooms/' + pinned.id + suffix, method, body, as('tech_peer'), 404)
await request('/api/rooms/' + pinned.id + '/notes', 'GET', undefined, as('tech_peer'))
// Unpinning revokes pinned-only access, including open sockets; ended pinned rooms are hidden.
const pinnedViewer = await socket(pinned, as('tech_peer'), true)
assert.equal(pinnedViewer.provider.authorizedScope, 'readonly')
await request(`/api/rooms/${pinned.id}/pin`, 'PUT', { isPinned: false }, as('agent_owner'))
await wait(() => pinnedViewer.state.closed, 'unpinned socket revoked')
close(pinnedViewer)
await request('/api/rooms/' + pinned.id, 'GET', undefined, as('tech_peer'), 404)
await probe(pinned, as('tech_peer'), false)
await request(`/api/rooms/${pinned.id}/pin`, 'PUT', { isPinned: true }, as('agent_owner'))
await request('/api/rooms/' + pinned.id, 'GET', undefined, as('tech_peer'))
await request(`/api/rooms/${pinned.id}/end`, 'POST', {}, as('tech_peer'), 404)
await request(`/api/rooms/${pinned.id}/end`, 'POST', {}, as('agent_peer'))
await request('/api/rooms/' + pinned.id, 'GET', undefined, as('tech_peer'), 404)
console.log('PASS agents edit/share/pin/end every room but never delete; techs manage own rooms; pinned rooms view-only, unpin and end revoke')

const adminPrivate = rooms.find(r => r.actor === 'admin_peer' && r.isPrivate)
const rootPrivate = rooms.find(r => r.actor === 'root' && r.isPrivate)
for (const token of [root, as('agent_owner'), as('tech_peer')]) {
  for (const [suffix, method, body] of [
    ['', 'PUT', { language: 'java' }], ['', 'DELETE'], ['/end', 'POST', {}], ['/pin', 'PUT', { isPinned: true }],
    ['/share-links', 'GET'], ['/share-links', 'POST', {}], ['/notes', 'GET'], ['/notes', 'POST', { text: 'hidden' }], ['/playback/updates', 'GET'],
  ]) await request('/api/rooms/' + adminPrivate.id + suffix, method, body, token, 404)
  await request('/api/rooms/by-document/' + adminPrivate.id, 'GET', undefined, token, 404)
}
await request('/api/admin/rooms/' + rootPrivate.id, 'DELETE', undefined, as('admin_peer'), 404)
await request('/api/admin/rooms/' + rootPrivate.id + '/playback/compress', 'POST', {}, as('admin_peer'), 404)
assert.deepEqual((await request('/api/admin/storage/playback?roomIds=' + rootPrivate.id, 'GET', undefined, as('admin_peer'))).rooms, [])
for (const path of ['/api/admin/storage/db-size', '/api/admin/storage/playback']) await request(path, 'GET', undefined, as('agent_owner'), 404)
console.log('PASS private-room guards on metadata, updates, notes, invitations, lifecycle, playback and admin-only storage endpoints')

const link = async (room, token, canEdit = false) => (await request('/api/rooms/' + room.id + '/share-links', 'POST', { canEdit }, token, 201)).shareLink
const accept = (shareLink, actor, expected = 200) => request('/api/share/' + shareLink.token + '/accept', 'POST', {}, as(actor), expected)
const memberLink = await link(adminPrivate, as('admin_peer'))
await accept(memberLink, 'tech_peer')
assert.equal((await request('/api/rooms/' + adminPrivate.id, 'GET', undefined, as('tech_peer'))).room.canEdit, false)
const member = await socket(adminPrivate, as('tech_peer'), true)
assert.equal(member.provider.authorizedScope, 'readonly')
await accept(memberLink, 'tech_peer')
await accept(memberLink, 'tech_owner', 410)
// Revoking the invitation removes link-derived membership and its open socket.
await request('/api/rooms/' + adminPrivate.id + '/share-links/' + memberLink.id, 'DELETE', undefined, as('admin_peer'))
await request('/api/rooms/' + adminPrivate.id, 'GET', undefined, as('tech_peer'), 404)
await wait(() => member.state.closed, 'revoked member socket closed')
close(member)
await probe(adminPrivate, as('tech_peer'), false)
// Staff still claim an invitation that privacy requires.
await accept(await link(adminPrivate, as('admin_peer')), 'agent_peer')
await probe(adminPrivate, as('agent_peer'), true, 'read-write')
assert.equal((await request('/api/rooms/' + adminPrivate.id, 'GET', undefined, as('agent_peer'))).room.isMember, true)
await accept(await link(rootPrivate, root), 'admin_peer')
await probe(rootPrivate, as('admin_peer'), true)
const guestLink = await link(adminPrivate, as('admin_peer'))
const guest = await request('/api/share/' + guestLink.token + '/join', 'POST', { username: 'private guest' }, undefined, 201)
await probe(adminPrivate, guest.token, true)
await probe(rootPrivate, guest.token, false)
await request('/api/rooms', 'GET', undefined, guest.token, 401)
// Private rooms keep no replay for link members; higher roles still replay them.
const agentPrivate = rooms.find(r => r.actor === 'agent_owner' && r.isPrivate)
await accept(await link(agentPrivate, as('agent_owner'), true), 'tech_peer')
const endingMember = await socket(agentPrivate, as('tech_peer'), true)
assert.equal(endingMember.provider.authorizedScope, 'read-write')
const endingOwner = await socket(agentPrivate, as('agent_owner'), true)
await request('/api/rooms/' + agentPrivate.id + '/end', 'POST', {}, as('agent_owner'))
await wait(() => endingMember.state.closed, 'private member closed at end')
assert.equal(endingOwner.state.closed, false)
close(endingMember); close(endingOwner)
await request('/api/rooms/' + agentPrivate.id, 'GET', undefined, as('tech_peer'), 404)
await request('/api/rooms/' + agentPrivate.id + '/playback/updates', 'GET', undefined, as('tech_peer'), 404)
await probe(agentPrivate, as('tech_peer'), false)
await request('/api/rooms/' + agentPrivate.id + '/playback/updates', 'GET', undefined, root)
await request('/api/rooms/' + adminPrivate.id + '/end', 'POST', {}, as('admin_peer'))
await probe(adminPrivate, guest.token, false)
console.log('PASS logged-in/guest shares, same-role invitation exceptions, read-only grants, revocation and private ended-room lockout')

// Techs who join any standard room through a link keep replay and archives after it ends.
for (const [owner, writable] of [['agent_owner', false], ['tech_owner', true]]) {
  const shared = await create(owner, 'Persistent shared by ' + owner)
  const grant = await link(shared, as(owner), writable)
  await accept(grant, 'tech_peer')
  await accept(grant, 'tech_peer')
  const detail = (await request('/api/rooms/' + shared.id, 'GET', undefined, as('tech_peer'))).room
  assert.equal(detail.canEdit, writable); assert.equal(detail.canViewPlayback, true)
  assert.equal(detail.canReadNotes, true); assert.equal(detail.canWriteNotes, writable)
  const viewer = await socket(shared, as('tech_peer'), true)
  assert.equal(viewer.provider.authorizedScope, writable ? 'read-write' : 'readonly')
  const ownerSocket = await socket(shared, as(owner), true)
  ownerSocket.doc.getText('codemirror').insert(0, 'retained replay')
  await new Promise(r => setTimeout(r, 350))
  await request('/api/rooms/' + shared.id + '/end', 'POST', {}, as(owner))
  assert.equal(viewer.state.closed, false)
  close(viewer); close(ownerSocket)
  const renewed = await login('tech_peer')
  const listed = (await request('/api/rooms', 'GET', undefined, renewed.token)).rooms.find(r => r.id === shared.id)
  assert.equal(listed?.canViewPlayback, true)
  assert.equal((await request('/api/rooms/' + shared.id, 'GET', undefined, renewed.token)).room.canEdit, false)
  assert((await request('/api/rooms/' + shared.id + '/playback/updates', 'GET', undefined, renewed.token)).updates.length > 0)
  await request('/api/rooms/' + shared.id + '/notes', 'GET', undefined, renewed.token)
  await request('/api/rooms/' + shared.id + '/notes', 'POST', { text: 'Ended room is read-only' }, renewed.token, 404)
  await request('/api/rooms/' + shared.id + '/share-links/' + grant.id, 'DELETE', undefined, as(owner))
  await request('/api/rooms/' + shared.id + '/playback/updates', 'GET', undefined, renewed.token, 404)
}
console.log('PASS link replay grants for every owner role, playback after fresh login, ended rooms read-only, revocation')

// The link a tech last joined through decides their permission.
const decide = await create('tech_owner', 'Last link decides')
const canEdit = async actor => (await request('/api/rooms/' + decide.id, 'GET', undefined, as(actor))).room.canEdit
await accept(await link(decide, as('tech_owner'), false), 'tech_peer')
assert.equal(await canEdit('tech_peer'), false)
const readonlySocket = await socket(decide, as('tech_peer'), true)
assert.equal(readonlySocket.provider.authorizedScope, 'readonly')
await accept(await link(decide, as('tech_owner'), true), 'tech_peer')
await wait(() => readonlySocket.state.closed, 'upgraded member reconnects')
close(readonlySocket)
assert.equal(await canEdit('tech_peer'), true)
await probe(decide, as('tech_peer'), true, 'read-write')
// Editing members still leave settings, sharing and the lifecycle to the owner and staff.
await request('/api/rooms/' + decide.id, 'PUT', { company: 'Edited by link member' }, as('tech_peer'))
for (const [suffix, method, body] of [
  ['', 'PUT', { name: 'blocked' }], ['', 'PUT', { language: 'java' }], ['/share-links', 'GET'], ['/share-links', 'POST', {}], ['/end', 'POST', {}], ['', 'DELETE'],
]) await request('/api/rooms/' + decide.id + suffix, method, body, as('tech_peer'), 404)
await accept(await link(decide, as('agent_owner'), false), 'tech_peer')
assert.equal(await canEdit('tech_peer'), false)
await probe(decide, as('tech_peer'), true, 'readonly')
// Staff and the owner keep their own access and leave the link unused.
const unusedByAgent = await link(decide, as('tech_owner'), false)
await accept(unusedByAgent, 'agent_peer')
const ownLink = await link(decide, as('tech_owner'), false)
await accept(ownLink, 'tech_owner')
assert.equal(await canEdit('agent_peer'), true)
assert.equal(await canEdit('tech_owner'), true)
const openLinks = (await request('/api/rooms/' + decide.id + '/share-links', 'GET', undefined, as('tech_owner'))).shareLinks.map(l => l.id)
assert(openLinks.includes(unusedByAgent.id) && openLinks.includes(ownLink.id))
console.log('PASS the latest link decides a tech\'s permission both ways; link members never manage the room; staff and owners keep access')

// The admin side (accounts, rooms, audit, devices, storage, announcements) is
// admin-only: agents get the same 404 as techs.
const someone = actors.tech_peer.user.id
for (const [path, method, body] of [
  ['/api/admin/users', 'GET'], ['/api/admin/users', 'POST', { username: 'made_by_agent', password }],
  ['/api/admin/users/' + someone, 'PATCH', { role: 'agent' }], ['/api/admin/users/' + someone, 'DELETE'],
  ['/api/admin/users/' + someone + '/devices', 'GET'], ['/api/admin/rooms', 'GET'], ['/api/admin/audit', 'GET'],
  ['/api/admin/storage/db-size', 'GET'], ['/api/admin/notifications', 'POST', { title: 'Not allowed', content: 'Not allowed' }],
]) {
  for (const actor of ['agent_owner', 'tech_owner']) await request(path, method, body, as(actor), 404)
}
const madeByAdmin = (await request('/api/admin/users', 'POST', { username: 'made_by_admin', password, role: 'agent' }, root, 201)).user
assert.equal(madeByAdmin.role, 'agent')
for (const role of ['superuser', 'user']) await request('/api/admin/users', 'POST', { username: 'retired_' + role, password, role }, root, 400)
await request('/api/admin/users/' + madeByAdmin.id, 'DELETE', undefined, root)
await request('/api/admin/users/' + actors.root.user.id, 'PATCH', { role: 'agent' }, root, 404)
await request('/api/admin/users/' + actors.agent_peer.user.id, 'PATCH', { role: 'superuser' }, root, 400)
await request('/api/admin/users/' + actors.agent_peer.user.id, 'PATCH', {}, root, 400)
// Agents still filter the rooms page by owner; techs cannot list other accounts.
await request('/api/users', 'GET', undefined, as('tech_owner'), 404)
assert((await request('/api/users', 'GET', undefined, as('agent_owner'))).users.some(u => u.id === actors.tech_owner.user.id))
console.log('PASS admin side is admin-only: agents and techs get 404 on accounts, rooms, audit, devices, storage and announcements')

// Registration is invite-only: agents and admins issue single-use codes, and an
// account registered with one is always a tech.
const register = (body, expected = 201) => request('/api/auth/register', 'POST', { password, ...body }, undefined, expected)
const invite = async (actor, body = {}) => (await request('/api/invites', 'POST', body, as(actor), 201)).invite
const listInvites = async actor => (await request('/api/invites', 'GET', undefined, as(actor))).invites
await request('/api/invites', 'GET', undefined, as('tech_owner'), 404)
await request('/api/invites', 'POST', {}, as('tech_owner'), 404)
await request('/api/invites', 'GET', undefined, undefined, 401)
await request('/api/invites', 'POST', { note: 'x'.repeat(101) }, as('agent_owner'), 400)
const agentInvite = await invite('agent_owner', { note: '  For the new tech  ' })
assert.match(agentInvite.code, /^[2-9A-HJ-NP-Z]{12}$/)
assert.equal(agentInvite.note, 'For the new tech')
assert.equal(agentInvite.createdBy.username, 'agent_owner')
assert.equal(agentInvite.isUsed || agentInvite.isExpired, false)
assert.equal(agentInvite.inviteUrl, 'http://127.0.0.1:55461/register?invite=' + agentInvite.code)
assert(Math.abs(Date.parse(agentInvite.expiresAt) - Date.now() - 7 * 864e5) < 60e3, 'invites last 7 days')
const peerInvite = await invite('agent_peer'), adminInvite = (await request('/api/invites', 'POST', {}, root, 201)).invite
// Agents see the invites they issued; admins see everyone's.
assert.deepEqual((await listInvites('agent_owner')).map(i => i.id), [agentInvite.id])
const allIds = (await listInvites('root')).map(i => i.id)
assert([agentInvite.id, peerInvite.id, adminInvite.id].every(id => allIds.includes(id)))
// No code, a wrong code or a taken username creates nothing and leaves the code usable.
await register({ username: 'walk_in' }, 400)
await register({ username: 'walk_in', inviteCode: 'ABCD-EFGH-JKLM' }, 400)
await register({ username: 'agent_owner', inviteCode: agentInvite.code }, 400)
// The displayed form works in any case; a requested role is ignored.
const displayed = agentInvite.code.toLowerCase().match(/.{4}/g).join('-')
const invited = await register({ username: 'invited_tech', inviteCode: ' ' + displayed + ' ', role: 'admin' })
assert.equal(invited.user.role, 'tech')
assert.equal((await request('/api/auth/profile', 'GET', undefined, invited.token)).user.role, 'tech')
await register({ username: 'second_use', inviteCode: agentInvite.code }, 410)
const used = (await listInvites('agent_owner')).find(i => i.id === agentInvite.id)
assert.equal(used.isUsed, true); assert.equal(used.isExpired, false); assert.equal(used.usedBy.username, 'invited_tech')
// Used invites stay as the record; unused ones are withdrawn by the issuer or an admin.
await request('/api/invites/' + agentInvite.id, 'DELETE', undefined, as('agent_owner'), 404)
await request('/api/invites/' + peerInvite.id, 'DELETE', undefined, as('agent_owner'), 404)
await request('/api/invites/' + peerInvite.id, 'DELETE', undefined, root)
await register({ username: 'withdrawn', inviteCode: peerInvite.code }, 400)
const ownWithdrawal = await invite('agent_owner')
await request('/api/invites/' + ownWithdrawal.id, 'DELETE', undefined, as('agent_owner'))
// Expired codes, and codes whose issuer is no longer staff, stop working.
sql(`UPDATE "RegistrationInvite" SET "expiresAt" = NOW() - INTERVAL '1 second' WHERE id = ${literal(adminInvite.id)}`)
await register({ username: 'too_late', inviteCode: adminInvite.code }, 410)
assert.equal((await listInvites('root')).find(i => i.id === adminInvite.id).isExpired, true)
const formerAgent = (await request('/api/admin/users', 'POST', { username: 'former_agent', password, role: 'agent' }, root, 201)).user
const formerAgentToken = (await login('former_agent')).token
const orphaned = (await request('/api/invites', 'POST', {}, formerAgentToken, 201)).invite
await request('/api/admin/users/' + formerAgent.id, 'PATCH', { role: 'tech' }, root)
await register({ username: 'orphaned', inviteCode: orphaned.code }, 410)
await request('/api/invites', 'GET', undefined, formerAgentToken, 404)
// Two registrations racing for one code: exactly one account is created.
const raced = (await request('/api/invites', 'POST', {}, root, 201)).invite
const statuses = await Promise.all(['race_a', 'race_b'].map(username => fetch(API + '/api/auth/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, inviteCode: raced.code }),
}).then(r => r.status)))
assert.deepEqual(statuses.sort(), [201, 410])
assert.equal(sql(`SELECT count(*) FROM "User" WHERE username IN ('race_a','race_b','walk_in','second_use','withdrawn','too_late','orphaned')`), '1')
// The audit trail links each account to its inviter but never records a code.
const inviteAudit = await request('/api/admin/audit?pageSize=100', 'GET', undefined, root)
const registration = inviteAudit.events.find(e => e.action === 'user.registered' && e.username === 'invited_tech')
assert.equal(registration.details.invitedBy, actors.agent_owner.user.id); assert.equal(registration.details.inviteId, agentInvite.id)
for (const action of ['invite.created', 'invite.revoked']) assert(inviteAudit.events.some(e => e.action === action), action)
// Refused codes are audited like failed sign-ins.
const refusals = inviteAudit.events.filter(e => e.action === 'user.registered' && !e.success).map(e => e.reason)
for (const reason of ['missing_invite', 'invalid_invite', 'invite_used', 'invite_expired']) assert(refusals.includes(reason), reason)
for (const code of [agentInvite.code, peerInvite.code, adminInvite.code, raced.code]) assert(!JSON.stringify(inviteAudit).includes(code))
assert(!JSON.stringify(inviteAudit).includes('For the new tech'))
console.log('PASS invite-only registration: staff-issued single-use 7-day codes, techs only, own/all listing, withdrawal, expiry, issuer demotion, races, audit')

// An owner's role change rechecks open sockets to their private rooms.
const promoted = await legacyPrivate('tech_owner', 'Role revalidation')
const observer = await socket(promoted, as('agent_peer'), true)
await request('/api/admin/users/' + actors.tech_owner.user.id, 'PATCH', { role: 'agent' }, root)
await request('/api/rooms/' + promoted.id, 'GET', undefined, as('agent_peer'), 404)
await wait(() => observer.state.closed, 'observer revoked after owner promotion')
close(observer)
await probe(promoted, as('agent_peer'), false)
// Deleted rooms expose neither metadata nor the history endpoint.
await request('/api/rooms/' + decide.id, 'DELETE', undefined, root)
for (const token of [root, as('agent_owner'), as('tech_peer')]) {
  await request('/api/rooms/' + decide.id, 'GET', undefined, token, 404)
  await request('/api/rooms/' + decide.id + '/playback/updates', 'GET', undefined, token, 404)
  await probe(decide, token, false)
}
console.log('PASS owner-role changes revoke stale socket access; deleted-room details and playback are denied')

// Anyone renames themselves once a week, to a name nobody holds whatever its case.
await request('/api/auth/username', 'PUT', { username: 'AGENT_PEER' }, as('tech_peer'), 400)
await request('/api/auth/username', 'PUT', { username: 'two words' }, as('tech_peer'), 400)
assert.deepEqual(await request('/api/auth/username', 'GET', undefined, as('tech_peer')), { nextChangeAt: null })
assert.equal((await request('/api/auth/username', 'PUT', { username: ' tech_renamed ' }, as('tech_peer'))).username, 'tech_renamed')
assert.equal((await request('/api/auth/profile', 'GET', undefined, as('tech_peer'))).user.username, 'tech_renamed')
const recent = await request('/api/auth/username', 'PUT', { username: 'tech_again' }, as('tech_peer'), 429)
assert(Date.parse(recent.nextChangeAt) > Date.now() + 6 * 86400_000)
await request('/api/auth/login', 'POST', { username: 'tech_peer', password }, undefined, 401)
actors.tech_peer = await login('tech_renamed')
await request('/api/admin/users', 'POST', { username: 'Tech_Renamed', role: 'tech', password }, root, 400)
sql(`UPDATE "User" SET "usernameChangedAt" = NOW() - INTERVAL '8 days' WHERE username = 'tech_renamed'`)
assert.equal((await request('/api/auth/username', 'PUT', { username: 'tech_peer' }, as('tech_peer'))).username, 'tech_peer')
console.log('PASS usernames: once a week, unique whatever the case, trimmed, signing in by the new name')

const web = await createServer({ server: { host: '127.0.0.1', port: 55461, strictPort: true, proxy: { '/api': { target: API, changeOrigin: true, ws: true } } }, define: { 'import.meta.env.VITE_API_URL': JSON.stringify(API), 'import.meta.env.VITE_WS_URL': JSON.stringify(API.replace('http', 'ws')) }, logLevel: 'error' })
await web.listen()
const openPage = async (browser, token, { mobile = false, lng = 'en' } = {}) => {
  const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: 900 }, deviceScaleFactor: mobile ? 3 : 1, hasTouch: mobile })
  await context.addInitScript(({ token, lng }) => { sessionStorage.setItem('sharecode-tab-auth', JSON.stringify({ state: { token }, version: 0 })); localStorage.setItem('i18nextLng', lng) }, { token, lng })
  const page = await context.newPage(), errors = []
  page.on('pageerror', e => errors.push(e.message))
  return { context, page, errors }
}
try {
  for (const [engine, type] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await type.launch()
    try {
      for (const mobile of [false, true]) {
        const lng = mobile ? 'zh' : 'en', { context, page, errors } = await openPage(browser, as('admin_peer'), { mobile, lng })
        await page.goto('http://127.0.0.1:55461/rooms')
        await page.getByRole('button', { name: mobile ? '创建新房间' : 'Create New Room', exact: true }).click()
        const check = page.getByRole('checkbox', { name: mobile ? '设为私密房间' : 'Make room private' })
        assert.equal(await check.isChecked(), false)
        await check.check()
        await page.locator('#roomName').fill('Private UI ' + engine + ' ' + lng)
        await page.screenshot({ path: `/tmp/sharecode-private-form-${engine}-${lng}.png` })
        assert(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1))
        const created = page.waitForResponse(r => r.url().endsWith('/api/rooms') && r.request().method() === 'POST')
        await page.getByRole('dialog').locator('button[type=submit]').click()
        const response = await created; assert.equal((await response.json()).room.isPrivate, true)
        await page.waitForURL('**/room/**')
        await page.locator('.monaco-editor').waitFor()
        await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent.match(/Saved|已保存/))
        await page.waitForLoadState('networkidle')
        await page.getByRole('button', { name: mobile ? '返回' : 'Back', exact: true }).click()
        await page.getByRole('link', { name: 'Private UI ' + engine + ' ' + lng, exact: true }).waitFor()
        assert(await page.getByLabel(mobile ? '私密房间' : 'Private room', { exact: true }).count() > 0)
        await page.getByRole('button', { name: mobile ? '账号菜单' : 'Account menu', exact: true }).click()
        await page.getByText(mobile ? '超级管理员' : 'Super admin', { exact: true }).waitFor()
        assert.equal(await page.getByRole('menuitem', { name: mobile ? '邀请技术' : 'Invite techs', exact: true }).count(), 1)
        assert.deepEqual(errors, [])
        await context.close()
      }
      // Agents and techs never see the private option or the admin side; only agents
      // filter rooms by owner and invite techs.
      for (const [actor, ownerFilter, roleLabel] of [['agent_owner', 1, 'Manager'], ['tech_peer', 0, 'Tech']]) {
        const { context, page, errors } = await openPage(browser, as(actor))
        await page.goto('http://127.0.0.1:55461/rooms')
        await page.getByRole('combobox', { name: 'Activeness', exact: true }).waitFor()
        assert.equal(await page.getByRole('combobox', { name: 'Owner', exact: true }).count(), ownerFilter, `${actor} owner filter`)
        await page.getByRole('button', { name: 'Create New Room', exact: true }).click()
        await page.locator('#roomName').waitFor()
        assert.equal(await page.getByRole('checkbox', { name: 'Make room private' }).count(), 0, `${actor} private option`)
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: 'Account menu', exact: true }).click()
        await page.getByText(roleLabel, { exact: true }).waitFor()
        for (const item of ['Admin Dashboard', 'Audit log']) assert.equal(await page.getByRole('menuitem', { name: item, exact: true }).count(), 0, `${actor} ${item}`)
        assert.equal(await page.getByRole('menuitem', { name: 'Invite techs', exact: true }).count(), actor === 'agent_owner' ? 1 : 0)
        await page.keyboard.press('Escape')
        // Typing the admin URLs does not open them either.
        await page.goto('http://127.0.0.1:55461/admin')
        await page.waitForURL('**/rooms')
        await page.getByRole('combobox', { name: 'Activeness', exact: true }).waitFor()
        await page.goto('http://127.0.0.1:55461/admin/audit')
        await page.getByRole('alert').getByText('Super admin access required.', { exact: true }).waitFor()
        assert.deepEqual(errors, [])
        await context.close()
      }
      // An agent creates an invite; the tech opens its link and registers.
      {
        const { context, page, errors } = await openPage(browser, as('agent_owner'))
        await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
        await page.goto('http://127.0.0.1:55461/rooms')
        await page.getByRole('button', { name: 'Account menu', exact: true }).click()
        await page.getByRole('menuitem', { name: 'Invite techs', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'Invite techs' })
        await dialog.getByLabel('Note', { exact: true }).fill('UI ' + engine)
        const created = page.waitForResponse(r => r.url().endsWith('/api/invites') && r.request().method() === 'POST')
        await dialog.getByRole('button', { name: 'Create invite', exact: true }).click()
        const { invite: uiInvite } = await (await created).json()
        const displayedCode = uiInvite.code.match(/.{4}/g).join('-')
        const row = dialog.getByRole('listitem').filter({ hasText: displayedCode })
        await row.getByText('Unused', { exact: true }).waitFor()
        await row.getByText('UI ' + engine, { exact: true }).waitFor()
        assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
        await page.screenshot({ path: `/tmp/sharecode-invites-${engine}.png` })
        assert.deepEqual(errors, [])
        await context.close()

        const guest = await browser.newContext()
        await guest.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
        const tab = await guest.newPage(), tabErrors = []
        tab.on('pageerror', e => tabErrors.push(e.message))
        await tab.goto('http://127.0.0.1:55461/login')
        await tab.getByRole('link', { name: 'Register', exact: true }).waitFor()
        await tab.goto('http://127.0.0.1:55461/register?invite=' + uiInvite.code)
        assert.equal(await tab.locator('#inviteCode').inputValue(), displayedCode)
        await tab.locator('#username').fill('ui_tech_' + engine)
        await tab.locator('#password').fill(password)
        await tab.locator('#register-form button[type=submit]').click()
        await tab.waitForURL('**/rooms')
        await tab.getByRole('button', { name: 'Account menu', exact: true }).click()
        await tab.getByText('Tech', { exact: true }).waitFor()
        assert.equal(await tab.getByRole('menuitem', { name: 'Invite techs', exact: true }).count(), 0)
        // Reusing the link shows why it no longer works.
        const again = await browser.newContext()
        await again.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
        const retry = await again.newPage()
        await retry.goto('http://127.0.0.1:55461/register?invite=' + uiInvite.code)
        await retry.locator('#username').fill('ui_retry_' + engine)
        await retry.locator('#password').fill(password)
        await retry.locator('#register-form button[type=submit]').click()
        await retry.getByText('This invite code has already been used. Ask for a new one.', { exact: true }).waitFor()
        assert.deepEqual(tabErrors, [])
        await again.close()
        await guest.close()
      }
      console.log('PASS', engine, 'admin-only private rooms and admin side, agent invites and invite-link registration, owner filter, role in the user menu; desktop/mobile 3x DPI, EN/ZH')
    } finally { await browser.close() }
  }
} finally { await web.close() }
// Rejected Hocuspocus connections can leave reconnect timers in Node after
// destroy(); all assertions, browser shutdown and Vite shutdown have completed.
process.exit(0)
