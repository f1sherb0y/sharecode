// 排班: shared customer profiles and the sessions agents plan for techs, over the
// API and in the calendar. Run with scripts/test-runner-local.sh; all accounts,
// customers and sessions are disposable.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
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
for (const [username, role] of [['agent_a', 'agent'], ['agent_b', 'agent'], ['tech_a', 'tech'], ['tech_b', 'tech'], ['tech_gone', 'tech']]) {
  await request('/api/admin/users', 'POST', { username, role, password }, root, 201)
  actors[username] = await login(username)
}
const as = name => actors[name].token
const id = name => actors[name].user.id

// Wall-clock times in Asia/Shanghai, `days` from today there.
const shanghaiToday = new Date(Date.now() + 8 * 3600e3)
const at = (days, hour, minute = 0) => {
  const date = new Date(Date.UTC(shanghaiToday.getUTCFullYear(), shanghaiToday.getUTCMonth(), shanghaiToday.getUTCDate() + days))
  const pad = n => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(hour)}:${pad(minute)}:00+08:00`
}
const range = (fromDays, toDays) => `from=${encodeURIComponent(at(fromDays, 0))}&to=${encodeURIComponent(at(toDays, 0))}`
const list = async (actor, query = range(-30, 60)) => (await request('/api/appointments?' + query, 'GET', undefined, as(actor))).appointments
const notices = async actor => (await request('/api/notifications/unread', 'GET', undefined, as(actor))).notifications.filter(n => n.kind?.startsWith('schedule.'))

// Customers: one list shared by agents and admins; techs have no customer pages.
for (const [method, path] of [['GET', '/api/customers'], ['POST', '/api/customers'], ['GET', '/api/customers/x'], ['PUT', '/api/customers/x'], ['DELETE', '/api/customers/x']]) {
  await request(path, method, method === 'GET' || method === 'DELETE' ? undefined : { name: 'x' }, as('tech_a'), 404)
}
await request('/api/customers', 'GET', undefined, undefined, 401)
await request('/api/customers', 'POST', { name: '  ' }, as('agent_a'), 400)
await request('/api/customers', 'POST', { name: 'x'.repeat(101) }, as('agent_a'), 400)
const zhang = (await request('/api/customers', 'POST', { name: ' 张三 ', contact: 'wx: zhang_100%', notes: 'Prefers evenings' }, as('agent_a'), 201)).customer
assert.equal(zhang.name, '张三'); assert.equal(zhang.createdBy.username, 'agent_a'); assert.equal(zhang.upcomingCount, 0)
const li = (await request('/api/customers', 'POST', { name: 'Li Si' }, as('agent_b'), 201)).customer
const wang = (await request('/api/customers', 'POST', { name: 'Wang Wu', contact: 'wang@example.invalid' }, as('root'), 201)).customer
const customerSearch = async q => (await request('/api/customers?q=' + encodeURIComponent(q), 'GET', undefined, as('agent_b'))).customers.map(c => c.name)
assert.deepEqual(await customerSearch(''), ['Li Si', 'Wang Wu', '张三'])
assert.deepEqual(await customerSearch('张'), ['张三'])
assert.deepEqual(await customerSearch('100%'), ['张三'], 'contacts are searched literally')
assert.deepEqual(await customerSearch('%'), ['张三'])
const page = await request('/api/customers?pageSize=2&page=2', 'GET', undefined, as('agent_a'))
assert.deepEqual([page.customers.length, page.pagination.total, page.pagination.totalPages], [1, 3, 2])
// Each customer belongs to the agent who created it: "mine" lists their own.
const mineOf = async actor => (await request('/api/customers?mine=true', 'GET', undefined, as(actor))).customers.map(c => c.name)
assert.deepEqual([await mineOf('agent_a'), await mineOf('agent_b'), await mineOf('root')], [['张三'], ['Li Si'], ['Wang Wu']])
assert.equal((await request('/api/customers?mine=true', 'GET', undefined, as('agent_b'))).pagination.total, 1)
const edited = (await request('/api/customers/' + li.id, 'PUT', { contact: 'tel 123' }, as('agent_a'))).customer
assert.equal(edited.contact, 'tel 123'); assert.equal(edited.name, 'Li Si')
assert.equal((await request('/api/customers/' + li.id, 'PUT', { contact: null }, as('agent_b'))).customer.contact, null)
await request('/api/customers/' + li.id, 'PUT', { name: '' }, as('agent_b'), 400)
console.log('PASS customers: shared by agents and admins, owned by their creator, hidden from techs, literal search, paging, partial edits')

// Sessions: agents plan every tech's sessions; techs only read their own.
await request('/api/appointments', 'GET', undefined, as('agent_a'), 400)
await request(`/api/appointments?from=${encodeURIComponent(at(0, 0))}&to=${encodeURIComponent(at(101, 0))}`, 'GET', undefined, as('agent_a'), 400)
await request(`/api/appointments?from=${encodeURIComponent(at(1, 0))}&to=${encodeURIComponent(at(0, 0))}`, 'GET', undefined, as('agent_a'), 400)
const plan = (actor, body, expected = 201) => request('/api/appointments', 'POST', body, as(actor), expected)
await plan('tech_a', { customerId: zhang.id, startsAt: at(1, 10), durationMinutes: 60 }, 404)
await plan('agent_a', { startsAt: at(1, 10) }, 400)
await plan('agent_a', { customerId: zhang.id, startsAt: '2026-10-20T10:00' }, 400)
await plan('agent_a', { customerId: zhang.id, startsAt: at(1, 10), durationMinutes: 4 }, 400)
await plan('agent_a', { customerId: zhang.id, startsAt: at(1, 10), durationMinutes: 1441 }, 400)
await plan('agent_a', { customerId: zhang.id, startsAt: at(1, 10), techId: 'nobody' }, 400)
await plan('agent_a', { customerId: 'missing', startsAt: at(1, 10) }, 400)
const first = (await plan('agent_a', {
  customerId: zhang.id, techId: id('tech_a'), startsAt: at(1, 10).replace(':00+', ':59+'), durationMinutes: 60,
  company: ' Acme ', position: 'Backend', notes: 'Bring the take-home',
})).appointment
assert.equal(first.startsAt, new Date(at(1, 10)).toISOString().replace('.000Z', '+00:00'), 'start times are kept to the minute')
assert.equal(Date.parse(first.endsAt) - Date.parse(first.startsAt), 60 * 60e3)
assert.deepEqual([first.status, first.company, first.tech.username, first.createdBy.username, first.customer.notes, first.hasConflict, first.room], ['scheduled', 'Acme', 'tech_a', 'agent_a', 'Prefers evenings', false, null])
assert.equal('agent' in first, false, 'whoever plans a session is its creator; there is no agent in charge')
// A status or agent sent along is ignored: sessions are deleted, not cancelled, and complete when their room ends.
const ignored = (await plan('agent_a', { customerId: zhang.id, startsAt: at(1, 12), status: 'cancelled', agentId: id('agent_b') })).appointment
assert.deepEqual([ignored.status, ignored.createdBy.username], ['scheduled', 'agent_a'])
await request('/api/appointments/' + ignored.id, 'DELETE', undefined, as('agent_a'))
const unassigned = (await plan('agent_b', { customerId: li.id, startsAt: at(2, 14), durationMinutes: 90 })).appointment
assert.equal(unassigned.tech, null)
const techB = (await plan('root', { customerId: wang.id, techId: id('tech_b'), startsAt: at(1, 10), durationMinutes: 45 })).appointment
assert.equal(techB.createdBy.username, 'audit_admin')
// Techs see only their own sessions, without the customer's profile: no contact, no private notes.
const techView = await list('tech_a')
assert.deepEqual(techView.map(a => a.id), [first.id])
assert.deepEqual(Object.keys(techView[0].customer).sort(), ['id', 'isDeleted', 'name', 'owner']); assert.equal(techView[0].notes, 'Bring the take-home')
assert.equal((await list('agent_b')).find(a => a.id === first.id).customer.contact, 'wx: zhang_100%')
assert.deepEqual((await list('tech_a', range(-30, 60) + '&techId=' + id('tech_b'))).map(a => a.id), [first.id], 'techs cannot ask for other techs')
await request('/api/appointments/' + techB.id, 'GET', undefined, as('tech_a'), 404)
assert.equal((await request('/api/appointments/' + first.id, 'GET', undefined, as('tech_a'))).appointment.id, first.id)
await request('/api/appointments/' + first.id, 'PUT', { notes: 'x' }, as('tech_a'), 404)
await request('/api/appointments/' + first.id, 'DELETE', undefined, as('tech_a'), 404)
assert.deepEqual((await list('agent_b')).map(a => a.id).sort(), [first.id, unassigned.id, techB.id].sort())
assert.deepEqual((await list('agent_b', range(-30, 60) + '&unassigned=true')).map(a => a.id), [unassigned.id])
assert.deepEqual((await list('agent_b', range(-30, 60) + '&techId=' + id('tech_b'))).map(a => a.id), [techB.id])
assert.deepEqual((await list('agent_b', range(-30, 60) + '&customerId=' + zhang.id)).map(a => a.id), [first.id])
// "Mine": the sessions of an agent's own customers and the ones they planned; techs have their own anyway.
const mine = actor => list(actor, range(-30, 60) + '&mine=true').then(found => found.map(a => a.id).sort())
assert.deepEqual([await mine('agent_a'), await mine('agent_b'), await mine('root')], [[first.id], [unassigned.id], [techB.id]])
const crossed = (await plan('agent_a', { customerId: li.id, startsAt: at(9, 9) })).appointment
assert.deepEqual([await mine('agent_a'), await mine('agent_b'), await mine('root')], [[first.id, crossed.id].sort(), [unassigned.id, crossed.id].sort(), [techB.id]], "planned for another agent's customer: both agents' own")
await request('/api/appointments/' + crossed.id, 'DELETE', undefined, as('agent_a'))
assert.deepEqual(await mine('tech_a'), [first.id])
// A range returns the sessions overlapping it, including one that started before.
assert.deepEqual((await list('agent_a', `from=${encodeURIComponent(at(1, 10, 30))}&to=${encodeURIComponent(at(1, 10, 40))}`)).map(a => a.id).sort(), [first.id, techB.id].sort())
assert.deepEqual(await list('agent_a', `from=${encodeURIComponent(at(1, 11))}&to=${encodeURIComponent(at(1, 12))}`), [])
console.log('PASS sessions: validation, defaults, minute precision, no status or agent, staff-only planning, techs read only their own, range, filters and "mine"')

// Overlaps for one tech need confirmation; back-to-back sessions do not.
const overlap = await plan('agent_b', { customerId: li.id, techId: id('tech_a'), startsAt: at(1, 10, 30), durationMinutes: 60 }, 409)
assert.equal(overlap.error, 'Schedule conflict')
assert.deepEqual(overlap.conflicts.map(c => [c.id, c.customer.name]), [[first.id, '张三']])
await plan('agent_b', { customerId: li.id, techId: id('tech_a'), startsAt: at(1, 11), durationMinutes: 30 })
const doubled = (await plan('agent_b', { customerId: li.id, techId: id('tech_a'), startsAt: at(1, 10, 30), durationMinutes: 60, allowConflicts: true })).appointment
assert.equal(doubled.hasConflict, true)
assert.equal((await request('/api/appointments/' + first.id, 'GET', undefined, as('agent_a'))).appointment.hasConflict, true)
// Edits that cannot add an overlap never stop on one saved on purpose.
await request('/api/appointments/' + doubled.id, 'PUT', { notes: 'Second opinion' }, as('agent_a'))
await request('/api/appointments/' + doubled.id, 'PUT', { durationMinutes: 75 }, as('agent_a'), 409)
await request('/api/appointments/' + doubled.id, 'PUT', { startsAt: at(1, 15) }, as('agent_a'))
assert.equal((await request('/api/appointments/' + first.id, 'GET', undefined, as('agent_a'))).appointment.hasConflict, false)
// Two planners racing for one tech's slot: one wins, the other is told.
const racers = await Promise.all(['agent_a', 'agent_b'].map(actor => fetch(API + '/api/appointments', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + as(actor) },
  body: JSON.stringify({ customerId: wang.id, techId: id('tech_b'), startsAt: at(3, 9), durationMinutes: 60 }),
}).then(r => r.status)))
assert.deepEqual(racers.sort(), [201, 409])
console.log('PASS conflicts: overlaps need confirmation, back-to-back is free, saved overlaps flagged, racing planners serialized')

// Techs are told about their own sessions still to come, never about past ones.
const firstNotices = await notices('tech_a')
const assigned = firstNotices.find(n => n.kind === 'schedule.assigned' && n.data.appointmentId === first.id)
assert(assigned, 'assignment notice')
assert.deepEqual([assigned.data.customerName, assigned.data.durationMinutes, assigned.data.company, assigned.createdBy.username], ['张三', 60, 'Acme', 'agent_a'])
assert.equal(firstNotices.filter(n => n.kind === 'schedule.assigned').length, 3, 'two sessions plus the overlap saved on purpose')
assert.deepEqual(await notices('agent_a'), [], 'personal notices reach only their recipient')
assert.deepEqual(await notices('tech_b').then(n => n.map(x => x.data.appointmentId)).then(ids => ids.includes(first.id)), false)
await plan('agent_a', { customerId: zhang.id, techId: id('tech_b'), startsAt: at(-2, 9), durationMinutes: 60 })
assert.equal((await notices('tech_b')).filter(n => n.kind === 'schedule.assigned').length, 2, 'no notice for a past session')
await request('/api/notifications/read-all', 'POST', {}, as('tech_a'))
assert.deepEqual(await notices('tech_a'), [])
// Moving, reassigning and deleting each tell the techs concerned.
await request('/api/appointments/' + first.id, 'PUT', { startsAt: at(1, 16), notes: 'Moved' }, as('agent_b'))
const moved = (await notices('tech_a')).find(n => n.kind === 'schedule.updated')
assert.deepEqual([moved.data.previousStartsAt, moved.data.startsAt, moved.data.changes], [first.startsAt, new Date(at(1, 16)).toISOString().replace('.000Z', '+00:00'), ['time', 'notes']])
await request('/api/appointments/' + unassigned.id, 'PUT', { techId: id('tech_a') }, as('agent_b'))
await request('/api/appointments/' + unassigned.id, 'PUT', { techId: id('tech_b') }, as('agent_b'))
await request('/api/appointments/' + doubled.id, 'DELETE', undefined, as('agent_b'))
await request('/api/appointments/' + doubled.id, 'DELETE', undefined, as('agent_b'), 404)
const techANotices = (await notices('tech_a')).map(n => [n.kind, n.data.appointmentId]).reverse()
assert.deepEqual(techANotices, [
  ['schedule.updated', first.id], ['schedule.assigned', unassigned.id],
  ['schedule.unassigned', unassigned.id], ['schedule.cancelled', doubled.id],
], 'deleting a session still to come tells its tech it is cancelled')
const reassigned = (await notices('tech_b')).find(n => n.kind === 'schedule.assigned' && n.data.appointmentId === unassigned.id)
assert.equal(reassigned.data.customerName, 'Li Si')
// Saving the form unchanged writes, notifies and records nothing.
const unchanged = (await request('/api/appointments/' + first.id, 'GET', undefined, as('agent_b'))).appointment
const updateEvents = () => sql(`SELECT count(*) FROM "AuditEvent" WHERE action = 'appointment.updated'`)
const eventsBefore = updateEvents()
const resaved = (await request('/api/appointments/' + first.id, 'PUT', {
  customerId: unchanged.customer.id, techId: unchanged.tech.id, startsAt: unchanged.startsAt,
  durationMinutes: unchanged.durationMinutes, company: unchanged.company, position: unchanged.position, notes: unchanged.notes,
}, as('agent_b'))).appointment
assert.equal(resaved.updatedAt, unchanged.updatedAt)
assert.equal(updateEvents(), eventsBefore)
assert.equal((await notices('tech_a')).length, techANotices.length)
// Acknowledging one notice leaves the others unread; nobody can mark someone else's.
const [oneNotice, ...rest] = await notices('tech_a')
await request('/api/notifications/read', 'POST', { ids: [] }, as('tech_a'), 400)
assert.equal((await request('/api/notifications/read', 'POST', { ids: [oneNotice.id] }, as('tech_b'))).markedCount, 0)
assert.equal((await request('/api/notifications/read', 'POST', { ids: [oneNotice.id] }, as('tech_a'))).markedCount, 1)
assert.deepEqual((await notices('tech_a')).map(n => n.id), rest.map(n => n.id))
await request('/api/notifications/read-all', 'POST', {}, as('agent_a'))
assert.equal(sql(`SELECT count(*) FROM "NotificationRead" r JOIN "Notification" n ON n.id = r."notificationId" WHERE r."userId" = ${literal(id('agent_a'))} AND n."recipientId" IS NOT NULL`), '0')
const announcements = (await request('/api/notifications', 'GET', undefined, as('agent_a'))).notifications
assert(announcements.every(n => n.kind === null), 'staff only see announcements')
console.log('PASS notices: assigned/changed/reassigned/deleted reach the techs concerned for upcoming sessions only; per-notice read state')

// A session's room belongs to its tech and follows the session.
await request(`/api/appointments/${first.id}/room`, 'POST', {}, as('tech_b'), 404)
await request(`/api/appointments/${first.id}/room`, 'POST', { language: 'cobol' }, as('tech_a'), 400)
const opened = await request(`/api/appointments/${first.id}/room`, 'POST', { language: 'python' }, as('tech_a'), 201)
assert.equal(opened.created, true)
assert.deepEqual([opened.room.owner.username, opened.room.language, opened.room.name, opened.room.company, opened.room.position, opened.room.duration], ['tech_a', 'python', 'Acme Backend', 'Acme', 'Backend', 60], "the name has the company and position, not the customer's name")
assert.equal(Date.parse(opened.room.scheduledTime), Date.parse(at(1, 16)))
assert.equal(opened.appointment.room.id, opened.room.id)
const reopened = await request(`/api/appointments/${first.id}/room`, 'POST', {}, as('agent_a'))
assert.deepEqual([reopened.created, reopened.room.id], [false, opened.room.id])
assert.equal((await request('/api/rooms/' + opened.room.id, 'GET', undefined, as('tech_a'))).room.canEdit, true)
await request('/api/rooms/' + opened.room.id, 'GET', undefined, as('tech_b'), 404)
// Links to a session's room stay valid until the session ends, even when made days ahead.
const link = (await request(`/api/rooms/${opened.room.id}/share-links`, 'POST', { canEdit: true }, as('tech_a'), 201)).shareLink
assert.equal(link.expiresAt, opened.appointment.endsAt)
const plainRoom = (await request('/api/rooms', 'POST', { name: 'Plain', language: 'python' }, as('tech_a'), 201)).room
const plainLink = (await request(`/api/rooms/${plainRoom.id}/share-links`, 'POST', {}, as('tech_a'), 201)).shareLink
assert(Math.abs(Date.parse(plainLink.expiresAt) - Date.now() - 6 * 3600e3) < 60e3, 'other links keep 6 hours')
// Moving the session moves its room; a new tech takes the room over and the previous one keeps it.
await request('/api/appointments/' + first.id, 'PUT', { startsAt: at(1, 17), durationMinutes: 90, company: 'Globex' }, as('agent_a'))
let room = (await request('/api/rooms/' + opened.room.id, 'GET', undefined, as('agent_a'))).room
assert.deepEqual([Date.parse(room.scheduledTime), room.duration, room.company, room.name], [Date.parse(at(1, 17)), 90, 'Globex', 'Globex Backend'])
// A room renamed by hand keeps its name.
await request('/api/rooms/' + opened.room.id, 'PUT', { name: 'Final round' }, as('tech_a'))
await request('/api/appointments/' + first.id, 'PUT', { position: 'Platform' }, as('agent_a'))
room = (await request('/api/rooms/' + opened.room.id, 'GET', undefined, as('agent_a'))).room
assert.deepEqual([room.name, room.position], ['Final round', 'Platform'])
await request('/api/appointments/' + first.id, 'PUT', { techId: id('tech_b') }, as('agent_a'))
room = (await request('/api/rooms/' + opened.room.id, 'GET', undefined, as('tech_b'))).room
assert.equal(room.owner.username, 'tech_b'); assert.equal(room.canEdit, true)
const kept = (await request('/api/rooms/' + opened.room.id, 'GET', undefined, as('tech_a'))).room
assert.deepEqual([kept.owner.username, kept.canEdit], ['tech_b', true], 'the previous tech still edits the room')
assert((await request('/api/rooms?pageSize=100', 'GET', undefined, as('tech_a'))).rooms.some(r => r.id === opened.room.id), 'and still lists it')
await request(`/api/appointments/${first.id}/room`, 'POST', {}, as('tech_a'), 404)
assert.equal(sql(`SELECT "canEdit" AND "canReplay" AND "shareLinkId" IS NULL FROM "RoomParticipant" WHERE "roomId" = ${literal(opened.room.id)} AND "userId" = ${literal(id('tech_a'))}`), 't')
// An unassigned session's room belongs to the staff member who opens it, until a tech is assigned.
const later = (await plan('agent_a', { customerId: wang.id, startsAt: at(4, 9), durationMinutes: 30 })).appointment
const staffRoom = await request(`/api/appointments/${later.id}/room`, 'POST', {}, as('agent_b'), 201)
assert.deepEqual([staffRoom.room.owner.username, staffRoom.room.name], ['agent_b', '场次'], 'without a company or position the room is named 场次')
await request('/api/appointments/' + later.id, 'PUT', { techId: id('tech_a') }, as('agent_a'))
assert.equal((await request('/api/rooms/' + staffRoom.room.id, 'GET', undefined, as('tech_a'))).room.owner.username, 'tech_a')
// Ending the room completes the session; a new room can replace an ended one.
await request(`/api/rooms/${opened.room.id}/end`, 'POST', undefined, as('tech_b'))
let session = (await request('/api/appointments/' + first.id, 'GET', undefined, as('tech_b'))).appointment
assert.deepEqual([session.status, session.room.isEnded], ['completed', true])
assert.equal((await request('/api/rooms/' + opened.room.id, 'GET', undefined, as('tech_a'))).room.isEnded, true)
await request(`/api/rooms/${opened.room.id}/playback/updates`, 'GET', undefined, as('tech_a'))
await request(`/api/rooms/${opened.room.id}/playback/updates`, 'GET', undefined, as('tech_gone'), 404)
assert.equal((await request(`/api/appointments/${first.id}/room`, 'POST', {}, as('tech_b'))).room.id, opened.room.id, 'the ended room opens for replay')
const replaced = await request(`/api/appointments/${first.id}/room`, 'POST', { replace: true }, as('tech_b'), 201)
assert.notEqual(replaced.room.id, opened.room.id)
assert.deepEqual([replaced.appointment.status, replaced.room.owner.username], ['scheduled', 'tech_b'])
assert.equal((await request('/api/rooms/' + opened.room.id, 'GET', undefined, as('tech_b'))).room.isEnded, true, 'the old room stays with its history')
// Each new room reads as scheduled again until it ends.
await request(`/api/rooms/${replaced.room.id}/end`, 'POST', undefined, as('tech_b'))
assert.equal((await request('/api/appointments/' + first.id, 'GET', undefined, as('agent_a'))).appointment.status, 'completed')
const reopenedRoom = await request(`/api/appointments/${first.id}/room`, 'POST', { replace: true }, as('tech_b'), 201)
assert.equal(reopenedRoom.appointment.status, 'scheduled')
await request(`/api/appointments/${doubled.id}/room`, 'POST', {}, as('agent_a'), 404)
// The inactivity sweep (run when a server starts) closes idle rooms but never a
// session's room, even days after the session.
const idle = (await request('/api/rooms', 'POST', { name: 'Idle', language: 'python' }, as('tech_a'), 201)).room
const pastSession = (await plan('agent_a', { customerId: li.id, techId: id('tech_a'), startsAt: at(-3, 9), durationMinutes: 60 })).appointment
const pastRoom = (await request(`/api/appointments/${pastSession.id}/room`, 'POST', {}, as('tech_a'), 201)).room
sql(`UPDATE "Room" SET "updatedAt" = NOW() - INTERVAL '7 hours' WHERE id IN (${literal(idle.id)}, ${literal(pastRoom.id)})`)
const ended = roomId => sql(`SELECT "isEnded" FROM "Room" WHERE id = ${literal(roomId)}`) === 't'
const sweeper = spawn(new URL('../../server-rs/target/debug/sharecode-server', import.meta.url).pathname, [], {
  stdio: 'ignore',
  env: { ...process.env, DATABASE_URL: 'postgresql://runner_test:local_runner_test@127.0.0.1:55459/runner_test', BIND_ADDRESS: '127.0.0.1', PORT: '55462',
    JWT_SECRET: 'local-runner-test-key-not-production', ADMIN_USERNAME: 'audit_admin', ADMIN_PASSWORD: password, ADMIN_EMAIL: 'audit@example.invalid',
    FRONTEND_URL: 'http://127.0.0.1:55461', APP_URL: 'http://127.0.0.1:55461', TRUSTED_PROXY_CIDRS: '' },
})
try {
  for (let i = 0; i < 150 && !ended(idle.id); i++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(ended(idle.id), true, 'the sweep ran')
  assert.equal(ended(pastRoom.id), false, "a session's room is ended by hand only")
} finally { sweeper.kill() }
await request(`/api/rooms/${pastRoom.id}/end`, 'POST', undefined, as('tech_a'))
console.log('PASS session rooms: owned by the tech, idempotent, time/company sync, links last the session, reassignment moves ownership and keeps the previous tech, end completes, replace, never ended for inactivity')

// Customers with sessions to come stay until those are moved or deleted; history keeps their name.
await request('/api/customers/' + zhang.id, 'DELETE', undefined, as('agent_b'), 409)
const history = await request('/api/customers/' + zhang.id, 'GET', undefined, as('agent_b'))
assert(history.appointments.some(a => a.id === first.id))
assert.equal(history.customer.upcomingCount, 1)
await request('/api/appointments/' + first.id, 'PUT', { startsAt: at(-1, 9), allowConflicts: true }, as('agent_b'))
for (const a of await list('agent_b', range(-30, 60) + '&customerId=' + zhang.id)) {
  if (Date.parse(a.endsAt) > Date.now()) await request('/api/appointments/' + a.id, 'DELETE', undefined, as('agent_b'))
}
await request('/api/customers/' + zhang.id, 'DELETE', undefined, as('agent_b'))
await request('/api/customers/' + zhang.id, 'GET', undefined, as('agent_b'), 404)
assert.equal((await customerSearch('张')).length, 0)
assert.equal((await request('/api/appointments/' + first.id, 'GET', undefined, as('agent_b'))).appointment.customer.name, '张三')
await plan('agent_a', { customerId: zhang.id, startsAt: at(6, 9) }, 400)
// A deleted tech's sessions to come return to the unassigned list.
const gone = (await plan('agent_a', { customerId: wang.id, techId: id('tech_gone'), startsAt: at(7, 9) })).appointment
const gonePast = (await plan('agent_a', { customerId: wang.id, techId: id('tech_gone'), startsAt: at(-3, 9) })).appointment
await request('/api/admin/users/' + id('tech_gone'), 'DELETE', undefined, root)
assert.equal((await request('/api/appointments/' + gone.id, 'GET', undefined, as('agent_a'))).appointment.tech, null)
assert.equal((await request('/api/appointments/' + gonePast.id, 'GET', undefined, as('agent_a'))).appointment.tech.isDeleted, true)
await plan('agent_a', { customerId: wang.id, techId: id('tech_gone'), startsAt: at(8, 9) }, 400)
console.log('PASS customer removal waits for upcoming sessions and keeps history; deleted techs release their upcoming sessions')

// The audit trail names who planned what, but never a customer's details.
const audit = {}
for (const action of ['customer.created', 'customer.updated', 'customer.deleted', 'appointment.created', 'appointment.updated', 'appointment.deleted', 'room.created', 'room.updated']) {
  audit[action] = (await request('/api/admin/audit?pageSize=100&action=' + action, 'GET', undefined, root)).events
  assert(audit[action].length > 0, action)
}
assert(audit['room.created'].some(e => e.details.appointmentId === first.id))
assert(audit['room.updated'].some(e => e.details.ownerChanged?.after === id('tech_b')))
assert.deepEqual(audit['customer.updated'][0].details.changes, ['contact'])
assert.deepEqual(audit['appointment.updated'].find(e => e.targetId === doubled.id && e.details.allowConflicts === false && e.details.changes.includes('notes'))?.details.changes, ['notes'])
const auditText = JSON.stringify(audit)
for (const secret of ['张三', 'Li Si', 'zhang_100%', 'Prefers evenings', 'Bring the take-home', 'Acme']) assert(!auditText.includes(secret), secret)
console.log('PASS audit: customer and session changes recorded by ID, without names, contacts or notes')

// The schedule tour: each account sees it once, on any device, and only known tours are kept.
await request('/api/tours', 'GET', undefined, undefined, 401)
assert.deepEqual(await request('/api/tours', 'GET', undefined, as('agent_a')), { seen: [] })
await request('/api/tours/unknown', 'PUT', undefined, as('agent_a'), 404)
assert.deepEqual(await request('/api/tours/schedule', 'PUT', undefined, as('agent_a')), { seen: ['schedule'] })
assert.deepEqual(await request('/api/tours/schedule', 'PUT', undefined, as('agent_a')), { seen: ['schedule'] }, 'marking twice keeps one entry')
assert.deepEqual(await request('/api/tours', 'GET', undefined, as('agent_b')), { seen: [] }, 'per account')
// The calendar checks below drive these agents' pages directly.
await request('/api/tours/schedule', 'PUT', undefined, as('agent_b'))
console.log('PASS tours: once per account, unknown tours rejected')

// The calendar in three browsers: timelines with a window of hours across (a row
// per weekday, or per tech on one day) that is dragged sideways. Agents see their
// own by default, plan with Add, confirm overlaps, drag between techs, stretch
// sessions, look at one tech's week, and keep customers and their sessions in the
// 场次 tab; techs read their own and open the room; phones get the list. The device
// clock is set far from Shanghai on purpose.
const web = await createServer({ server: { host: '127.0.0.1', port: 55461, strictPort: true, proxy: { '/api': { target: API, changeOrigin: true, ws: true } } }, define: { 'import.meta.env.VITE_API_URL': JSON.stringify(API), 'import.meta.env.VITE_WS_URL': JSON.stringify(API.replace('http', 'ws')) }, logLevel: 'error' })
await web.listen()
const WEB = 'http://127.0.0.1:55461'
const openPage = async (browser, token, { mobile = false, lng = 'en' } = {}) => {
  const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: mobile ? 844 : 900 }, deviceScaleFactor: mobile ? 3 : 1, hasTouch: mobile, timezoneId: 'America/Los_Angeles' })
  await context.addInitScript(({ token, lng }) => { sessionStorage.setItem('sharecode-tab-auth', JSON.stringify({ state: { token }, version: 0 })); localStorage.setItem('i18nextLng', lng) }, { token, lng })
  const page = await context.newPage(), errors = []
  page.on('pageerror', e => errors.push(e.message))
  return { context, page, errors }
}
// The app's own date and time pickers (not the browser's): a month of days and a list of times.
const pickDate = async (page, trigger, key) => {
  assert.equal(await trigger.evaluate(el => el.tagName), 'BUTTON')
  await trigger.click()
  const picker = page.locator('.ui-date-picker')
  await picker.waitFor()
  for (let i = 0; i < 24; i++) {
    const shown = await picker.locator('[data-month]').getAttribute('data-month')
    if (shown === key.slice(0, 7)) break
    await picker.getByRole('button', { name: shown < key.slice(0, 7) ? 'Next' : 'Previous' }).click()
  }
  await picker.locator(`[data-date="${key}"]`).click()
  await picker.waitFor({ state: 'detached' })
  assert.equal(await trigger.getAttribute('data-value'), key)
}
const pickTime = async (page, trigger, time) => {
  await trigger.click()
  await page.locator(`.ui-time-picker [data-hour="${time.slice(0, 2)}"]`).click()
  await page.locator(`.ui-time-picker [data-minute="${time.slice(3)}"]`).click()
  await page.locator('.ui-time-picker').waitFor({ state: 'detached' })
  assert.equal(await trigger.getAttribute('data-value'), time)
}
const appointment = async appointmentId => (await request('/api/appointments/' + appointmentId, 'GET', undefined, as('agent_a'))).appointment
const fitsWidth = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const drag = async (page, from, to, steps = 8) => {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 3, from.y + 3, { steps: 2 })
  await page.mouse.move(to.x, to.y, { steps })
  await page.mouse.up()
}
try {
  for (const [index, [engine, type]] of Object.entries({ chromium, firefox, webkit }).entries()) {
    const browser = await type.launch()
    const uiDay = 20 + index * 2, day = at(uiDay, 0).slice(0, 10)
    const customerName = 'UI ' + engine
    // Waiting for a tech on the next day: the strip above the calendar lists it.
    const waiting = (await plan('agent_a', { customerId: li.id, startsAt: at(uiDay + 1, 14), durationMinutes: 60 })).appointment
    // Waiting on the day shown: its row shows it, so the strip does not list it again.
    const shown = (await plan('agent_a', { customerId: wang.id, startsAt: at(uiDay, 18), durationMinutes: 30 })).appointment
    // Another agent's: hidden while "Only mine" is on.
    const others = (await plan('agent_b', { customerId: li.id, startsAt: at(uiDay, 20), durationMinutes: 30 })).appointment
    // In an hour: on the tech's card above the room list, which covers two hours back to ten ahead.
    const today = (await plan('agent_a', { customerId: wang.id, techId: id('tech_b'), startsAt: new Date(Date.now() + 3600e3).toISOString(), durationMinutes: 30, company: 'Today ' + engine, allowConflicts: true })).appointment
    const booked = []
    try {
      // Agents: click free time, add the customer in place, confirm an overlap.
      const { context, page, errors } = await openPage(browser, as('agent_a'))
      // The schedule uses the full window width.
      const pageWidth = () => page.locator('main > div').evaluate(el => el.getBoundingClientRect().width)
      await page.goto(`${WEB}/schedule?view=day&date=${day}`)
      const column = name => page.locator(`[data-schedule-row][data-tech="${name ? id(name) : ''}"]`)
      // Where a Shanghai time on the day shown is on a row: rows span data-span minutes from the instant data-start.
      const pointAt = async (row, hour, minute = 0) => {
        if (typeof row === 'string') row = column(row)
        const box = await row.boundingBox()
        const start = Number(await row.getAttribute('data-start')), span = Number(await row.getAttribute('data-span'))
        return { x: box.x + ((Date.parse(at(uiDay, hour, minute)) - start) / (span * 60000)) * box.width, y: box.y + box.height / 2, minuteWidth: box.width / span }
      }
      await column('tech_a').waitFor()
      assert.equal(await pageWidth(), 1440)
      assert.equal(await column('').count(), 1, 'the day view has an unassigned row')
      await column('').locator(`[data-appointment="${shown.id}"]`).waitFor()
      const strip = page.locator('.schedule-unassigned')
      await strip.locator('.schedule-unassigned-list button').filter({ hasText: 'Li Si' }).waitFor()
      assert.equal(await strip.locator('.schedule-unassigned-list button').filter({ hasText: 'Wang Wu' }).filter({ hasText: '18:00' }).count(), 0, 'not listed twice')
      assert.equal(await strip.locator('.schedule-count').innerText(), String(await strip.locator('.schedule-unassigned-list button').count()), 'the count is what the strip lists')
      // Only mine: on by default for agents; off shows the other agents' sessions too.
      const onlyMine = page.getByRole('checkbox', { name: 'Only mine' })
      assert.equal(await onlyMine.getAttribute('aria-checked'), 'true')
      assert.equal(await page.locator(`[data-appointment="${others.id}"]`).count(), 0)
      await onlyMine.click()
      await column('').locator(`[data-appointment="${others.id}"]`).waitFor()
      await onlyMine.click()
      await page.locator(`[data-appointment="${others.id}"]`).waitFor({ state: 'detached' })
      // With Add on, a click plans an hour from the half hour.
      let point = await pointAt('tech_a', 10, 15)
      const add = page.getByRole('button', { name: 'Add', exact: true })
      await add.click()
      await page.mouse.click(point.x, point.y)
      let dialog = page.getByRole('dialog', { name: 'New session' })
      await dialog.waitFor()
      assert.deepEqual([await dialog.locator('#session-date').getAttribute('data-value'), await dialog.locator('#session-time').getAttribute('data-value')], [day, '10:00'])
      assert.match(await dialog.getByRole('combobox', { name: 'Tech' }).innerText(), /tech_a/)
      await dialog.getByRole('combobox', { name: 'Customer' }).fill(customerName)
      await dialog.getByRole('option', { name: `New customer “${customerName}”` }).click()
      const adding = dialog.getByRole('group', { name: 'New customer' })
      await adding.getByLabel('Contact').fill('ui@example.invalid')
      await adding.getByRole('button', { name: 'Add customer' }).click()
      await dialog.getByText(customerName, { exact: true }).waitFor()
      await dialog.getByLabel('Company').fill('Initech')
      let saved = page.waitForResponse(r => r.url().endsWith('/api/appointments') && r.request().method() === 'POST')
      await dialog.getByRole('button', { name: 'Create session' }).click()
      const first = (await (await saved).json()).appointment
      assert.deepEqual([first.tech.username, first.durationMinutes, first.company, first.customer.name, first.createdBy.username], ['tech_a', 60, 'Initech', customerName, 'agent_a'])
      assert.equal(Date.parse(first.startsAt), Date.parse(at(uiDay, 10)))
      await column('tech_a').locator(`[data-appointment="${first.id}"]`).waitFor()
      await dialog.waitFor({ state: 'hidden' })
      // The hours above the rows give the time; the session shows who and what.
      assert.doesNotMatch(await column('tech_a').locator(`[data-appointment="${first.id}"]`).innerText(), /\d:\d\d/)

      point = await pointAt('tech_a', 11, 15)
      await add.click()
      await page.mouse.click(point.x, point.y)
      dialog = page.getByRole('dialog', { name: 'New session' })
      await dialog.getByRole('combobox', { name: 'Customer' }).fill(customerName)
      await dialog.getByRole('option', { name: new RegExp('^' + customerName) }).click()
      await pickTime(page, dialog.locator('#session-time'), '10:30')
      saved = page.waitForResponse(r => r.url().endsWith('/api/appointments') && r.request().method() === 'POST')
      await dialog.getByRole('button', { name: 'Create session' }).click()
      assert.equal((await saved).status(), 409)
      const conflictBox = dialog.locator('.schedule-conflict')
      await conflictBox.getByText('This tech is already booked').waitFor()
      assert.match(await conflictBox.innerText(), new RegExp(`10:00–11:00 · ${customerName}`))
      // Changing the time drops the warning until the next save.
      await pickTime(page, dialog.locator('#session-time'), '10:45')
      await conflictBox.waitFor({ state: 'detached' })
      await pickTime(page, dialog.locator('#session-time'), '10:30')
      await dialog.getByRole('button', { name: 'Create session' }).click()
      await conflictBox.getByRole('button', { name: 'Save anyway' }).waitFor()
      saved = page.waitForResponse(r => r.url().endsWith('/api/appointments') && r.request().method() === 'POST')
      await conflictBox.getByRole('button', { name: 'Save anyway' }).click()
      const second = (await (await saved).json()).appointment
      assert.equal(second.hasConflict, true)
      await page.waitForFunction(selector => document.querySelectorAll(selector).length === 2, `[data-tech="${id('tech_a')}"] .schedule-event-conflict`)

      // Simultaneous sessions of a row take lanes, one under the other.
      const [firstBox, secondBox] = await Promise.all([first, second].map(a => page.locator(`[data-appointment="${a.id}"]`).boundingBox()))
      assert(secondBox.y >= firstBox.y + firstBox.height - 1, 'the overlap takes the next lane')

      // Drag the overlap down to the other tech, then stretch the first session by half an hour.
      const otherBox = await column('tech_b').boundingBox()
      saved = page.waitForResponse(r => r.url().endsWith('/api/appointments/' + second.id) && r.request().method() === 'PUT')
      await drag(page, { x: secondBox.x + 10, y: secondBox.y + secondBox.height / 2 }, { x: secondBox.x + 10, y: otherBox.y + otherBox.height / 2 })
      const moved = (await (await saved).json()).appointment
      assert.deepEqual([moved.tech.username, Date.parse(moved.startsAt), moved.hasConflict], ['tech_b', Date.parse(at(uiDay, 10, 30)), false])
      await column('tech_b').locator(`[data-appointment="${second.id}"]`).waitFor()
      await page.waitForFunction(selector => document.querySelectorAll(selector).length === 0, `[data-tech="${id('tech_a')}"] .schedule-event-conflict`)
      const handle = await column('tech_a').locator(`[data-appointment="${first.id}"] .schedule-event-resize`).boundingBox()
      saved = page.waitForResponse(r => r.url().endsWith('/api/appointments/' + first.id) && r.request().method() === 'PUT')
      await drag(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, { x: handle.x + handle.width / 2 + 30 * point.minuteWidth, y: handle.y + handle.height / 2 })
      assert.equal((await (await saved).json()).appointment.durationMinutes, 90)
      assert.equal((await appointment(first.id)).durationMinutes, 90)

      // A session waiting on another day goes to a tech by dropping it on their row at a time.
      const waitingItem = page.locator('.schedule-unassigned-list button').filter({ hasText: 'Li Si' }).filter({ hasText: '14:00' })
      const itemBox = await waitingItem.first().boundingBox()
      point = await pointAt('tech_b', 14)
      saved = page.waitForResponse(r => r.url().endsWith('/api/appointments/' + waiting.id) && r.request().method() === 'PUT')
      await drag(page, { x: itemBox.x + 20, y: itemBox.y + 10 }, { x: point.x + 2, y: point.y }, 12)
      const taken = (await (await saved).json()).appointment
      assert.deepEqual([taken.tech.username, Date.parse(taken.startsAt)], ['tech_b', Date.parse(at(uiDay, 14))])
      await column('tech_b').locator(`[data-appointment="${waiting.id}"]`).waitFor()

      // The customer link opens over the session, creates the tech's room and carries the name.
      await column('tech_b').locator(`[data-appointment="${waiting.id}"]`).click()
      const edit = page.getByRole('dialog', { name: 'Edit session' })
      await edit.waitFor()
      // No status, agent or "book another": deleting removes a session, and its creator is whoever planned it.
      for (const gone of ['Status', 'Agent in charge']) assert.equal(await edit.getByText(gone, { exact: true }).count(), 0, gone)
      assert.equal(await edit.getByRole('button', { name: 'Book another' }).count(), 0)
      await edit.getByLabel('Notes', { exact: true }).waitFor()
      await edit.getByRole('button', { name: 'Customer link' }).click()
      const linkDialog = page.getByRole('dialog', { name: 'Customer link for Li Si' })
      await linkDialog.waitFor()
      assert(page.url().includes('session=' + waiting.id), 'the session stays open')
      const linked = page.waitForResponse(r => r.url().includes('/share-links') && r.request().method() === 'POST')
      await linkDialog.getByRole('button', { name: 'Create edit link' }).click()
      assert.equal((await linked).status(), 201)
      await linkDialog.getByText(/\/s\/[\w-]+\?name=Li\+Si$/).waitFor()
      await page.keyboard.press('Escape')
      await linkDialog.waitFor({ state: 'hidden' })
      await edit.getByRole('button', { name: 'Open room' }).waitFor()
      const withRoom = await appointment(waiting.id)
      assert.equal((await request('/api/rooms/' + withRoom.room.id, 'GET', undefined, as('tech_b'))).room.owner.username, 'tech_b')
      await page.keyboard.press('Escape')
      await edit.waitFor({ state: 'hidden' })
      assert(!page.url().includes('session='))

      // The week: days down the page (not techs), hours across, opening on the week of the day shown.
      await page.getByRole('button', { name: 'Week', exact: true }).click()
      const rows = page.locator('[data-schedule-row]:not([data-tech])')
      await rows.locator(`[data-appointment="${first.id}"]`).waitFor()
      const inView = () => page.evaluate(() => {
        const view = document.querySelector('.schedule-days').getBoundingClientRect()
        return [...document.querySelectorAll('.schedule-days [data-schedule-row]')]
          .filter(row => { const box = row.getBoundingClientRect(); return box.bottom > view.top + 1 && box.top < view.bottom - 1 })
          .map(row => row.dataset.day)
      })
      const days = await inView()
      assert(days.includes(day) && days.length >= 5, days.join())
      days.slice(1).forEach((key, i) => assert.equal(Date.parse(key) - Date.parse(days[i]), 864e5, 'one day after another'))
      const scroller = page.locator('[data-schedule-scroll]')
      const fits = () => scroller.evaluate(el => el.scrollWidth <= el.clientWidth + 1)
      assert(await fits(), 'the week fits the page')
      await page.setViewportSize({ width: 1280, height: 800 })
      assert.equal(await pageWidth(), 1280)
      assert(await fits(), 'and on a smaller screen')
      // A tablet-wide window still shows the working day without a scrollbar.
      await page.setViewportSize({ width: 1024, height: 768 })
      assert(await fits(), 'no scrollbar under the timeline')
      assert(await fitsWidth(page), 'no sideways scrolling of the page')
      await page.setViewportSize({ width: 1440, height: 900 })
      // Dragging free space moves the hours; past midnight a dashed line marks the day's turn.
      const shownRow = rows.and(page.locator(`[data-day="${(await inView())[1]}"]`))
      const lastBox = await shownRow.boundingBox()
      const free = await shownRow.evaluate(row => {
        const rect = row.getBoundingClientRect()
        for (let x = rect.right - 20; x > rect.left; x -= 10) if (document.elementFromPoint(x, rect.top + 6) === row) return x
      })
      await drag(page, { x: free, y: lastBox.y + 6 }, { x: free - lastBox.width * 0.6, y: lastBox.y + 6 })
      assert.equal(await page.locator('.schedule-line.is-midnight').count(), 1)
      // Each day names the day that begins at the dashed line.
      const nextDay = new Date(Date.parse(await shownRow.getAttribute('data-day')) + 864e5)
      assert.match(await shownRow.locator('.schedule-midnight-date').innerText(), new RegExp(`\\b${nextDay.getUTCMonth() + 1}/${nextDay.getUTCDate()}\\b`))
      // The days move on without end and without a scrollbar; Reset brings back today's week and the usual hours.
      const top = days[0]
      await page.mouse.move(free, lastBox.y + 6)
      for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 500)
      await page.waitForFunction(top => {
        const view = document.querySelector('.schedule-days').getBoundingClientRect()
        const first = [...document.querySelectorAll('.schedule-days [data-schedule-row]')].find(row => row.getBoundingClientRect().bottom > view.top + 1)
        return first && first.dataset.day > top
      }, top)
      assert.equal(await scroller.evaluate(el => getComputedStyle(el).overflowY), 'clip')
      await page.getByRole('button', { name: 'Reset', exact: true }).click()
      await page.locator('.schedule-hour').first().filter({ hasText: /^08:00$/ }).waitFor()

      // 场次: customers on the left, the chosen customer's sessions on the right.
      await page.getByRole('tab', { name: 'Sessions' }).click()
      await page.getByLabel('Search customers').fill(customerName)
      const entry = page.locator('.schedule-customer').filter({ hasText: customerName })
      await entry.waitFor()
      // The search is debounced: wait until the list holds only the match.
      await page.waitForFunction(() => document.querySelectorAll('.schedule-customer:not(.schedule-customer-all)').length === 1)
      assert.match(await entry.innerText(), /ui@example\.invalid/)
      await entry.click()
      const pane = page.locator('.schedule-session-pane')
      await pane.getByRole('heading', { name: customerName }).waitFor()
      await pane.locator('.schedule-agenda-item').nth(1).waitFor()
      assert.equal(await pane.locator('.schedule-agenda-item').count(), 2)
      await pane.getByRole('button', { name: 'Edit customer' }).click()
      const profile = page.getByRole('dialog', { name: 'Edit customer' })
      assert.equal(await profile.getByLabel('Contact').inputValue(), 'ui@example.invalid')
      await page.keyboard.press('Escape')
      await profile.waitFor({ state: 'hidden' })

      // A new session from the customer's page: the customer is chosen already.
      await pane.getByRole('button', { name: 'New session' }).click()
      const another = page.getByRole('dialog', { name: `New session for ${customerName}` })
      await another.waitFor()
      assert.equal(await another.getByRole('combobox', { name: 'Customer' }).count(), 0, 'no customer field')
      await pickDate(page, another.locator('#session-date'), at(uiDay + 1, 0).slice(0, 10))
      await pickTime(page, another.locator('#session-time'), '10:00')
      await another.getByLabel('Company').fill('Initech')
      await another.getByRole('combobox', { name: 'Tech' }).click()
      await page.getByRole('option', { name: 'tech_a', exact: true }).click()
      saved = page.waitForResponse(r => r.url().endsWith('/api/appointments') && r.request().method() === 'POST')
      await another.getByRole('button', { name: 'Create session' }).click()
      const again = (await (await saved).json()).appointment
      booked.push(again)
      assert.deepEqual([again.customer.id, again.tech.username, again.durationMinutes, again.company, Date.parse(again.startsAt), again.createdBy.username],
        [first.customer.id, 'tech_a', 60, 'Initech', Date.parse(at(uiDay + 1, 10)), 'agent_a'])
      await pane.locator('.schedule-agenda-item').nth(2).waitFor()

      // A new customer from the list's add button, then removed from the pane above their sessions.
      await page.getByRole('button', { name: 'New customer' }).click()
      const created = page.getByRole('dialog', { name: 'New customer' })
      await created.getByLabel('Name').fill('Temp ' + engine)
      await created.getByRole('button', { name: 'Save' }).click()
      await pane.getByRole('heading', { name: 'Temp ' + engine }).waitFor()
      await pane.getByText('No upcoming sessions.').waitFor()
      await pane.getByRole('button', { name: 'Delete customer' }).click()
      await page.getByRole('dialog', { name: `Delete Temp ${engine}?` }).getByRole('button', { name: 'Delete' }).click()
      await pane.getByRole('heading', { name: 'All sessions' }).waitFor()
      // The calendar can be viewed in a customer's zone; the 场次 tab and the rest keep Shanghai.
      const abroad = (await plan('agent_a', { customerId: wang.id, techId: id('tech_a'), startsAt: at(uiDay + 3, 21), durationMinutes: 60, allowConflicts: true })).appointment
      booked.push(abroad)
      const inZone = (instant, timeZone) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant)).map(part => [part.type, part.value]))
      const eastern = inZone(abroad.startsAt, 'America/New_York')
      const easternDay = `${eastern.year}-${eastern.month}-${eastern.day}`
      await page.goto(`${WEB}/schedule?view=day&date=${easternDay}`)
      const abroadCard = column('tech_a').locator(`[data-appointment="${abroad.id}"]`)
      await abroadCard.waitFor()
      // Switching the zone keeps every session in place; only the hours above change.
      const cardBefore = await abroadCard.boundingBox()
      await page.getByRole('combobox', { name: 'Time zone' }).click()
      await page.getByRole('option', { name: 'Eastern Time' }).click()
      await page.locator('.schedule-hour').filter({ hasText: new RegExp(`^${eastern.hour}:00$`) }).waitFor()
      assert(Math.abs((await abroadCard.boundingBox()).x - cardBefore.x) < 1, 'the session stays in place')
      // The legend names the agents whose customers have sessions in view (one color each); the day view keeps a row for every tech.
      const legendNames = (await page.locator('.schedule-legend-item').allInnerTexts()).map(text => text.trim())
      assert(legendNames.includes('audit_admin') && legendNames.every(name => ['agent_a', 'agent_b', 'audit_admin'].includes(name)), legendNames.join())
      assert.equal(await column('tech_b').count(), 1)
      assert.match(await abroadCard.innerText(), /tech_a[\s\S]*audit_admin|audit_admin/)
      await abroadCard.click()
      let form = page.getByRole('dialog', { name: 'Edit session' })
      await form.waitFor()
      const zoneField = form.getByRole('combobox', { name: 'Time zone' })
      assert.equal(await form.locator('#session-time').getAttribute('data-value'), `${eastern.hour}:${eastern.minute}`)
      assert.equal((await zoneField.innerText()).trim(), 'Eastern Time', 'the form opens in the calendar zone')
      // Switching the form's zone shows the same moment in that zone.
      await zoneField.click()
      await page.getByRole('option', { name: 'United Kingdom Time' }).click()
      const british = inZone(abroad.startsAt, 'Europe/London')
      assert.deepEqual([await form.locator('#session-date').getAttribute('data-value'), await form.locator('#session-time').getAttribute('data-value')], [`${british.year}-${british.month}-${british.day}`, `${british.hour}:${british.minute}`])
      await page.keyboard.press('Escape')
      await form.waitFor({ state: 'hidden' })
      // The 场次 tab shows the same session in Shanghai time.
      await page.goto(`${WEB}/schedule?tab=sessions&tz=America/New_York&session=${abroad.id}`)
      form = page.getByRole('dialog', { name: 'Edit session' })
      await form.waitFor()
      assert.equal(await form.locator('#session-time').getAttribute('data-value'), '21:00')
      assert.equal((await form.getByRole('combobox', { name: 'Time zone' }).innerText()).trim(), 'China Standard Time')
      await page.keyboard.press('Escape')
      await form.waitFor({ state: 'hidden' })
      // A new session entered in a customer's zone is saved at that moment.
      await page.getByRole('button', { name: 'New session', exact: true }).first().click()
      form = page.getByRole('dialog', { name: 'New session' })
      await form.waitFor()
      await form.locator('#session-customer').fill('Wang')
      await page.getByRole('option', { name: /Wang Wu/ }).click()
      await form.getByRole('combobox', { name: 'Time zone' }).click()
      await page.getByRole('option', { name: 'Pacific Time' }).click()
      const pacificDay = at(uiDay + 4, 0).slice(0, 10)
      // Arrow keys move through the days; Enter picks one.
      await form.locator('#session-date').click()
      const startDay = await form.locator('#session-date').getAttribute('data-value')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Enter')
      const plusEight = new Date(Date.parse(startDay + 'T00:00:00Z') + 8 * 864e5).toISOString().slice(0, 10)
      assert.equal(await form.locator('#session-date').getAttribute('data-value'), plusEight)
      await pickDate(page, form.locator('#session-date'), pacificDay)
      await pickTime(page, form.locator('#session-time'), '09:30')
      const pacificSaved = page.waitForResponse(response => response.url().endsWith('/api/appointments') && response.request().method() === 'POST')
      await form.getByRole('button', { name: 'Create session' }).click()
      const pacific = (await (await pacificSaved).json()).appointment
      booked.push(pacific)
      const pacificParts = inZone(pacific.startsAt, 'America/Los_Angeles')
      assert.deepEqual([`${pacificParts.year}-${pacificParts.month}-${pacificParts.day}`, `${pacificParts.hour}:${pacificParts.minute}`], [pacificDay, '09:30'])
      await form.waitFor({ state: 'hidden' })
      // New rooms use the same date, start and length fields.
      await page.goto(`${WEB}/rooms`)
      await page.getByRole('button', { name: 'Create New Room' }).first().click()
      const roomForm = page.getByRole('dialog')
      await roomForm.locator('#roomName').fill('Fields ' + engine)
      await pickDate(page, roomForm.locator('#room-date'), pacificDay)
      await pickTime(page, roomForm.locator('#room-time'), '14:00')
      await roomForm.getByRole('combobox', { name: 'Duration' }).click()
      await page.getByRole('option', { name: '1 h 30 min' }).click()
      await roomForm.locator('button[type=submit]').click()
      await page.waitForURL('**/room/**')
      const createdRoom = (await request('/api/rooms/' + page.url().split('/room/')[1].split(/[?#]/)[0], 'GET', undefined, as('agent_a'))).room
      assert.equal(Date.parse(createdRoom.scheduledTime), Date.parse(`${pacificDay}T14:00:00+08:00`), 'room times are China time')
      assert.equal(createdRoom.duration, 90)
      await page.screenshot({ path: `/tmp/sharecode-schedule-agent-${engine}.png` })
      assert.deepEqual(errors, [])
      await context.close()

      // Techs: their own sessions only, read-only, and their room one click away.
      {
        const { context, page, errors } = await openPage(browser, as('tech_b'))
        await page.goto(`${WEB}/rooms`)
        const card = page.getByRole('region', { name: /Today's sessions/ })
        await card.getByText('Today ' + engine).waitFor()
        await page.locator('[data-sonner-toast]').filter({ hasText: /schedule update|New session/ }).first().waitFor()
        await page.goto(`${WEB}/schedule?view=week&date=${at(uiDay + 1, 0).slice(0, 10)}`)
        await page.locator(`[data-appointment="${waiting.id}"]`).waitFor()
        assert.equal(await page.locator(`[data-appointment="${first.id}"]`).count(), 0, "another tech's session")
        assert.equal(await page.locator('.ui-tour').count(), 0, 'techs get no tour')
        assert.equal(await page.locator('.schedule-event-resize, .schedule-track.is-editable').count(), 0)
        await page.locator(`[data-appointment="${waiting.id}"]`).click()
        const details = page.getByRole('dialog', { name: 'Li Si' })
        await details.waitFor()
        assert.equal(await details.getByRole('button', { name: 'Save' }).count(), 0)
        assert.equal(await details.getByRole('textbox').count(), 0)
        assert.equal(await details.getByText('Contact', { exact: true }).count(), 0, 'customer contacts stay with agents')
        await details.getByRole('button', { name: 'Open room' }).click()
        await page.waitForURL('**/room/' + withRoom.room.id)
        await page.locator('.monaco-editor').waitFor()
        assert.deepEqual(errors, [])
        await context.close()
      }

      // Phones: the list is the default, for techs and agents, in Chinese.
      for (const actor of ['tech_b', 'agent_a']) {
        const { context, page, errors } = await openPage(browser, as(actor), { mobile: true, lng: 'zh' })
        await page.goto(`${WEB}/schedule?date=${day}`)
        assert.equal(await page.getByRole('button', { name: '列表', exact: true }).getAttribute('aria-pressed'), 'true')
        await page.locator(`.schedule-agenda-item`).first().waitFor()
        // tech_b: the moved overlap and the session taken from the strip; agents: every session planned here.
        assert.equal(await page.locator('.schedule-agenda-item').count(), actor === 'tech_b' ? 2 : [first, second, waiting, shown, ...booked].length)
        assert(await fitsWidth(page), 'no sideways scrolling')
        if (actor === 'agent_a') {
          await page.getByRole('button', { name: '添加', exact: true }).click()
          const form = page.getByRole('dialog', { name: '新建场次' })
          await form.waitFor()
          assert(await form.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
          await page.keyboard.press('Escape')
          await form.waitFor({ state: 'hidden' })
          // 场次 on a phone: the customer list, then one customer's sessions with a way back.
          await page.getByRole('tab', { name: '场次' }).click()
          await page.locator('.schedule-customer').filter({ hasText: customerName }).click()
          await page.locator('.schedule-session-pane .schedule-agenda-item').first().waitFor()
          assert(!(await page.locator('.schedule-customer-pane').isVisible()), 'one side at a time')
          assert(await fitsWidth(page), 'no sideways scrolling')
          await page.getByRole('button', { name: '客户', exact: true }).click()
          await page.locator('.schedule-customer-pane').waitFor()
        }
        await page.screenshot({ path: `/tmp/sharecode-schedule-${actor}-mobile-${engine}.png` })
        assert.deepEqual(errors, [])
        await context.close()
      }
      // A new agent gets the tour once: every step points at its part of the page, with
      // Back, Next and Skip, and the page returns to where it was.
      for (const [mode, mobile, lng] of [['walk', false, 'en'], ['skip', true, 'zh']]) {
        const username = `tour_${mode}_${engine}`
        await request('/api/admin/users', 'POST', { username, role: 'agent', password }, root, 201)
        const token = (await login(username)).token
        const { context, page, errors } = await openPage(browser, token, { mobile, lng })
        await page.goto(`${WEB}/schedule?date=${day}`)
        const card = page.locator('.ui-tour-card')
        const spotlit = async target => {
          await page.locator(`[data-tour="${target}"]`).waitFor()
          await page.waitForFunction(target => {
            const spot = document.querySelector('.ui-tour-spotlight')?.getBoundingClientRect()
            const box = document.querySelector(`[data-tour="${target}"]`)?.getBoundingClientRect()
            return !!spot && !!box && spot.left <= box.left && spot.top <= Math.max(box.top, 0)
              && spot.right >= box.right && spot.bottom >= Math.min(box.bottom, window.innerHeight)
          }, target)
        }
        const progress = text => card.getByText(text, { exact: true }).waitFor()
        await progress('1 / 7')
        if (mode === 'walk') {
          await card.getByRole('heading', { name: 'New customer' }).waitFor()
          await spotlit('customer-add')
          assert.equal(new URL(page.url()).searchParams.get('tab'), 'sessions')
          assert.equal(await card.getByRole('button', { name: 'Back' }).count(), 0, 'no Back on the first step')
          await page.keyboard.press('Enter')
          await progress('2 / 7')
          await spotlit('customer-list')
          await card.getByRole('button', { name: 'Back' }).click()
          await progress('1 / 7')
          for (const [step, target] of [[2, 'customer-list'], [3, 'session-add'], [4, 'new-session'], [5, 'calendar'], [6, 'tech-filter'], [7, 'only-mine']]) {
            await card.getByRole('button', { name: 'Next' }).click()
            await progress(`${step} / 7`)
            await spotlit(target)
            if (step === 5) assert.equal(new URL(page.url()).searchParams.get('view'), 'week')
          }
          // The page underneath does not take clicks while the tour is open.
          const onlyMineBox = await page.locator('[data-tour="only-mine"]').boundingBox()
          await page.mouse.click(onlyMineBox.x + 5, onlyMineBox.y + onlyMineBox.height / 2)
          assert.equal(await page.getByRole('checkbox', { name: 'Only mine' }).getAttribute('data-state'), 'checked')
          await card.getByRole('button', { name: 'Done' }).click()
        } else {
          await card.getByRole('heading', { name: '新建客户' }).waitFor()
          await spotlit('customer-add')
          await card.getByRole('button', { name: '下一步' }).click()
          await progress('2 / 7')
          await card.getByRole('button', { name: '跳过' }).click()
        }
        await card.waitFor({ state: 'detached' })
        const params = new URL(page.url()).searchParams
        assert.deepEqual([params.get('tab'), params.get('view'), params.get('customer'), params.get('date')], [null, null, null, day], 'the page is back where it was')
        assert.deepEqual(await request('/api/tours', 'GET', undefined, token), { seen: ['schedule'] })
        // Shown once: reloading does not bring it back.
        const tours = page.waitForResponse(response => response.url().endsWith('/api/tours'))
        await page.reload()
        await tours
        await page.locator('.schedule-toolbar').waitFor()
        await page.waitForTimeout(300)
        assert.equal(await page.locator('.ui-tour').count(), 0)
        assert(await fitsWidth(page), 'no sideways scrolling')
        assert.deepEqual(errors, [])
        await context.close()
      }
      for (const session of [first, second, waiting, shown, others, today, ...booked]) await request('/api/appointments/' + session.id, 'DELETE', undefined, as('agent_a'))
      console.log('PASS', engine, 'full-width timelines colored by agent: only mine by default, Add to plan, the day dragged through the days and the week scrolled without end, dates at the dashed midnight, Reset, inline customer, overlap lanes and confirmation, drag to another tech, resize, unassigned strip without repeats, no status or agent; 场次: customers and their sessions, new session for a customer, customer add/delete; tech read-only with room and the next hours on the room list; phone list and 场次; the agent tour once (walk with Back/Next, skip on a phone); calendar in Eastern Time (same window, other hours) while 场次 keeps Shanghai; session form zone switch; room form time row; legend of agents in view; EN/ZH')
    } finally { await browser.close() }
  }
} finally { await web.close() }
