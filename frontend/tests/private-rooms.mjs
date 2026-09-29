// Run with scripts/test-runner-local.sh; all accounts and rooms are disposable.
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'
const API = 'http://127.0.0.1:55460'
const password = 'LocalAudit#2026Strong'
async function request(path, method = 'GET', body, token, expected = 200) {
  const response = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json()
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`)
  return data
}
const login = name => request('/api/auth/login', 'POST', { username: name, password })
const actors = { root: await login('audit_admin') }
const root = actors.root.token
for (const [username, role, flags] of [
  ['super_peer','superuser',{}], ['admin_owner','admin',{}], ['admin_peer','admin',{}],
  ['limited_admin','admin',{ canReadAllRooms:false, canWriteAllRooms:false, canDeleteAllRooms:false }],
  ['user_owner','user',{}], ['user_peer','user',{}],
  ['global_reader','user',{canReadAllRooms:true}], ['global_writer','user',{canWriteAllRooms:true}], ['global_delete','user',{canDeleteAllRooms:true}],
]) {
  await request('/api/admin/users','POST',{username,role,password,...flags},root,201)
  actors[username] = await login(username)
}
const rank = role => ({user:0,admin:1,superuser:2})[role]
const globalRead = a => a.user.role === 'superuser' || a.user.canReadAllRooms || a.user.canWriteAllRooms || a.user.canDeleteAllRooms
const rooms = []
const create = async (actor,name,isPrivate,extra={}) => {
  const room = (await request('/api/rooms','POST',{name,language:'python',...(isPrivate === undefined ? {} : {isPrivate}),...extra},actors[actor].token,201)).room
  assert.equal(room.isPrivate,isPrivate ?? false)
  return {...room,actor}
}
for (const actor of ['root','super_peer','admin_owner','admin_peer','user_owner','user_peer']) {
  rooms.push(await create(actor,`${actor} private`,true))
  rooms.push(await create(actor,`${actor} standard`,undefined))
}
const visible = (a,r) => a.user.id === r.ownerId || (r.isPrivate ? rank(a.user.role) > rank(actors[r.actor].user.role) : globalRead(a))
async function socket(room,token,allowed) {
  const doc = new Y.Doc()
  let denied = false
  const state = { closed: false }
  const provider = new HocuspocusProvider({url:API.replace('http','ws')+'/api/ws',name:room.id,document:doc,token,onAuthenticationFailed:()=>{denied=true},onClose:()=>{state.closed=true}})
  try {
    for (let i=0;i<150&&!provider.synced&&!denied;i++) await new Promise(r=>setTimeout(r,20))
    assert.equal(provider.synced,allowed,`WebSocket access ${room.name}`)
    if (!allowed) assert(denied,`Expected explicit denial ${room.name}`)
    return {provider,doc,state}
  } catch (error) { provider.destroy(); doc.destroy(); throw error }
}
async function probe(room,token,allowed) {
 const connection = await socket(room,token,allowed)
 connection.provider.destroy(); connection.doc.destroy()
}
for (const [name,actor] of Object.entries(actors)) {
  const expected = rooms.filter(room=>visible(actor,room)).map(room=>room.id).sort()
  const list = await request('/api/rooms?pageSize=100', 'GET',undefined,actor.token)
  assert.deepEqual(list.rooms.map(r=>r.id).sort(),expected,name)
  assert.equal(list.pagination.total,expected.length)
  if(actor.user.role !== 'user') {
    const adminList=await request('/api/admin/rooms?pageSize=100','GET',undefined,actor.token)
    assert.deepEqual(adminList.rooms.map(r=>r.id).sort(),expected,`admin list ${name}`)
    assert.equal(adminList.pagination.total,expected.length)
    const filtered=await request('/api/admin/rooms?q=private&pageSize=100','GET',undefined,actor.token)
    assert.deepEqual(filtered.rooms.map(r=>r.id).sort(),rooms.filter(r=>r.isPrivate&&visible(actor,r)).map(r=>r.id).sort())
  }
  for(const room of rooms) await request('/api/rooms/'+room.id,'GET',undefined,actor.token,visible(actor,room)?200:404)
  // Cover all role directions, same-role superusers, and all global flag levels over WS.
  for(const room of rooms.filter(r=>r.isPrivate)) await probe(room,actor.token,visible(actor,room))
}
console.log('PASS role/flag matrix: room and admin lists, counts, filters, REST and WebSocket; standard-room compatibility')
const adminPrivate=rooms.find(r=>r.actor==='admin_owner'&&r.isPrivate)
for(const token of [actors.admin_peer.token,actors.global_delete.token,actors.user_peer.token]) {
 for(const [suffix,method,body] of [
  ['', 'PUT',{language:'java'}],['','DELETE'],['/end','POST',{}],['/pin','PUT',{isPinned:true}],
  ['/share-links','GET'],['/share-links','POST',{}],['/notes','GET'],['/notes','POST',{text:'hidden'}],['/playback/updates','GET'],
 ]) await request('/api/rooms/'+adminPrivate.id+suffix,method,body,token,404)
 await request('/api/rooms/by-document/'+adminPrivate.id,'GET',undefined,token,404)
}
const rootPrivate=rooms.find(r=>r.actor==='root'&&r.isPrivate)
await request('/api/admin/rooms/'+rootPrivate.id,'DELETE',undefined,actors.super_peer.token,404)
await request('/api/admin/rooms/'+rootPrivate.id+'/playback/compress','POST',{},actors.super_peer.token,404)
assert.deepEqual((await request('/api/admin/storage/playback?roomIds='+rootPrivate.id,'GET',undefined,actors.super_peer.token)).rooms,[])
console.log('PASS private-room guards on metadata, updates, notes, invitations, lifecycle, playback and storage endpoints')
const link = async (room,token) => (await request('/api/rooms/'+room.id+'/share-links','POST',{canEdit:false},token,201)).shareLink
const memberLink=await link(adminPrivate,actors.admin_owner.token)
await request('/api/share/'+memberLink.token+'/accept','POST',{},actors.user_peer.token)
assert.equal((await request('/api/rooms/'+adminPrivate.id,'GET',undefined,actors.user_peer.token)).room.canEdit,false)
let member=await socket(adminPrivate,actors.user_peer.token,true)
assert.equal(member.provider.authorizedScope,'readonly')
await request('/api/share/'+memberLink.token+'/accept','POST',{},actors.user_peer.token)
await request('/api/share/'+memberLink.token+'/accept','POST',{},actors.user_owner.token,410)
// Revoking the invitation removes link-derived membership and its open socket.
await request('/api/rooms/'+adminPrivate.id+'/share-links/'+memberLink.id,'DELETE',undefined,actors.admin_owner.token)
await request('/api/rooms/'+adminPrivate.id,'GET',undefined,actors.user_peer.token,404)
for(let i=0;i<100&&!member.state.closed;i++) await new Promise(r=>setTimeout(r,20))
assert.equal(!member.state.closed,false)
member.provider.destroy();member.doc.destroy()
await probe(adminPrivate,actors.user_peer.token,false)
// Global-read flags cannot skip claiming an invitation that privacy requires.
const peerLink=await link(adminPrivate,actors.admin_owner.token)
await request('/api/share/'+peerLink.token+'/accept','POST',{},actors.admin_peer.token)
await probe(adminPrivate,actors.admin_peer.token,true)
assert.equal((await request('/api/rooms/'+adminPrivate.id,'GET',undefined,actors.admin_peer.token)).room.isMember,true)
const superLink=await link(rootPrivate,root)
await request('/api/share/'+superLink.token+'/accept','POST',{},actors.super_peer.token)
await probe(rootPrivate,actors.super_peer.token,true)
const guestLink=await link(adminPrivate,actors.admin_owner.token)
const guest=await request('/api/share/'+guestLink.token+'/join','POST',{username:'private guest'},undefined,201)
await probe(adminPrivate,guest.token,true)
await probe(rootPrivate,guest.token,false)
await request('/api/rooms','GET',undefined,guest.token,401)
const allowed=await create('admin_owner','Explicit private member',true,{allowedUsers:[{userId:actors.user_peer.user.id,canEdit:true}]})
const endingMember=await socket(allowed,actors.user_peer.token,true)
const endingOwner=await socket(allowed,actors.admin_owner.token,true)
await request('/api/rooms/'+allowed.id+'/end','POST',{},actors.admin_owner.token)
for(let i=0;i<100&&!endingMember.state.closed;i++) await new Promise(r=>setTimeout(r,20))
assert(endingMember.state.closed)
assert.equal(endingOwner.state.closed,false)
endingMember.provider.destroy();endingMember.doc.destroy()
endingOwner.provider.destroy();endingOwner.doc.destroy()
await request('/api/rooms/'+allowed.id,'GET',undefined,actors.user_peer.token,404)
await request('/api/rooms/'+allowed.id+'/playback/updates','GET',undefined,actors.user_peer.token,404)
await probe(allowed,actors.user_peer.token,false)
await request('/api/rooms/'+allowed.id+'/playback/updates','GET',undefined,root)
await request('/api/rooms/'+adminPrivate.id+'/end','POST',{},actors.admin_owner.token)
await probe(adminPrivate,guest.token,false)
console.log('PASS logged-in/guest shares, same-level invitation exceptions, explicit membership, read-only grants, revocation and ended-room lockout')

// A nonprivate invitation from a higher-role owner persists into playback.
for (const writable of [false,true]) {
 const shared=await create('admin_owner','Persistent shared '+writable,false)
 const grant=(await request('/api/rooms/'+shared.id+'/share-links','POST',{canEdit:writable},actors.admin_owner.token,201)).shareLink
 await request('/api/share/'+grant.token+'/accept','POST',{},actors.user_peer.token)
 await request('/api/share/'+grant.token+'/accept','POST',{},actors.user_peer.token)
 const detail=(await request('/api/rooms/'+shared.id,'GET',undefined,actors.user_peer.token)).room
 assert.equal(detail.canEdit,writable);assert.equal(detail.canViewPlayback,true)
 assert.equal(detail.canReadNotes,true);assert.equal(detail.canWriteNotes,writable)
 const viewer=await socket(shared,actors.user_peer.token,true)
 assert.equal(viewer.provider.authorizedScope,writable?'read-write':'readonly')
 const owner=await socket(shared,actors.admin_owner.token,true)
 owner.doc.getText('codemirror').insert(0,'retained replay')
 await new Promise(r=>setTimeout(r,350))
 await request('/api/rooms/'+shared.id+'/end','POST',{},actors.admin_owner.token)
 assert.equal(viewer.state.closed,false)
 viewer.provider.destroy();viewer.doc.destroy();owner.provider.destroy();owner.doc.destroy()
 const renewed=await login('user_peer')
 assert((await request('/api/rooms','GET',undefined,renewed.token)).rooms.some(r=>r.id===shared.id))
 assert.equal((await request('/api/rooms/'+shared.id,'GET',undefined,renewed.token)).room.canEdit,false)
 assert((await request('/api/rooms/'+shared.id+'/playback/updates','GET',undefined,renewed.token)).updates.length>0)
 await request('/api/rooms/'+shared.id+'/notes','GET',undefined,renewed.token)
 await request('/api/rooms/'+shared.id+'/notes','POST',{text:'Ended room is read-only'},renewed.token,404)
 await request('/api/rooms/'+shared.id+'/share-links/'+grant.id,'DELETE',undefined,actors.admin_owner.token)
 await request('/api/rooms/'+shared.id+'/playback/updates','GET',undefined,renewed.token,404)
}
const same=await create('user_owner','Same-role share',false)
const sameGrant=await link(same,actors.user_owner.token)
await request('/api/share/'+sameGrant.token+'/accept','POST',{},actors.user_peer.token)
await request('/api/rooms/'+same.id+'/end','POST',{},actors.user_owner.token)
await request('/api/rooms/'+same.id+'/playback/updates','GET',undefined,actors.user_peer.token,404)
const narrowed=await create('admin_owner','Explicit readonly overrides global write',false)
const oldWriter=await socket(narrowed,actors.global_writer.token,true)
const narrowLink=await link(narrowed,actors.admin_owner.token)
await request('/api/share/'+narrowLink.token+'/accept','POST',{},actors.global_writer.token)
for(let i=0;i<100&&!oldWriter.state.closed;i++) await new Promise(r=>setTimeout(r,20))
assert(oldWriter.state.closed);oldWriter.provider.destroy();oldWriter.doc.destroy()
assert.equal((await request('/api/rooms/'+narrowed.id,'GET',undefined,actors.global_writer.token)).room.canEdit,false)
const readonly=await socket(narrowed,actors.global_writer.token,true)
assert.equal(readonly.provider.authorizedScope,'readonly');readonly.provider.destroy();readonly.doc.destroy()
await request('/api/rooms/'+narrowed.id,'PUT',{company:'blocked'},actors.global_writer.token,404)
await request('/api/admin/users','POST',{username:'escalated',password,canReadAllRooms:true},actors.limited_admin.token,404)
console.log('PASS persistent higher-role standard shares, playback after fresh login, revocation, same-rank lockout, readonly overrides and delegation guard')
const promoted=await create('user_owner','Role revalidation',true)
const observer=await socket(promoted,actors.limited_admin.token,true)
await request('/api/admin/users/'+actors.user_owner.user.id,'PATCH',{role:'admin'},root)
await request('/api/rooms/'+promoted.id,'GET',undefined,actors.limited_admin.token,404)
for(let i=0;i<100&&!observer.state.closed;i++) await new Promise(r=>setTimeout(r,20))
assert.equal(!observer.state.closed,false)
observer.provider.destroy();observer.doc.destroy()
await probe(promoted,actors.limited_admin.token,false)
// Deleted rooms expose neither metadata nor the history endpoint.
await request('/api/rooms/'+allowed.id,'DELETE',undefined,root)
for(const token of [root,actors.admin_owner.token,actors.user_peer.token]) {
 await request('/api/rooms/'+allowed.id,'GET',undefined,token,404)
 await request('/api/rooms/'+allowed.id+'/playback/updates','GET',undefined,token,404)
 await probe(allowed,token,false)
}
console.log('PASS owner-role changes revoke stale socket access; deleted-room details and playback are denied')
const web=await createServer({server:{host:'127.0.0.1',port:55461,strictPort:true,proxy:{'/api':{target:API,changeOrigin:true,ws:true}}},define:{'import.meta.env.VITE_API_URL':JSON.stringify(API),'import.meta.env.VITE_WS_URL':JSON.stringify(API.replace('http','ws'))},logLevel:'error'})
await web.listen()
try {
 for(const [engine,type] of Object.entries({chromium,firefox,webkit})) {
  const browser=await type.launch()
  try {
   for(const mobile of [false,true]) {
    const lng=mobile?'zh':'en',context=await browser.newContext({viewport:{width:mobile?390:1440,height:900},deviceScaleFactor:mobile?3:1,hasTouch:mobile})
    await context.addInitScript(({token,lng})=>{sessionStorage.setItem('sharecode-tab-auth',JSON.stringify({state:{token},version:0}));localStorage.setItem('i18nextLng',lng)}, {token:actors.admin_owner.token,lng})
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
    await page.goto('http://127.0.0.1:55461/rooms')
    await page.getByRole('button',{name:mobile?'创建新房间':'Create New Room',exact:true}).click()
    const check=page.getByRole('checkbox',{name:mobile?'设为私密房间':'Make room private'})
    assert.equal(await check.isChecked(),false)
    await check.check()
    await page.locator('#roomName').fill('Private UI '+engine+' '+lng)
    await page.screenshot({path:`/tmp/sharecode-private-form-${engine}-${lng}.png`})
    assert(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1))
    const created=page.waitForResponse(r=>r.url().endsWith('/api/rooms')&&r.request().method()==='POST')
    await page.getByRole('dialog').locator('button[type=submit]').click()
    const response=await created;assert.equal((await response.json()).room.isPrivate,true)
    await page.waitForURL('**/room/**')
    await page.locator('.monaco-editor').waitFor()
    await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent.match(/Saved|已保存/))
    await page.waitForLoadState('networkidle')
    await page.getByRole('button',{name:mobile?'返回':'Back',exact:true}).click()
    await page.getByRole('link',{name:'Private UI '+engine+' '+lng,exact:true}).waitFor()
    assert(await page.getByLabel(mobile?'私密房间':'Private room',{exact:true}).count()>0)
    assert.deepEqual(errors,[])
    await context.close()
   }
   console.log('PASS',engine,'private-room creation, compact desktop/mobile 3x DPI, EN/ZH and list indicator')
  } finally {await browser.close()}
 }
} finally {await web.close()}
// Rejected Hocuspocus connections can leave reconnect timers in Node after
// destroy(); all assertions, browser shutdown and Vite shutdown have completed.
process.exit(0)
