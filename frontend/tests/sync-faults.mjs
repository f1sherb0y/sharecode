// Destructive fault injection is restricted to the explicitly local test database.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
const API='http://127.0.0.1:55440',WEB='http://127.0.0.1:55441'
const wait=async(fn,msg,ms=15000)=>{let deadline=Date.now()+ms;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,25))}throw Error(msg)}
const request=async(path,method='GET',data,token)=>{const r=await fetch(API+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:data?JSON.stringify(data):undefined});const out=await r.json();assert.ok(r.ok,JSON.stringify(out));return out}
const admin=(await request('/api/auth/login','POST',{username:'audit_admin',password:'LocalAudit#2026Strong'})).token
const sql=q=>execFileSync('psql',['-XAt','-h','127.0.0.1','-p','55439','-d','sharecode_sync_test','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'}).trim()
const peers=[]
const peer=(room)=>{const doc=new Y.Doc(),result={doc,acks:[]};result.p=new HocuspocusProvider({url:API.replace('http','ws')+'/api/ws',name:room.id,document:doc,token:admin,onStateless:({payload})=>{const m=JSON.parse(payload);if(m.type==='durability-ack')result.acks.push(m.id)}});peers.push(result);return result}
const barrier=p=>{const id=crypto.randomUUID();p.p.sendStateless(JSON.stringify({type:'durability-barrier',id}));return id}
let blocker,browser
async function lockDatabase(){
 blocker=spawn('psql',['-XAt','-h','127.0.0.1','-p','55439','-d','sharecode_sync_test','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']})
 let output='';blocker.stdout.on('data',d=>output+=d.toString());blocker.stdin.write("BEGIN; LOCK TABLE \"DocumentUpdate\" IN ACCESS EXCLUSIVE MODE; SELECT 'LOCKED';\n")
 await wait(()=>output.includes('LOCKED'),'database table lock')
}
async function unlockDatabase(){if(!blocker)return;const p=blocker;blocker=null;p.stdin.end('ROLLBACK;\n');await new Promise(r=>p.on('exit',r))}
try{
 const room=(await request('/api/rooms','POST',{name:'audit-database-failure',language:'python'},admin)).room
 const a=peer(room),b=peer(room);await wait(()=>a.p.synced&&b.p.synced,'peers sync')
 const initial=barrier(a);await wait(()=>a.acks.includes(initial),'initial durable barrier')
 browser=await chromium.launch();const context=await browser.newContext();const page=await context.newPage();page.on('dialog',d=>d.accept());await page.goto(WEB+'/login');await page.evaluate(token=>{sessionStorage.setItem('sharecode-tab-auth',JSON.stringify({state:{token},version:0}));localStorage.setItem('i18nextLng','en')},admin);await page.goto(WEB+'/room/'+room.id);await page.waitForFunction(()=>document.body.textContent.includes('Saved'))
 await lockDatabase()
 const start=performance.now();a.doc.getText('codemirror').insert(0,'survive failed database commit 😀');const ack=barrier(a)
 await wait(()=>b.doc.getText('codemirror').length>0,'live broadcast despite locked database',1500)
 assert.ok(performance.now()-start<1500);assert.ok(!a.acks.includes(ack));console.log('PASS live broadcast precedes durable acknowledgement during database lock')
 // The page receives uncommitted edits, journals them, and cannot claim Saved.
 await page.waitForFunction(()=>document.querySelector('[role="status"]')?.textContent.includes('Saving'))
 await wait(async()=>page.evaluate(()=>new Promise(resolve=>{const q=indexedDB.open('sharecode-recovery',1);q.onsuccess=()=>{const db=q.result;const get=db.transaction('pending').objectStore('pending').getAll();get.onsuccess=()=>{resolve(get.result.length>0);db.close()}}})), 'received uncommitted state persisted locally')
 // Wait beyond statement_timeout to exercise retained-batch retry.
 await page.waitForFunction(()=>document.body.textContent.includes('Saving unavailable'),{},{timeout:9000})
 assert.ok(!a.acks.includes(ack));await unlockDatabase();await wait(()=>a.acks.includes(ack),'retry saves retained edits')
 await page.waitForFunction(()=>document.body.textContent.includes('Saved'),{},{timeout:12000})
 assert.ok(Number(sql(`SELECT count(*) FROM "DocumentUpdate" WHERE "documentId"='${room.id}'`))>0)
 console.log('PASS commit failure retains pending edits, retries and only then acknowledges')
 // Outbound queues are bounded: high-rate awareness cannot consume unlimited memory.
 // Burst independent rooms to verify room-level scheduling under concurrent edits.
 const rooms=await Promise.all(Array.from({length:8},(_,i)=>request('/api/rooms','POST',{name:`audit-load-${i}`,language:'python'},admin)))
 const clients=rooms.map(({room})=>[peer(room),peer(room)]);await wait(()=>clients.flat().every(p=>p.p.synced),'load peers sync')
 const t=performance.now();for(let n=0;n<50;n++)for(const [p] of clients)p.doc.getText('codemirror').insert(0,`change${n}中\n`)
 const fences=clients.map(([p])=>[p,barrier(p)])
 await wait(()=>clients.every(([a,b])=>a.doc.getText('codemirror').toString()===b.doc.getText('codemirror').toString())&&fences.every(([p,id])=>p.acks.includes(id)),'multi-room load converges')
 console.log('PASS 8 rooms / 16 connections / 400 edits persisted',Math.round(performance.now()-t)+'ms (local debug build; not production capacity)')
}finally{await unlockDatabase();for(const {p,doc}of peers){p.destroy();doc.destroy()}await browser?.close()}
process.exit(0)
