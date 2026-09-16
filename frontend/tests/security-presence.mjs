// Run only against the disposable localhost server started by the test runner.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { execFileSync } from 'node:child_process'
const API='http://127.0.0.1:55440',WEB='http://127.0.0.1:55441'
const wait=async(fn,msg,ms=10000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,40))}throw Error(msg)}
async function request(path,method='GET',body,token,extra={}){const r=await fetch(API+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{ }),...extra},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()}}
const ok=async(...args)=>{const r=await request(...args);assert.ok(r.status<300,JSON.stringify(r));return r.body}
const admin=(await ok('/api/auth/login','POST',{username:'audit_admin',password:'LocalAudit#2026Strong'})).token
const name=`audit_security_${Date.now()}`,password='UniqueAudit#2026Pass'
const account=await ok('/api/auth/register','POST',{username:name,password})
const token1=(await ok('/api/auth/login','POST',{username:name,password},undefined,{'User-Agent':'ShareCode local security test','X-Forwarded-For':'198.51.100.123'})).token
const token2=(await ok('/api/auth/login','POST',{username:name,password})).token
const room=(await ok('/api/rooms','POST',{name:'audit-idle-presence',language:'python'},token1)).room
const peers=[]
function peer(token){const doc=new Y.Doc();const peer={doc,members:[],closed:false,denied:false};const p=new HocuspocusProvider({url:API.replace('http','ws')+'/api/ws',name:room.id,document:doc,token,onSynced:()=>p.sendStateless(JSON.stringify({type:'presence',clientId:doc.clientID})),onStateless:({payload})=>{const m=JSON.parse(payload);if(m.type==='presence-state')peer.members=m.members},onClose:()=>{peer.closed=true},onAuthenticationFailed:()=>{peer.denied=true;p.disconnect()}});peer.p=p;peers.push(peer);return peer}
let browser
try{
 const a=peer(token1),b=peer(admin);await wait(()=>a.p.synced&&b.p.synced&&b.members.some(m=>m.username===name),'initial presence')
 // Stop the JS awareness renewal entirely; native ping/pong continues.
 clearInterval(a.p.awareness._checkInterval)
 a.p.awareness.setLocalState(null)
 console.log('Waiting 40 seconds with no typing or awareness updates; native transport heartbeat stays alive…')
 await new Promise(r=>setTimeout(r,40000))
 assert.ok(b.members.some(m=>m.username===name));assert.equal(a.closed,false)
 console.log('PASS idle connected user stays in roster beyond awareness expiry')
 a.p.destroy();await wait(()=>!b.members.some(m=>m.username===name),'closed tab removed from roster',3000)
 console.log('PASS closed connection removed promptly')
 const existing=peer(token2);await wait(()=>existing.p.synced,'second session connected')
 const nextPassword='DifferentAudit#2026Pass';const changed=await ok('/api/auth/change-password','POST',{oldPassword:password,newPassword:nextPassword},token1)
 assert.ok(changed.token);await wait(()=>existing.closed,'password change closes old socket',3000)
 for(const token of [token1,token2]){assert.equal((await request('/api/auth/profile','GET',undefined,token)).status,401);assert.equal((await request('/api/rooms','GET',undefined,token)).status,401)}
 assert.equal((await request('/api/auth/profile','GET',undefined,changed.token)).status,200)
 const rejected=peer(token2);await wait(()=>rejected.denied,'old token cannot reconnect')
 const accepted=peer(changed.token);await wait(()=>accepted.p.synced,'new token reconnects')
 assert.equal((await request('/api/auth/login','POST',{username:name,password})).status,401)
 await ok('/api/auth/login','POST',{username:name,password:nextPassword})
 console.log('PASS password change invalidates every old REST/WS token; replacement works')
 const audit=await ok('/api/admin/audit?username='+name,'GET',undefined,admin)
 assert.ok(audit.events.some(e=>e.action==='login'&&e.success));assert.ok(audit.events.some(e=>e.action==='login'&&!e.success));assert.ok(audit.events.some(e=>e.action==='password.changed'))
 const forged=audit.events.find(e=>e.userAgent==='ShareCode local security test');assert.equal(forged.clientIp,'127.0.0.1');assert.equal(forged.ipSource,'socket');assert.ok(!JSON.stringify(audit).includes(password));assert.equal((await request('/api/admin/audit','GET',undefined,changed.token)).status,404)
 const beforeDelete=changed.token
 await ok(`/api/admin/users/${account.user.id}`,'DELETE',undefined,admin)
 await wait(()=>accepted.closed,'account deletion closes sockets',3000)
 assert.equal((await request('/api/auth/profile','GET',undefined,beforeDelete)).status,401)
 // This is the disposable local test database only. Restore the record to
 // prove deleting invalidated its old JWT permanently, not just while hidden.
 execFileSync('psql',['-XAt','-h','127.0.0.1','-p','55439','-d','sharecode_sync_test','-v','ON_ERROR_STOP=1','-c',
   `UPDATE "User" SET "isDeleted"=false WHERE id='${account.user.id}'`])
 assert.equal((await request('/api/rooms','GET',undefined,beforeDelete)).status,401)
 await ok('/api/auth/login','POST',{username:name,password:nextPassword})
 console.log('PASS deletion permanently revokes tokens, including after account restoration')
 console.log('PASS audit records login success/failure/password change; forged forwarding ignored; ordinary user denied')
 browser=await chromium.launch();const page=await browser.newPage();await page.goto(WEB+'/login');await page.evaluate(token=>{sessionStorage.setItem('sharecode-tab-auth',JSON.stringify({state:{token},version:0}));localStorage.setItem('i18nextLng','en')},admin);await page.goto(WEB+'/admin/audit');await page.getByRole('textbox',{name:'Account (exact match)'}).fill(name);await page.getByRole('button',{name:'Filter',exact:true}).click();await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('password.changed'))
 assert.ok((await page.locator('tbody').innerText()).includes('127.0.0.1'));console.log('PASS audit management page displays login IP')
}finally{for(const {p,doc}of peers){p.destroy();doc.destroy()}await browser?.close()}
process.exit(0)
