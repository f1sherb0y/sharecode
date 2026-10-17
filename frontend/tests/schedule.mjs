// 排班: shared customer profiles and the sessions agents plan for techs, over the
// API and in the calendar. Run with scripts/test-runner-local.sh; all accounts,
// customers and sessions are disposable.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
const edited = (await request('/api/customers/' + li.id, 'PUT', { contact: 'tel 123' }, as('agent_a'))).customer
assert.equal(edited.contact, 'tel 123'); assert.equal(edited.name, 'Li Si')
assert.equal((await request('/api/customers/' + li.id, 'PUT', { contact: null }, as('agent_b'))).customer.contact, null)
await request('/api/customers/' + li.id, 'PUT', { name: '' }, as('agent_b'), 400)
console.log('PASS customers: shared by agents and admins, hidden from techs, literal search, paging, partial edits')

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
await plan('agent_a', { customerId: zhang.id, startsAt: at(1, 10), status: 'done' }, 400)
await plan('agent_a', { customerId: zhang.id, startsAt: at(1, 10), techId: 'nobody' }, 400)
await plan('agent_a', { customerId: zhang.id, startsAt: at(1, 10), agentId: id('tech_b') }, 400)
await plan('agent_a', { customerId: 'missing', startsAt: at(1, 10) }, 400)
const first = (await plan('agent_a', {
  customerId: zhang.id, techId: id('tech_a'), startsAt: at(1, 10).replace(':00+', ':59+'), durationMinutes: 60,
  company: ' Acme ', position: 'Backend', notes: 'Bring the take-home',
})).appointment
assert.equal(first.startsAt, new Date(at(1, 10)).toISOString().replace('.000Z', '+00:00'), 'start times are kept to the minute')
assert.equal(Date.parse(first.endsAt) - Date.parse(first.startsAt), 60 * 60e3)
assert.deepEqual([first.status, first.company, first.tech.username, first.agent.username, first.customer.notes, first.hasConflict, first.room], ['scheduled', 'Acme', 'tech_a', 'agent_a', 'Prefers evenings', false, null])
const unassigned = (await plan('agent_b', { customerId: li.id, startsAt: at(2, 14), durationMinutes: 90, agentId: null })).appointment
assert.equal(unassigned.tech, null); assert.equal(unassigned.agent, null)
const techB = (await plan('root', { customerId: wang.id, techId: id('tech_b'), startsAt: at(1, 10), durationMinutes: 45 })).appointment
assert.equal(techB.agent.username, 'audit_admin', 'the planner is the default agent')
// Techs see only their own sessions, without the customer's profile: no contact, no private notes.
const techView = await list('tech_a')
assert.deepEqual(techView.map(a => a.id), [first.id])
assert.deepEqual(Object.keys(techView[0].customer).sort(), ['id', 'isDeleted', 'name']); assert.equal(techView[0].notes, 'Bring the take-home')
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
// A range returns the sessions overlapping it, including one that started before.
assert.deepEqual((await list('agent_a', `from=${encodeURIComponent(at(1, 10, 30))}&to=${encodeURIComponent(at(1, 10, 40))}`)).map(a => a.id).sort(), [first.id, techB.id].sort())
assert.deepEqual(await list('agent_a', `from=${encodeURIComponent(at(1, 11))}&to=${encodeURIComponent(at(1, 12))}`), [])
console.log('PASS sessions: validation, defaults, minute precision, staff-only planning, techs read only their own, range and filters')

// Overlaps for one tech need confirmation; back-to-back and cancelled sessions do not.
const overlap = await plan('agent_b', { customerId: li.id, techId: id('tech_a'), startsAt: at(1, 10, 30), durationMinutes: 60 }, 409)
assert.equal(overlap.error, 'Schedule conflict')
assert.deepEqual(overlap.conflicts.map(c => [c.id, c.customer.name]), [[first.id, '张三']])
await plan('agent_b', { customerId: li.id, techId: id('tech_a'), startsAt: at(1, 11), durationMinutes: 30 })
await plan('agent_b', { customerId: li.id, techId: id('tech_a'), startsAt: at(1, 9, 30), durationMinutes: 30, status: 'cancelled' })
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
console.log('PASS conflicts: overlaps need confirmation, back-to-back/cancelled are free, saved overlaps flagged, racing planners serialized')

