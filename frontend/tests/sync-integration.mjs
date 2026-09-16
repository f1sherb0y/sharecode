// Requires an isolated local server/database; refuses remote URLs.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { execFileSync } from 'node:child_process'
const API=process.env.SYNC_TEST_API || 'http://127.0.0.1:55440'
const WEB=process.env.SYNC_TEST_WEB || 'http://127.0.0.1:55441'
for(const url of [API,WEB])assert.equal(new URL(url).hostname,'127.0.0.1','Local test only')
const wait=async(fn,msg,ms=10000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,20))}throw Error(msg)}
const request=async(path,method='GET',data,token)=>{const r=await fetch(API+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:data?JSON.stringify(data):undefined});const body=await r.json();assert.ok(r.ok,`${method} ${path}: ${r.status} ${JSON.stringify(body)}`);return body}
const login=await request('/api/auth/login','POST',{username:'audit_admin',password:'LocalAudit#2026Strong'})
const admin=login.token
const createRoom=async(name)=>(await request('/api/rooms','POST',{name,language:'python'},admin)).room
const link=async(room,canEdit=true)=>(await request(`/api/rooms/${room.id}/share-links`,'POST',{canEdit},admin)).shareLink
const providers=[]
function peer(room,token){const doc=new Y.Doc();const info={doc,status:[],barriers:[],closed:false};const p=new HocuspocusProvider({url:API.replace('http','ws')+'/api/ws',name:room.id,document:doc,token,onStateless:({payload})=>{const m=JSON.parse(payload);if(m.type==='persistence-status')info.status.push(m);if(m.type==='durability-ack')info.barriers.push(m.id)},onClose:()=>{info.closed=true}});info.p=p;providers.push(info);return info}
const text=p=>p.doc.getText('codemirror')
const barrier=async(p)=>{const id=crypto.randomUUID();p.p.sendStateless(JSON.stringify({type:'durability-barrier',id}));await wait(()=>p.barriers.includes(id),'durability acknowledgement');return id}
let browser
try{
 const a=await createRoom('audit-isolation-A'),b=await createRoom('audit-isolation-B');const aa=peer(a,admin),ab=peer(a,admin),bb=peer(b,admin)
 await wait(()=>[aa,ab,bb].every(p=>p.p.synced),'initial sync')
 const started=performance.now();for(let i=0;i<150;i++){text(aa).insert(text(aa).length,`甲${i}😀`);text(ab).insert(0,`乙${i}`)}
 await wait(()=>text(aa).toString()===text(ab).toString(),'concurrent convergence')
 assert.equal(text(bb).toString(),'');await barrier(aa);await barrier(ab)
 console.log('PASS concurrent editing / room isolation / durable barrier',Math.round(performance.now()-started)+'ms for 300 edits')
 const al=await link(a);const guest=await request(`/api/share/${al.token}/join`,'POST',{username:'audit_guest'});assert.equal(guest.room.id,a.id)
 const gp=peer(a,guest.token);await wait(()=>gp.p.synced,'guest join');text(gp).insert(0,'guest-before-revoke');await barrier(gp)
 await request(`/api/rooms/${a.id}/share-links/${al.id}`,'DELETE',undefined,admin);await wait(()=>gp.closed,'immediate revoke',2000)
 const previous=text(aa).toString();text(gp).insert(0,'REVOKED');await new Promise(r=>setTimeout(r,150));assert.equal(text(aa).toString(),previous)
 console.log('PASS invitation revocation closes established guest socket')
 const member=await request('/api/auth/register','POST',{username:`audit_member_${Date.now()}`,password:'LocalMember#2026Strong'});const bl=await link(b)
 const accepted=await request(`/api/share/${bl.token}/accept`,'POST',{},member.token);assert.equal(accepted.roomId,b.id)
 const mp=peer(b,member.token);await wait(()=>mp.p.synced,'member accepted');await request(`/api/rooms/${b.id}/share-links/${bl.id}`,'DELETE',undefined,admin);await wait(()=>mp.closed,'member revoke',2000)
 console.log('PASS signed-in invitation grants scoped membership and revokes it')
 const persisted=text(aa).toString();aa.p.destroy();ab.p.destroy();await new Promise(r=>setTimeout(r,2400));const again=peer(a,admin);await wait(()=>again.p.synced&&text(again).toString()===persisted,'reconnect restoration')
 console.log('PASS idle eviction / reconnect restores committed log')
 // Identity, tab isolation and real application save status.
 browser=await chromium.launch();const context=await browser.newContext();await context.addInitScript(()=>localStorage.setItem('i18nextLng','en'))
 const page=await context.newPage();await page.goto(WEB+'/login');await page.evaluate(token=>sessionStorage.setItem('sharecode-tab-auth',JSON.stringify({state:{token},version:0})),admin)
 const invitation=await link(a);await page.goto(WEB+'/s/'+invitation.token);await page.waitForURL('**/room/'+a.id+'**');await page.waitForFunction(()=>document.body.textContent.includes('Saved'),{},{timeout:15000})
 assert.ok((await page.locator('body').innerText()).includes(a.name));console.log('PASS logged-in share navigation resolves exact room and saved state')
 await page.evaluate(async()=>{const {loadMonaco}=await import('/src/lib/monaco-loader.ts');const m=await loadMonaco();const model=m.editor.getModels()[0];const end=model.getPositionAt(model.getValueLength());model.applyEdits([{range:new m.Range(end.lineNumber,end.column,end.lineNumber,end.column),text:' UI-save-test'}])})
 await page.waitForFunction(()=>document.body.textContent.includes('Saved'));await wait(()=>text(again).toString().includes('UI-save-test'),'UI editor broadcasts')
 const tab2=await context.newPage();await tab2.goto(WEB+'/login');assert.equal(await tab2.evaluate(()=>JSON.parse(sessionStorage.getItem('sharecode-tab-auth')).state.token),null)
 console.log('PASS independent tabs do not share tokens')
 const gl=await link(b);const guestB=await request(`/api/share/${gl.token}/join`,'POST',{username:'guest-B'});await tab2.evaluate(token=>sessionStorage.setItem('sharecode-tab-auth',JSON.stringify({state:{token},version:0})),guestB.token)
 let wsOpened=0;tab2.on('websocket',ws=>{if(ws.url().includes('/api/ws'))wsOpened++});await tab2.goto(WEB+'/room/'+a.id);await tab2.waitForFunction(()=>document.body.textContent.includes('Room access denied'))
 assert.equal(wsOpened,0);assert.equal(await tab2.locator('.monaco-editor').count(),0);console.log('PASS mismatched guest room blocked before socket/editor creation')
 console.log('ALL INTEGRATION CHECKS PASSED')
}finally{for(const p of providers){p.p.destroy();p.doc.destroy()}await browser?.close()}

process.exit(0)
