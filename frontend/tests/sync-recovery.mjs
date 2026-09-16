// Runs its own server against the disposable local test database, never production.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { resolve } from 'node:path'
const API='http://127.0.0.1:55442',WEB='http://127.0.0.1:55443'
const root=resolve('..')
let child,vite,browser,blocker
const wait=async(fn,msg,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){try{if(await fn())return}catch{}await new Promise(r=>setTimeout(r,40))}throw Error(msg)}
const request=async(path,method='GET',data,token)=>{const r=await fetch(API+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:data?JSON.stringify(data):undefined});const body=await r.json();assert.ok(r.ok,`${path}: ${JSON.stringify(body)}`);return body}
const env={...process.env,DATABASE_URL:`postgresql://${process.env.USER}@127.0.0.1:55439/sharecode_sync_test`,PORT:'55442',BIND_ADDRESS:'127.0.0.1',JWT_SECRET:'local-sync-test-key-not-production',ADMIN_USERNAME:'audit_admin',ADMIN_PASSWORD:'LocalAudit#2026Strong',FRONTEND_URL:WEB,APP_URL:WEB}
async function start(){child=spawn(root+'/server-rs/target/debug/sharecode-server',[],{cwd:root,env,stdio:['ignore','ignore','pipe']});child.stderr.on('data',d=>console.error(String(d)));await wait(async()=> (await fetch(API+'/health')).ok,'server starts')}
async function crash(){const p=child;child=null;p.kill('SIGKILL');await new Promise(r=>p.on('exit',r))}
const sql=q=>execFileSync('psql',['-XAt','-h','127.0.0.1','-p','55439','-d','sharecode_sync_test','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'}).trim()
async function lock(){blocker=spawn('psql',['-XAt','-h','127.0.0.1','-p','55439','-d','sharecode_sync_test'],{stdio:['pipe','pipe','pipe']});let out='';blocker.stdout.on('data',d=>out+=d);blocker.stdin.write('BEGIN; LOCK TABLE "DocumentUpdate" IN ACCESS EXCLUSIVE MODE; SELECT \'LOCKED\';\n');await wait(()=>out.includes('LOCKED'),'lock')}
async function unlock(){if(!blocker)return;const p=blocker;blocker=null;p.stdin.end('ROLLBACK;\n');await new Promise(r=>p.on('exit',r))}
async function journalExists(page){return page.evaluate(()=>new Promise(resolve=>{const req=indexedDB.open('sharecode-recovery',1);req.onsuccess=()=>{const db=req.result;const q=db.transaction('pending').objectStore('pending').getAll();q.onsuccess=()=>{resolve(q.result.length>0);db.close()}}}))}
async function modelText(page){return page.evaluate(async()=>{const {loadMonaco}=await import('/src/lib/monaco-loader.ts');const m=await loadMonaco();return m.editor.getModels()[0]?.getValue()})}
async function insert(page,text){await page.evaluate(async(text)=>{const {loadMonaco}=await import('/src/lib/monaco-loader.ts');const m=await loadMonaco();const model=m.editor.getModels()[0];const pos=model.getPositionAt(model.getValueLength());model.applyEdits([{range:new m.Range(pos.lineNumber,pos.column,pos.lineNumber,pos.column),text}])},text)}
try{
 await start();vite=await createServer({server:{host:'127.0.0.1',port:55443,strictPort:true,proxy:{'/api':{target:API,ws:true}}},logLevel:'silent'});await vite.listen()
 const admin=(await request('/api/auth/login','POST',{username:'audit_admin',password:'LocalAudit#2026Strong'})).token
 const room=(await request('/api/rooms','POST',{name:'audit-crash-encoding',language:'python'},admin)).room
 browser=await chromium.launch();const ctx=await browser.newContext();const page=await ctx.newPage();page.on('dialog',d=>d.accept());await page.goto(WEB+'/login');await page.evaluate(token=>{sessionStorage.setItem('sharecode-tab-auth',JSON.stringify({state:{token},version:0}));localStorage.setItem('i18nextLng','en')},admin);await page.goto(WEB+'/room/'+room.id);await page.waitForFunction(()=>document.body.textContent.includes('Saved'))
 const unicode='简体 繁體 日本語 한국어 العربية עברית e\u0301 é 😀 👨‍👩‍👧‍👦 🏳️‍🌈 𠮷\n'
 await insert(page,unicode);await wait(async()=>!(await journalExists(page)),'first edit saved')
 await lock();await insert(page,'uncommitted-before-crash\n');await wait(()=>journalExists(page),'local durable outbox')
 await crash();await unlock();await page.reload(); // recovery loaded while backend is absent
 await start();try { await wait(async()=>await modelText(page)===unicode+'uncommitted-before-crash\n','restored unconfirmed edits'); } catch(e) { console.log('RECOVERY DIAGNOSTIC', {text:await modelText(page),body:(await page.locator('body').innerText()).slice(0,900),pending:await journalExists(page)}); throw e; }await wait(async()=>!(await journalExists(page)),'recovered edit saved')
 assert.ok(Number(sql(`SELECT count(*) FROM "DocumentUpdate" WHERE "documentId"='${room.id}'`))>0)
 console.log('PASS browser reload + SIGKILL during blocked database commit restores local outbox')
 await crash();await start();await page.reload();await wait(async()=>await modelText(page)===unicode+'uncommitted-before-crash\n','saved prefix survives restart')
 console.log('PASS UTF-8/UTF-16 multilingual, combining marks, emoji and supplementary characters survive Rust/PostgreSQL/reload')
 // Wait for a checkpoint, add a tail, then crash and reconstruct snapshot + tail.
 await new Promise(r=>setTimeout(r,5400));await insert(page,'tail-after-checkpoint');await wait(async()=>!(await journalExists(page)),'tail saved');await crash();await start();await page.reload();await wait(async()=> (await modelText(page))?.endsWith('tail-after-checkpoint'),'checkpoint plus tail recovery')
 console.log('PASS checkpoint + committed incremental tail recover exactly')
 const readonly=(await request(`/api/rooms/${room.id}/share-links`,'POST',{canEdit:false},admin)).shareLink
 const guest=await request(`/api/share/${readonly.token}/join`,'POST',{username:'read-only-viewer'})
 const c2=await browser.newContext();const p2=await c2.newPage();await p2.goto(WEB+'/login');await p2.evaluate(token=>{sessionStorage.setItem('sharecode-tab-auth',JSON.stringify({state:{token},version:0}));localStorage.setItem('i18nextLng','en')},guest.token);await p2.goto(WEB+'/room/'+room.id);await wait(async()=>await modelText(p2)===await modelText(page),'read-only late join existing deleted history');assert.equal(await p2.evaluate(async()=>{const {loadMonaco}=await import('/src/lib/monaco-loader.ts');const m=await loadMonaco();return m.editor.getEditors()[0].getOption(m.editor.EditorOption.readOnly)}),true)
 await request(`/api/rooms/${room.id}/share-links/${readonly.id}`,'DELETE',undefined,admin);await p2.waitForFunction(()=>document.body.textContent.includes('revoked'),{},{timeout:3000});console.log('PASS read-only Unicode viewer receives exact content and immediate revoke UI')
}finally{await unlock();await browser?.close();await vite?.close();if(child)await crash()}
process.exit(0)