// Techs are told about their own sessions still to come, never about past ones.
const firstNotices = await notices('tech_a')
const assigned = firstNotices.find(n => n.kind === 'schedule.assigned' && n.data.appointmentId === first.id)
assert(assigned, 'assignment notice')
assert.deepEqual([assigned.data.customerName, assigned.data.durationMinutes, assigned.data.company, assigned.createdBy.username], ['张三', 60, 'Acme', 'agent_a'])
assert.equal(firstNotices.filter(n => n.kind === 'schedule.assigned').length, 3, 'two sessions plus the overlap saved on purpose; not the cancelled one')
assert.deepEqual(await notices('agent_a'), [], 'personal notices reach only their recipient')
assert.deepEqual(await notices('tech_b').then(n => n.map(x => x.data.appointmentId)).then(ids => ids.includes(first.id)), false)
await plan('agent_a', { customerId: zhang.id, techId: id('tech_b'), startsAt: at(-2, 9), durationMinutes: 60 })
assert.equal((await notices('tech_b')).filter(n => n.kind === 'schedule.assigned').length, 2, 'no notice for a past session')
await request('/api/notifications/read-all', 'POST', {}, as('tech_a'))
assert.deepEqual(await notices('tech_a'), [])
// Moving, reassigning and cancelling each tell the techs concerned.
await request('/api/appointments/' + first.id, 'PUT', { startsAt: at(1, 16), notes: 'Moved' }, as('agent_b'))
const moved = (await notices('tech_a')).find(n => n.kind === 'schedule.updated')
assert.deepEqual([moved.data.previousStartsAt, moved.data.startsAt, moved.data.changes], [first.startsAt, new Date(at(1, 16)).toISOString().replace('.000Z', '+00:00'), ['time', 'notes']])
await request('/api/appointments/' + first.id, 'PUT', { status: 'completed' }, as('agent_b'))
await request('/api/appointments/' + first.id, 'PUT', { status: 'scheduled' }, as('agent_b'))
await request('/api/appointments/' + unassigned.id, 'PUT', { techId: id('tech_a') }, as('agent_b'))
await request('/api/appointments/' + unassigned.id, 'PUT', { techId: id('tech_b') }, as('agent_b'))
await request('/api/appointments/' + doubled.id, 'PUT', { status: 'cancelled' }, as('agent_b'))
await request('/api/appointments/' + doubled.id, 'DELETE', undefined, as('agent_b'))
await request('/api/appointments/' + doubled.id, 'DELETE', undefined, as('agent_b'), 404)
const techANotices = (await notices('tech_a')).map(n => [n.kind, n.data.appointmentId]).reverse()
assert.deepEqual(techANotices, [
  ['schedule.updated', first.id], ['schedule.assigned', first.id], ['schedule.assigned', unassigned.id],
  ['schedule.unassigned', unassigned.id], ['schedule.cancelled', doubled.id],
], 'deleting a cancelled session tells nobody again')
const reassigned = (await notices('tech_b')).find(n => n.kind === 'schedule.assigned' && n.data.appointmentId === unassigned.id)
assert.equal(reassigned.data.customerName, 'Li Si')
// Saving the form unchanged writes, notifies and records nothing.
const unchanged = (await request('/api/appointments/' + first.id, 'GET', undefined, as('agent_b'))).appointment
const updateEvents = () => sql(`SELECT count(*) FROM "AuditEvent" WHERE action = 'appointment.updated'`)
const eventsBefore = updateEvents()
const resaved = (await request('/api/appointments/' + first.id, 'PUT', {
  customerId: unchanged.customer.id, techId: unchanged.tech.id, agentId: unchanged.agent.id, startsAt: unchanged.startsAt,
  durationMinutes: unchanged.durationMinutes, company: unchanged.company, position: unchanged.position, notes: unchanged.notes, status: unchanged.status,
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
console.log('PASS notices: assigned/changed/reassigned/cancelled reach the techs concerned for upcoming sessions only; per-notice read state')

// A session's room belongs to its tech and follows the session.
await request(`/api/appointments/${first.id}/room`, 'POST', {}, as('tech_b'), 404)
await request(`/api/appointments/${first.id}/room`, 'POST', { language: 'cobol' }, as('tech_a'), 400)
const opened = await request(`/api/appointments/${first.id}/room`, 'POST', { language: 'python' }, as('tech_a'), 201)
assert.equal(opened.created, true)
assert.deepEqual([opened.room.owner.username, opened.room.language, opened.room.name, opened.room.company, opened.room.position, opened.room.duration], ['tech_a', 'python', '张三 · Acme Backend', 'Acme', 'Backend', 60])
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
// Moving the session moves its room; a new tech takes the room over.
await request('/api/appointments/' + first.id, 'PUT', { startsAt: at(1, 17), durationMinutes: 90, company: 'Globex' }, as('agent_a'))
let room = (await request('/api/rooms/' + opened.room.id, 'GET', undefined, as('agent_a'))).room
assert.deepEqual([Date.parse(room.scheduledTime), room.duration, room.company], [Date.parse(at(1, 17)), 90, 'Globex'])
await request('/api/appointments/' + first.id, 'PUT', { techId: id('tech_b') }, as('agent_a'))
room = (await request('/api/rooms/' + opened.room.id, 'GET', undefined, as('tech_b'))).room
assert.equal(room.owner.username, 'tech_b'); assert.equal(room.canEdit, true)
await request('/api/rooms/' + opened.room.id, 'GET', undefined, as('tech_a'), 404)
await request(`/api/appointments/${first.id}/room`, 'POST', {}, as('tech_a'), 404)
assert.equal(sql(`SELECT count(*) FROM "RoomParticipant" WHERE "roomId" = ${literal(opened.room.id)} AND "userId" = ${literal(id('tech_a'))}`), '0')
// An unassigned session's room belongs to the staff member who opens it, until a tech is assigned.
const later = (await plan('agent_a', { customerId: wang.id, startsAt: at(4, 9), durationMinutes: 30 })).appointment
const staffRoom = await request(`/api/appointments/${later.id}/room`, 'POST', {}, as('agent_b'), 201)
assert.equal(staffRoom.room.owner.username, 'agent_b')
await request('/api/appointments/' + later.id, 'PUT', { techId: id('tech_a') }, as('agent_a'))
assert.equal((await request('/api/rooms/' + staffRoom.room.id, 'GET', undefined, as('tech_a'))).room.owner.username, 'tech_a')
// Ending the room completes the session; a new room can replace an ended one.
await request(`/api/rooms/${opened.room.id}/end`, 'POST', undefined, as('tech_b'))
let session = (await request('/api/appointments/' + first.id, 'GET', undefined, as('tech_b'))).appointment
assert.deepEqual([session.status, session.room.isEnded], ['completed', true])
assert.equal((await request(`/api/appointments/${first.id}/room`, 'POST', {}, as('tech_b'))).room.id, opened.room.id, 'the ended room opens for replay')
const replaced = await request(`/api/appointments/${first.id}/room`, 'POST', { replace: true }, as('tech_b'), 201)
assert.notEqual(replaced.room.id, opened.room.id)
assert.deepEqual([replaced.appointment.status, replaced.room.owner.username], ['scheduled', 'tech_b'])
assert.equal((await request('/api/rooms/' + opened.room.id, 'GET', undefined, as('tech_b'))).room.isEnded, true, 'the old room stays with its history')
// A session marked completed by hand reopens when it gets a new room.
await request(`/api/rooms/${replaced.room.id}/end`, 'POST', undefined, as('tech_b'))
assert.equal((await request('/api/appointments/' + first.id, 'PUT', { status: 'completed' }, as('agent_a'))).appointment.status, 'completed')
const reopenedRoom = await request(`/api/appointments/${first.id}/room`, 'POST', { replace: true }, as('tech_b'), 201)
assert.equal(reopenedRoom.appointment.status, 'scheduled')
assert.equal(sql(`SELECT status FROM "Appointment" WHERE id = ${literal(first.id)}`), 'scheduled')
await request(`/api/appointments/${doubled.id}/room`, 'POST', {}, as('agent_a'), 404)
const cancelledSession = (await plan('agent_a', { customerId: wang.id, techId: id('tech_a'), startsAt: at(5, 9), status: 'cancelled' })).appointment
await request(`/api/appointments/${cancelledSession.id}/room`, 'POST', {}, as('agent_a'), 400)
console.log('PASS session rooms: owned by the tech, idempotent, time/company sync, links last the session, reassignment moves ownership, end completes, replace')

// Customers with sessions to come stay until those are moved or cancelled; history keeps their name.
await request('/api/customers/' + zhang.id, 'DELETE', undefined, as('agent_b'), 409)
const history = await request('/api/customers/' + zhang.id, 'GET', undefined, as('agent_b'))
assert(history.appointments.some(a => a.id === first.id))
assert.equal(history.customer.upcomingCount, 1)
await request('/api/appointments/' + first.id, 'PUT', { status: 'cancelled' }, as('agent_b'))
for (const a of await list('agent_b', range(-30, 60) + '&customerId=' + zhang.id)) {
  if (a.status === 'scheduled' && Date.parse(a.endsAt) > Date.now()) await request('/api/appointments/' + a.id, 'PUT', { status: 'cancelled' }, as('agent_b'))
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

// The calendar in three browsers: agents plan by clicking free time, confirm overlaps,
// drag between techs and stretch sessions; techs read their own and open the room;
// phones get the list. The device clock is set far from Shanghai on purpose.
const web = await createServer({ server: { host: '127.0.0.1', port: 55461, strictPort: true, proxy: { '/api': { target: API, changeOrigin: true, ws: true } } }, define: { 'import.meta.env.VITE_API_URL': JSON.stringify(API), 'import.meta.env.VITE_WS_URL': JSON.stringify(API.replace('http', 'ws')) }, logLevel: 'error' })
await web.listen()
const WEB = 'http://127.0.0.1:55461'
const HOUR = 48
const openPage = async (browser, token, { mobile = false, lng = 'en' } = {}) => {
  const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: mobile ? 844 : 900 }, deviceScaleFactor: mobile ? 3 : 1, hasTouch: mobile, timezoneId: 'America/Los_Angeles' })
  await context.addInitScript(({ token, lng }) => { sessionStorage.setItem('sharecode-tab-auth', JSON.stringify({ state: { token }, version: 0 })); localStorage.setItem('i18nextLng', lng) }, { token, lng })
  const page = await context.newPage(), errors = []
  page.on('pageerror', e => errors.push(e.message))
  return { context, page, errors }
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
    const waiting = (await plan('agent_a', { customerId: li.id, startsAt: at(uiDay, 14), durationMinutes: 60 })).appointment
    const today = (await plan('agent_a', { customerId: wang.id, techId: id('tech_b'), startsAt: at(0, 0, 5), durationMinutes: 30, company: 'Today ' + engine, allowConflicts: true })).appointment
    try {
      // Agents: click free time, add the customer in place, confirm an overlap.
      const { context, page, errors } = await openPage(browser, as('agent_a'))
      await page.goto(`${WEB}/schedule?view=day&date=${day}`)
      const column = name => page.locator(`[data-schedule-column][data-tech="${name ? id(name) : ''}"]`)
      await column('tech_a').waitFor()
      assert.equal(await column('').count(), 1, 'the day view has an unassigned column')
      let box = await column('tech_a').boundingBox()
      await page.mouse.click(box.x + box.width / 2, box.y + 10 * HOUR + 12)
      let dialog = page.getByRole('dialog', { name: 'New session' })
      await dialog.waitFor()
      assert.deepEqual([await dialog.getByLabel('Date').inputValue(), await dialog.getByLabel('Start').inputValue()], [day, '10:00'])
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
      assert.deepEqual([first.tech.username, first.durationMinutes, first.company, first.customer.name, first.agent.username], ['tech_a', 60, 'Initech', customerName, 'agent_a'])
      assert.equal(Date.parse(first.startsAt), Date.parse(at(uiDay, 10)))
      await column('tech_a').locator(`[data-appointment="${first.id}"]`).waitFor()
      await dialog.waitFor({ state: 'hidden' })

      box = await column('tech_a').boundingBox()
      await page.mouse.click(box.x + box.width / 2, box.y + 11 * HOUR + 12)
      dialog = page.getByRole('dialog', { name: 'New session' })
      await dialog.getByLabel('Start').fill('10:30')
      await dialog.getByRole('combobox', { name: 'Customer' }).fill(customerName)
      await dialog.getByRole('option', { name: new RegExp('^' + customerName) }).click()
      saved = page.waitForResponse(r => r.url().endsWith('/api/appointments') && r.request().method() === 'POST')
      await dialog.getByRole('button', { name: 'Create session' }).click()
      assert.equal((await saved).status(), 409)
      const conflictBox = dialog.locator('.schedule-conflict')
      await conflictBox.getByText('This tech is already booked').waitFor()
      assert.match(await conflictBox.innerText(), new RegExp(`10:00–11:00 · ${customerName}`))
      // Changing the time drops the warning until the next save.
      await dialog.getByLabel('Start').fill('10:45')
      await conflictBox.waitFor({ state: 'detached' })
      await dialog.getByLabel('Start').fill('10:30')
      await dialog.getByRole('button', { name: 'Create session' }).click()
      await conflictBox.getByRole('button', { name: 'Save anyway' }).waitFor()
      saved = page.waitForResponse(r => r.url().endsWith('/api/appointments') && r.request().method() === 'POST')
      await conflictBox.getByRole('button', { name: 'Save anyway' }).click()
      const second = (await (await saved).json()).appointment
      assert.equal(second.hasConflict, true)
      await page.waitForFunction(selector => document.querySelectorAll(selector).length === 2, `[data-tech="${id('tech_a')}"] .schedule-event-conflict`)

      // Drag the overlap to the other tech, then stretch the first session by half an hour.
      const secondBox = await page.locator(`[data-appointment="${second.id}"]`).boundingBox()
      const otherBox = await column('tech_b').boundingBox()
      saved = page.waitForResponse(r => r.url().endsWith('/api/appointments/' + second.id) && r.request().method() === 'PUT')
      await drag(page, { x: secondBox.x + secondBox.width / 2, y: secondBox.y + 10 }, { x: otherBox.x + otherBox.width / 2, y: secondBox.y + 10 })
      const moved = (await (await saved).json()).appointment
      assert.deepEqual([moved.tech.username, Date.parse(moved.startsAt), moved.hasConflict], ['tech_b', Date.parse(at(uiDay, 10, 30)), false])
      await column('tech_b').locator(`[data-appointment="${second.id}"]`).waitFor()
      await page.waitForFunction(selector => document.querySelectorAll(selector).length === 0, `[data-tech="${id('tech_a')}"] .schedule-event-conflict`)
      const handle = await column('tech_a').locator(`[data-appointment="${first.id}"] .schedule-event-resize`).boundingBox()
      saved = page.waitForResponse(r => r.url().endsWith('/api/appointments/' + first.id) && r.request().method() === 'PUT')
      await drag(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 + HOUR / 2 })
      assert.equal((await (await saved).json()).appointment.durationMinutes, 90)
      assert.equal((await appointment(first.id)).durationMinutes, 90)

      // An unassigned session goes to a tech by dropping it on their column at its time.
      const waitingItem = page.locator('.schedule-unassigned-list button').filter({ hasText: 'Li Si' }).filter({ hasText: '14:00' })
      const itemBox = await waitingItem.first().boundingBox()
      box = await column('tech_b').boundingBox()
      saved = page.waitForResponse(r => r.url().endsWith('/api/appointments/' + waiting.id) && r.request().method() === 'PUT')
      await drag(page, { x: itemBox.x + 20, y: itemBox.y + 10 }, { x: box.x + box.width / 2, y: box.y + 14 * HOUR + 2 }, 12)
      const taken = (await (await saved).json()).appointment
      assert.deepEqual([taken.tech.username, Date.parse(taken.startsAt)], ['tech_b', Date.parse(at(uiDay, 14))])
      await column('tech_b').locator(`[data-appointment="${waiting.id}"]`).waitFor()

      // The customer link opens over the session, creates the tech's room and carries the name.
      await column('tech_b').locator(`[data-appointment="${waiting.id}"]`).click()
      const edit = page.getByRole('dialog', { name: 'Edit session' })
      await edit.waitFor()
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

      // Customers: the shared list and each customer's sessions.
      await page.getByRole('tab', { name: 'Customers' }).click()
      await page.getByLabel('Search customers').fill(customerName)
      await page.waitForFunction(name => [...document.querySelectorAll('.schedule-table tbody tr')].map(row => row.cells[0]?.textContent).join() === name, customerName)
      await page.getByRole('button', { name: customerName, exact: true }).click()
      const profile = page.getByRole('dialog', { name: customerName })
      await profile.locator('.schedule-history button').nth(1).waitFor()
      assert.equal(await profile.getByLabel('Contact').inputValue(), 'ui@example.invalid')
      assert.equal(await profile.locator('.schedule-history button').count(), 2)
      await page.keyboard.press('Escape')
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
        await page.goto(`${WEB}/schedule?view=week&date=${day}`)
        await page.locator(`[data-appointment="${waiting.id}"]`).waitFor()
        assert.equal(await page.locator(`[data-appointment="${first.id}"]`).count(), 0, "another tech's session")
        assert.equal(await page.locator('.schedule-event-resize, .schedule-column.is-editable').count(), 0)
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
        assert.equal(await page.locator('.schedule-agenda-item').count(), actor === 'tech_b' ? 2 : 3)
        assert(await fitsWidth(page), 'no sideways scrolling')
        if (actor === 'agent_a') {
          await page.getByRole('button', { name: '新建场次', exact: true }).click()
          const form = page.getByRole('dialog', { name: '新建场次' })
          await form.waitFor()
          assert(await form.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
          await page.keyboard.press('Escape')
        }
        await page.screenshot({ path: `/tmp/sharecode-schedule-${actor}-mobile-${engine}.png` })
        assert.deepEqual(errors, [])
        await context.close()
      }
      for (const session of [first, second, waiting, today]) await request('/api/appointments/' + session.id, 'DELETE', undefined, as('agent_a'))
      console.log('PASS', engine, 'calendar: click to plan, inline customer, overlap confirmation, drag to another tech, resize, unassigned drop, customer link; tech read-only with room; phone list; EN/ZH')
    } finally { await browser.close() }
  }
} finally { await web.close() }
