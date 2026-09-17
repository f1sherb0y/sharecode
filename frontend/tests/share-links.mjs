// Disposable localhost database/API only; see scripts/test-runner-local.sh.
import assert from 'node:assert/strict'

const API = 'http://127.0.0.1:55460'
async function request(path, method = 'GET', body, token, status = 200) {
  const response = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json()
  assert.equal(response.status, status, JSON.stringify(data))
  return data
}
const password = 'LocalAudit#2026Strong'
const admin = (await request('/api/auth/login', 'POST', { username: 'audit_admin', password })).token
const { room } = await request('/api/rooms', 'POST', { name: 'Invitation filtering', language: 'python' }, admin, 201)
const path = `/api/rooms/${room.id}/share-links`
const create = async () => (await request(path, 'POST', { canEdit: true }, admin, 201)).shareLink
const list = async () => (await request(path, 'GET', undefined, admin)).shareLinks
const unused = await create(), guestLink = await create(), memberLink = await create()
assert.deepEqual(new Set((await list()).map(link => link.id)), new Set([unused.id, guestLink.id, memberLink.id]))

// Existing members visiting an invitation do not consume it.
await request(`/api/share/${unused.token}/accept`, 'POST', {}, admin)
assert.equal((await list()).length, 3)

const guest = await request(`/api/share/${guestLink.token}/join`, 'POST', { username: 'invited_guest' }, undefined, 201)
assert.deepEqual(new Set((await list()).map(link => link.id)), new Set([unused.id, memberLink.id]))
const member = await request('/api/auth/register', 'POST', { username: 'invited_member', password }, undefined, 201)
await request(`/api/share/${memberLink.token}/accept`, 'POST', {}, member.token)
assert.deepEqual((await list()).map(link => link.id), [unused.id])

// Filtering must not delete the links: guest sessions and memberships need them.
assert.equal((await request('/api/auth/profile', 'GET', undefined, guest.token)).room.id, room.id)
await request(`/api/rooms/${room.id}`, 'GET', undefined, member.token)
await request(`/api/share/${guestLink.token}/join`, 'POST', { username: 'second_guest' }, undefined, 410)
await request(path, 'GET', undefined, member.token, 404)
await request(path, 'GET', undefined, undefined, 401)
await request(`${path}/${unused.id}`, 'DELETE', undefined, admin)
assert.deepEqual(await list(), [])
console.log('PASS share list filters guest/member claims, preserves access, keeps unused links and enforces permissions')
