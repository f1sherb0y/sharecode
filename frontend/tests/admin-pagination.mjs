// Disposable localhost database/API only; see scripts/test-runner-local.sh.
import assert from 'node:assert/strict'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'
const API = 'http://127.0.0.1:55460'
async function request(path, method = 'GET', body, token) {
  const response = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, body: await response.json() }
}
async function ok(...args) { const r = await request(...args); assert.ok(r.status < 300, JSON.stringify(r)); return r.body }
const password = 'LocalAudit#2026Strong'
const token = (await ok('/api/auth/login', 'POST', { username: 'audit_admin', password })).token
const get = path => ok(path, 'GET', undefined, token)
const createdUsers = []
for (let index = 0; index < 31; index++) {
  createdUsers.push((await ok('/api/admin/users', 'POST', { username: `page_user_${String(index).padStart(2,'0')}`, email: `user${index}@example.invalid`, role: index < 3 ? 'admin' : 'user', password }, token)).user)
}
const ordinary = (await ok('/api/auth/login','POST',{username:createdUsers[30].username,password})).token
const createdRooms = []
for (let index=0; index<56; index++) {
  const room=(await ok('/api/rooms','POST',{name:`Page room ${String(index).padStart(2,'0')}`,language:index%2?'python':'c'},token)).room
  createdRooms.push(room)
  if(index<6) await ok(`/api/rooms/${room.id}/end`,'POST',{},token)
}
const literal=(await ok('/api/rooms','POST',{name:'literal_%_room',language:'java'},token)).room
const users1=await get('/api/admin/users'),users2=await get('/api/admin/users?page=2')
assert.equal(users1.users.length,25);assert.equal(users1.pagination.total,32);assert.equal(users2.users.length,7)
assert.equal(new Set([...users1.users,...users2.users].map(u=>u.id)).size,32)
assert.equal((await get('/api/admin/users?pageSize=999')).pagination.pageSize,100)
assert.equal((await get('/api/admin/users?role=admin')).users.length,3)
assert.equal((await get('/api/admin/users?q=user30%40example.invalid')).users[0].id,createdUsers[30].id)
assert.equal((await get('/api/admin/users?q=nomatch')).pagination.totalPages,0)
const rooms1=await get('/api/admin/rooms'),rooms2=await get('/api/admin/rooms?page=2')
assert.equal(rooms1.rooms.length,25);assert.equal(rooms1.pagination.total,57)
assert.equal(new Set([...rooms1.rooms,...rooms2.rooms].map(r=>r.id)).size,50)
assert.equal((await get('/api/admin/rooms?status=ended&language=python&owner=audit_admin')).pagination.total,3)
assert.equal((await get('/api/admin/rooms?q=%25')).rooms[0].id,literal.id)
assert.equal((await get('/api/admin/rooms?q=%25')).pagination.total,1)
assert.equal((await get('/api/admin/rooms?page=999')).pagination.page,3)
assert.equal((await get('/api/admin/rooms?owner=unknown')).rooms.length,0)
assert.equal((await request('/api/admin/users?role=bogus','GET',undefined,token)).status,400)
assert.equal((await request('/api/admin/rooms?status=bogus','GET',undefined,token)).status,400)
assert.equal((await request('/api/admin/rooms','GET',undefined,ordinary)).status,404)
assert.equal((await request('/api/admin/users')).status,401)
assert.deepEqual((await get('/api/admin/storage/playback')).rooms,[])
const ids=rooms1.rooms.map(r=>r.id)
assert.deepEqual((await get('/api/admin/storage/playback?roomIds='+ids.join(','))).rooms.map(r=>r.id).sort(),ids.sort())
assert.equal((await request('/api/admin/storage/playback?roomIds=invalid','GET',undefined,token)).status,400)
assert.equal((await request('/api/admin/storage/playback?roomIds='+Array(101).fill(ids[0]).join(','),'GET',undefined,token)).status,400)
console.log('PASS API pagination, stable ordering, caps, combined filters, literal search, empty/out-of-range pages, scoped playback and auth')
const web=await createServer({server:{host:'127.0.0.1',port:55461,strictPort:true,proxy:{'/api':{target:API,changeOrigin:true,ws:true}}},logLevel:'error'})
await web.listen()
try {
 for(const [engine,browserType] of Object.entries({chromium,firefox,webkit})) {
  const browser=await browserType.launch()
  try {
   const context=await browser.newContext({viewport:engine==='webkit'?{width:390,height:844}:{width:1440,height:900},deviceScaleFactor:engine==='webkit'?3:1.25})
   await context.addInitScript(token=>{sessionStorage.setItem('sharecode-tab-auth',JSON.stringify({state:{token},version:0}));localStorage.setItem('i18nextLng','en')},token)
   const page=await context.newPage(),requests=[],errors=[]
   page.on('request',r=>{if(r.url().includes('/api/admin/'))requests.push(new URL(r.url()))})
   page.on('pageerror',e=>errors.push(e.message))
   await page.goto('http://127.0.0.1:55461/admin')
   await page.locator('tbody tr').nth(24).waitFor()
   assert.equal(await page.locator('tbody tr').count(),25)
   assert.equal(requests.some(u=>u.pathname.includes('/rooms')||u.pathname.includes('/storage')),false)
   const pager=page.getByRole('navigation',{name:'Management pages'})
   await pager.getByRole('button',{name:'Next',exact:true}).click()
   await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===7)
   await page.getByRole('textbox',{name:'Search username or email'}).fill('user30@example.invalid')
   await page.getByRole('button',{name:'Search',exact:true}).click()
   await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===1)
   assert.equal(new URL(page.url()).searchParams.get('userPage'),'1')
   const usersRequests=requests.filter(u=>u.pathname==='/api/admin/users').length
   await page.getByRole('tab',{name:'Rooms Management'}).click()
   await page.locator('tbody tr').nth(24).waitFor()
   assert.equal(await page.getByRole('table').count(),1)
   assert.equal(requests.filter(u=>u.pathname==='/api/admin/users').length,usersRequests)
   await page.waitForFunction(()=>document.querySelector('table tbody')?.textContent.includes('0 B'))
   assert.ok(requests.filter(u=>u.pathname.includes('/storage/playback')).every(u=>u.searchParams.get('roomIds').split(',').length<=25))
   await pager.getByRole('button',{name:'Next',exact:true}).click()
   await page.waitForFunction(()=>new URL(location.href).searchParams.get('roomPage')==='2')
   await page.getByRole('combobox',{name:'Status',exact:true}).click()
   await page.getByRole('option',{name:'Ended',exact:true}).click()
   await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===6)
   assert.equal(new URL(page.url()).searchParams.get('roomPage'),'1')
   await page.getByRole('combobox',{name:'Language',exact:true}).click()
   await page.getByRole('option',{name:'python',exact:true}).click()
   await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===3)
   await page.reload();await page.locator('tbody tr').nth(2).waitFor()
   assert.equal(await page.locator('tbody tr').count(),3)
   await page.getByRole('tab',{name:'Users Management'}).click()
   await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===1)
   assert.equal(await page.getByRole('textbox',{name:'Search username or email'}).inputValue(),'user30@example.invalid')
   assert.deepEqual(errors,[])
   await page.screenshot({path:`/tmp/sharecode-admin-${engine}.png`})
   console.log('PASS',engine,'tabs load on demand; page/search reset; filters survive reload/tab changes; bounded statistics')
   await context.close()
  } finally {await browser.close()}
 }
} finally {await web.close()}
// Removing the only item on the final page clamps to the remaining last page.
await ok('/api/admin/rooms/'+literal.id,'DELETE',undefined,token)
assert.equal((await get('/api/admin/rooms?page=57&pageSize=1')).pagination.page,56)
console.log('PASS deleting the final row clamps the page')
