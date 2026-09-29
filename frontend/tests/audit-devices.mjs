// Disposable DB only, via scripts/test-runner-local.sh.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'
const API='http://127.0.0.1:55460',WEB='http://127.0.0.1:55461',password='LocalAudit#2026Strong'
const deviceA=randomUUID(),deviceB=randomUUID(),fp='fp5:'+'a'.repeat(32)
const headers=id=>({'X-Device-Id':id,'X-Device-Fingerprint':fp,'User-Agent':'Audit Browser/1.0'})
async function request(path,method='GET',body,token,status=200,extra={}) {
 const r=await fetch(API+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...extra},body:body?JSON.stringify(body):undefined})
 const d=await r.json();assert.equal(r.status,status,`${method} ${path}: ${JSON.stringify(d)}`);return d
}
const login=(name,id,pass=password,status=200)=>request('/api/auth/login','POST',{username:name,password:pass},undefined,status,id?headers(id):{})
const root=await login('audit_admin',deviceA)
const token=root.token
const registered=await request('/api/auth/register','POST',{username:'registered_device',password},undefined,201,headers(deviceB))
assert.equal((await request(`/api/admin/users/${registered.user.id}/devices`,'GET',undefined,token)).devices.length,1)
await request(`/api/admin/users/${registered.user.id}`,'DELETE',undefined,token,200,headers(deviceA))
const created=(await request('/api/admin/users','POST',{username:'device_user',password},token,201,headers(deviceA))).user
const member=await login('device_user',deviceA)
await login('device_user',deviceA)
await login('device_user',deviceB)
await login('device_user',randomUUID(),'Incorrect#123',401)
let devices=await request(`/api/admin/users/${created.id}/devices`,'GET',undefined,token)
assert.equal(devices.devices.length,2)
assert.equal(devices.devices.find(d=>d.deviceId===deviceA).loginCount,2)
assert(devices.devices.every(d=>d.fingerprint===fp&&d.lastIp==='127.0.0.1'))
let events=(await request('/api/admin/audit?username=device_user','GET',undefined,token)).events
assert.equal(events.filter(e=>e.newDevice).length,2)
assert.equal(events.filter(e=>e.success&&e.action==='login').length,3)
assert.equal(events.filter(e=>!e.success).length,1)
await request(`/api/admin/users/${created.id}/devices`,'GET',undefined,member.token,404)
await request('/api/admin/audit','GET',undefined,member.token,404)
const administrator=(await request('/api/admin/users','POST',{username:'device_admin',password,role:'admin',canDeleteAllRooms:true},token,201)).user
const adminAuth=await login(administrator.username,randomUUID())
for(const id of [administrator.id,created.id,root.user.id,randomUUID()]) {
 await request(`/api/admin/users/${id}/devices`,'GET',undefined,adminAuth.token,404)
}
await request(`/api/admin/users/${created.id}/devices`,'GET',undefined,undefined,401)
const adminAudit=await request('/api/admin/audit?username=device_user','GET',undefined,adminAuth.token)
assert(adminAudit.events.length>0)
assert(adminAudit.events.every(e=>e.deviceId===null&&e.fingerprint===null&&e.newDevice===false))
await request(`/api/admin/audit?deviceId=${deviceA}`,'GET',undefined,adminAuth.token,404)
console.log('PASS superuser-only device history; admin self/other access and audit device-filter bypass denied; admin audit device fields redacted')
// Duplicate fingerprint is a hint, not a reason to merge different browser IDs.
await Promise.all([login('device_user',deviceB),login('device_user',deviceB)])
devices=await request(`/api/admin/users/${created.id}/devices`,'GET',undefined,token)
assert.equal(devices.devices.find(d=>d.deviceId===deviceB).loginCount,3)
await request('/api/auth/login','POST',{username:'device_user',password},undefined,200,{'X-Device-Id':'malformed','X-Device-Fingerprint':'x'.repeat(500)})
assert.equal((await request(`/api/admin/users/${created.id}/devices`,'GET',undefined,token)).devices.length,2)
console.log('PASS device persistence, new/repeat/concurrent logins, distinct IDs with same fingerprint, failed logins and malformed headers')
const room=(await request('/api/rooms','POST',{name:'Never put this private content in audit',language:'python',isPrivate:true},token,201,headers(deviceA))).room
const link=(await request(`/api/rooms/${room.id}/share-links`,'POST',{canEdit:false},token,201,headers(deviceA))).shareLink
await request(`/api/share/${link.token}/accept`,'POST',{},member.token,200,headers(deviceA))
await request(`/api/rooms/${room.id}/share-links/${link.id}`,'DELETE',undefined,token,200,headers(deviceA))
await request(`/api/rooms/${room.id}`,'PUT',{language:'java'},token,200,headers(deviceA))
const note=(await request(`/api/rooms/${room.id}/notes`,'POST',{text:'Private secret note'},token,201,headers(deviceA))).note
await request(`/api/rooms/${room.id}/notes/${note.id}`,'PUT',{text:'Other secret'},token,200,headers(deviceA))
await request(`/api/rooms/${room.id}/notes/${note.id}`,'DELETE',undefined,token,200,headers(deviceA))
await request(`/api/admin/users/${created.id}`,'PATCH',{canReadAllRooms:true},token,200,headers(deviceA))
await request('/api/admin/notifications','POST',{title:'Title not captured',content:'Content not captured'},token,201,headers(deviceA))
await request('/api/auth/change-password','POST',{oldPassword:'Incorrect#123',newPassword:'ChangedAudit#2026'},member.token,400,headers(deviceB))
const changed=await request('/api/auth/change-password','POST',{oldPassword:password,newPassword:'ChangedAudit#2026'},member.token,200,headers(deviceB))
await request('/api/auth/profile','GET',undefined,member.token,401)
for(let i=0;i<30;i++) await request(`/api/rooms/${room.id}/pin`,'PUT',{isPinned:i%2===0},token,200,headers(deviceA))
await request(`/api/rooms/${room.id}/end`,'POST',{},token,200,headers(deviceA))
await request(`/api/rooms/${room.id}`,'DELETE',undefined,token,200,headers(deviceA))
const peer=(await request('/api/admin/users','POST',{username:'audit_peer',password,role:'superuser'},token,201)).user
const peerAuth=await login(peer.username,randomUUID())
const peerAudit=await request('/api/admin/audit?pageSize=100','GET',undefined,peerAuth.token)
assert(!peerAudit.events.some(e=>e.targetId===room.id||e.targetId===note.id||e.targetId===link.id))
const audit=await request('/api/admin/audit?pageSize=100','GET',undefined,token)
for(const action of ['login','user.registered','user.created','user.deleted','user.permissions_changed','password.changed','share.created','share.accept','share.revoke','room.created','room.updated','room.pin_changed','room.ended','room.deleted','note.created','note.updated','note.deleted','notification.created']) assert(audit.events.some(e=>e.action===action),action)
const change=audit.events.find(e=>e.action==='user.permissions_changed')
assert.equal(change.details.before.canReadAllRooms,false);assert.equal(change.details.after.canReadAllRooms,true)
for(const secret of [password,'ChangedAudit#2026',link.token,'Private secret note','Never put this private content in audit','Title not captured','Content not captured']) assert(!JSON.stringify(audit).includes(secret),secret)
console.log('PASS mutation audit coverage, permission before/after, no secrets/content, private-room audit isolation')
const sql=statement=>execFileSync('docker',['exec','-i',process.env.SHARECODE_TEST_CONTAINER,'psql','-U','runner_test','-d','runner_test','-v','ON_ERROR_STOP=1','-Atc',statement],{encoding:'utf8'})
// Make timestamp order differ from ID order, including ties and exact time boundaries.
sql(`UPDATE "AuditEvent" SET "createdAt"='2026-01-01 00:00:00+00' WHERE action='room.pin_changed' AND id%2=0`)
const first=await request('/api/admin/audit?pageSize=7&action=room.pin_changed','GET',undefined,token)
await request('/api/rooms','POST',{name:'Between page requests'},token,201)
const seen=[]
for(let page=1;page<=first.pagination.totalPages;page++) {
 const result=await request(`/api/admin/audit?pageSize=7&action=room.pin_changed&page=${page}&snapshot=${first.snapshot}`,'GET',undefined,token)
 assert.equal(result.pagination.total,30);seen.push(...result.events)
}
assert.equal(new Set(seen.map(e=>e.id)).size,30)
for(let i=1;i<seen.length;i++) assert(Date.parse(seen[i-1].createdAt)>Date.parse(seen[i].createdAt)||(seen[i-1].createdAt===seen[i].createdAt&&seen[i-1].id>seen[i].id))
const range=await request('/api/admin/audit?'+new URLSearchParams({action:'room.pin_changed',start:'2026-01-01T08:00:00+08:00',end:'2026-01-01T08:00:00+08:00'}),'GET',undefined,token)
assert.equal(range.pagination.total,15)
await request('/api/admin/audit?start=2027-01-01T00:00:00Z&end=2026-01-01T00:00:00Z','GET',undefined,token,400)
const scoped=await request(`/api/admin/audit?username=device_user&deviceId=${deviceB}`,'GET',undefined,token)
assert(scoped.events.length>0&&scoped.events.every(e=>e.username==='device_user'&&e.deviceId===deviceB))
// Audit failure must roll back the actual operation as well.
sql(`CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='share.created' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_test_audit BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION reject_test_audit()`)
const rollbackRoom=(await request('/api/rooms','POST',{name:'Rollback test'},token,201)).room
await request(`/api/rooms/${rollbackRoom.id}/share-links`,'POST',{},token,503)
assert.equal((await request(`/api/rooms/${rollbackRoom.id}/share-links`,'GET',undefined,token)).shareLinks.length,0)
sql('DROP TRIGGER reject_test_audit ON "AuditEvent"; DROP FUNCTION reject_test_audit()')
console.log('PASS timestamp/ID ordering, page boundaries, snapshot stability, timezone/range/device filters, audit transaction rollback')
await request('/api/notifications/read-all','POST',{},token)
await request('/api/notifications/read-all','POST',{},adminAuth.token)
const web=await createServer({server:{host:'127.0.0.1',port:55461,strictPort:true,proxy:{'/api':{target:API,changeOrigin:true,ws:true}}},logLevel:'error'})
await web.listen()
try {
 for(const [engine,type] of Object.entries({chromium,firefox,webkit})) {
  if(process.env.AUDIT_BROWSER&&process.env.AUDIT_BROWSER!==engine)continue
  const browser=await type.launch()
  try {
   for(const mobile of [false,true]) {
    const context=await browser.newContext({viewport:{width:mobile?390:1440,height:900},deviceScaleFactor:mobile?3:1,hasTouch:mobile,colorScheme:mobile?'dark':'light'})
    await context.addInitScript(lng=>localStorage.setItem('i18nextLng',lng),mobile?'zh':'en')
    const page=await context.newPage(),errors=[],external=[]
    page.on('pageerror',e=>errors.push(e.message))
    page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(WEB))external.push(r.url())})
    await page.goto(WEB+'/login')
    await page.locator('#username').fill('audit_admin');await page.locator('#password').fill(password)
    const logged=page.waitForRequest(r=>r.url().endsWith('/api/auth/login')&&r.method()==='POST')
    await page.locator('#login-form button[type=submit]').click()
    const loginRequest=await logged
    assert.match(loginRequest.headers()['x-device-id'],/^[0-9a-f-]{36}$/)
    await page.waitForURL('**/rooms');await page.waitForLoadState('networkidle')
    await page.goto(WEB+'/admin/audit')
    await page.locator('tbody tr').first().waitFor()
    assert(await page.getByText(mobile?'新设备':'New device',{exact:true}).count()>0)
    await page.locator('#audit-start').fill('2026-01-01 08:00');await page.locator('#audit-start').press('Tab')
    await page.locator('#audit-end').fill('2027-01-01 08:00');await page.locator('#audit-end').press('Escape')
    assert.equal(await page.locator('.audit-calendar').count(),0)
    const filtered=page.waitForResponse(r=>r.url().includes('/api/admin/audit?')&&r.url().includes('start='))
    await page.getByRole('button',{name:mobile?'筛选':'Filter',exact:true}).click();assert.equal((await filtered).status(),200)
    await page.getByRole('button',{name:mobile?'下一页':'Next',exact:true}).click()
    await page.waitForFunction(()=>document.querySelector('[aria-current=page]')?.textContent==='2')
    await page.locator('#audit-start').click()
    await page.locator('.audit-calendar').waitFor()
    const rect=await page.locator('.audit-calendar').boundingBox();assert(rect.x>=-1&&rect.x+rect.width<=(mobile?390:1440)+1)
    await page.screenshot({path:`/tmp/sharecode-audit-${engine}-${mobile?'mobile-dark':'desktop-light'}.png`})
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1))
    await page.keyboard.press('Escape')
    await page.waitForLoadState('networkidle')
    const id=await page.evaluate(()=>localStorage.getItem('sharecode-device-id'))
    const browserDevices=await request(`/api/admin/users/${root.user.id}/devices?pageSize=100`,'GET',undefined,token)
    assert(browserDevices.devices.some(d=>d.deviceId===id))
    assert.equal(external.length,0,`No fingerprint telemetry: ${external}`)
    if(engine==='chromium') {
      await page.goto(WEB+'/admin?section=users&userSearch=audit_admin')
      await page.getByRole('button',{name:mobile?'设备':'Devices',exact:true}).click()
      await page.getByRole('dialog').getByText(mobile?'首次登录':'First login',{exact:true}).first().waitFor()
      assert(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1))
      await page.screenshot({path:`/tmp/sharecode-devices-${mobile?'mobile':'desktop'}.png`})
      await page.getByRole('dialog').getByRole('button',{name:mobile?'查看事件':'Events',exact:true}).first().click()
      await page.waitForURL('**/admin/audit?**')
      await page.locator('tbody tr').first().waitFor()
      assert(new URL(page.url()).searchParams.has('deviceId'))
    }
    await page.waitForLoadState('networkidle')
    await page.evaluate(token=>sessionStorage.setItem('sharecode-tab-auth',JSON.stringify({state:{token},version:0})),adminAuth.token)
    const adminDeviceRequests=[]
    page.on('request',r=>{if(r.url().includes('/devices'))adminDeviceRequests.push(r.url())})
    await page.goto(WEB+'/admin?section=users&userSearch=device_user')
    await page.locator('tbody tr').first().waitFor()
    assert.equal(await page.getByRole('button',{name:mobile?'设备':'Devices',exact:true}).count(),0)
    assert.deepEqual(adminDeviceRequests,[])
    await page.goto(WEB+`/admin/audit?username=device_user&deviceId=${deviceA}`)
    await page.locator('tbody tr').first().waitFor()
    assert.equal(await page.getByRole('columnheader',{name:mobile?'设备':'Device',exact:true}).count(),0)
    assert.equal(await page.getByText(mobile?'新设备':'New device',{exact:true}).count(),0)
    await page.locator('tbody details summary').first().click()
    assert.equal(await page.getByText(mobile?'指纹':'Fingerprint',{exact:true}).count(),0)
    assert(!(await page.locator('tbody').innerText()).includes(deviceA))
    assert.deepEqual(errors,[])
    await context.close()
   }
   console.log('PASS',engine,'superuser device controls present; admin device controls/fields absent; audit datetime/pagination, desktop and mobile 3x DPI')
  } finally { await browser.close() }
 }
} finally { await web.close() }
