// Real room language transitions against the disposable API; no production data.
import assert from 'node:assert/strict'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'
const API='http://127.0.0.1:55460'
async function request(path,method='GET',body,token) {
 const r=await fetch(API+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined})
 const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data
}
async function switchLanguage(page, language) {
 const done=page.waitForResponse(r=>r.url().includes('/api/rooms/')&&r.request().method()==='PUT')
 await page.getByRole('combobox',{name:'Language',exact:true}).click()
 await page.getByRole('option',{name:language,exact:true}).click()
 await done
 await page.waitForFunction(language=>document.querySelector('.editor-statusbar [role=combobox]')?.textContent===language,language)
}
const token=(await request('/api/auth/login','POST',{username:'audit_admin',password:'LocalAudit#2026Strong'})).token
const web=await createServer({cacheDir:'node_modules/.vite-markdown-switch',server:{host:'127.0.0.1',port:55461,strictPort:true,proxy:{'/api':{target:API,changeOrigin:true,ws:true}}},logLevel:'error'})
await web.listen()
try {
 for(const [engine,type] of Object.entries({chromium,firefox,webkit})) {
  const browser=await type.launch()
  try {
   const {room}=await request('/api/rooms','POST',{name:'Markdown transition regression',language:'javascript'},token)
   const context=await browser.newContext()
   await context.addInitScript(token=>{sessionStorage.setItem('sharecode-tab-auth',JSON.stringify({state:{token},version:0}));localStorage.setItem('i18nextLng','en')},token)
   const page=await context.newPage(),errors=[]
   page.setDefaultTimeout(20000)
   page.on('pageerror',e=>{errors.push(e.message);console.error(engine,e.stack)})
   page.on('console',m=>{if(m.type()==='error')console.error(engine,m.text())})
   // The WebSocket language event can arrive well before the HTTP response.
   await page.route('**/api/rooms/'+room.id, async route=>{
    if(route.request().method() !== 'PUT') return route.continue()
    const response=await route.fetch();await new Promise(r=>setTimeout(r,750));await route.fulfill({response})
   })
   await page.goto('http://127.0.0.1:55461/room/'+room.id)
   await page.locator('.monaco-editor').waitFor()
   await page.waitForFunction(()=>document.querySelector('.editor-statusbar')?.textContent.includes('Saved'))
   await page.evaluate(async()=>{const {loadMonaco}=await import('/src/lib/monaco-loader.ts');const m=await loadMonaco();m.editor.getModels()[0].setValue('const greeting = "hello";\nconsole.log(greeting);')})
   await page.waitForFunction(()=>document.querySelector('.view-lines')?.textContent.includes('greeting'))
   await switchLanguage(page,'markdown')
   try {await page.locator('.ProseMirror').waitFor();await page.waitForFunction(()=>document.querySelector('.ProseMirror')?.textContent.includes('greeting'))}
   catch(e){console.error('BODY',await page.locator('body').innerText());throw e}
   await page.locator('.ProseMirror').click()
   await page.keyboard.press('Control+End')
   await page.keyboard.insertText(' markdownEdited')
   await page.waitForFunction(()=>document.querySelector('.ProseMirror')?.textContent.includes('markdownEdited'))
   for (const [language, source] of [
    ['javascript', 'const greeting = "second";\nconsole.log(greeting);'],
    ['cpp', '#include <iostream>\nusing namespace std;\nint main() { cout << "greeting"; }'],
    ['typescript', '<div>greeting</div>\nconst greet = <T,>(value: T) => value;'],
    ['python', 'def greeting():\n    return "$100"'],
   ]) {
    await switchLanguage(page,language)
    await page.locator('.monaco-editor').waitFor()
    assert.ok(await page.evaluate(async()=>{const {loadMonaco}=await import('/src/lib/monaco-loader.ts');return (await loadMonaco()).editor.getModels()[0].getValue().includes('greeting')}),'Markdown -> code preserves content')
    if (language === 'javascript') assert.ok(await page.evaluate(async()=>{const {loadMonaco}=await import('/src/lib/monaco-loader.ts');return (await loadMonaco()).editor.getModels()[0].getValue().includes('markdownEdited')}),'New Markdown edits survive switching back to code')
    await page.evaluate(async source=>{const {loadMonaco}=await import('/src/lib/monaco-loader.ts');const m=await loadMonaco();m.editor.getModels()[0].setValue(source)},source)
    await switchLanguage(page,'markdown')
    try {await page.locator('.ProseMirror').waitFor();await page.waitForFunction(()=>document.querySelector('.ProseMirror')?.textContent.includes('greeting'))}
    catch(e){console.error('FAILED SOURCE',language,source,'BODY',await page.locator('body').innerText());throw e}
   }
   await page.evaluate(async()=>{
    const {HocuspocusProvider}=await import('/tests/markdown-switch-peer.ts')
    const {Y}=await import('/tests/markdown-switch-peer.ts')
    const doc=new Y.Doc()
    const token=JSON.parse(sessionStorage.getItem('sharecode-tab-auth')).state.token
    const name=location.pathname.split('/').at(-1)
    const provider=new HocuspocusProvider({url:'ws://'+location.host+'/api/ws',name,token,document:doc})
    await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('peer sync timeout')),10000);provider.on('synced',()=>{clearTimeout(timeout);resolve()})})
    doc.transact(()=>{const fragment=doc.getXmlFragment('prosemirror');fragment.delete(0,fragment.length);doc.getMap('meta').delete('markdownInitialized');doc.getMap('meta').set('markdownSeeder',-1)})
    await new Promise(resolve=>setTimeout(resolve,100))
    provider.destroy();doc.destroy()
   })
   await page.waitForFunction(()=>!document.querySelector('.ProseMirror')?.textContent.includes('greeting'))
   await switchLanguage(page,'python')
   await page.locator('.monaco-editor').waitFor()
   assert.ok(await page.evaluate(async()=>{const {loadMonaco}=await import('/src/lib/monaco-loader.ts');return (await loadMonaco()).editor.getModels()[0].getValue().includes('greeting')}),'Legacy failed initialization must not erase code')
   await switchLanguage(page,'markdown')
   await page.waitForFunction(()=>document.querySelector('.ProseMirror')?.textContent.includes('greeting'))
   assert.deepEqual(errors,[])
   await context.close()
   console.log('PASS',engine,'delayed language responses; JS/C++/TS/Python round trips; Markdown edits retained; old blank-state recovery')
  } finally {await browser.close()}
 }
} finally {await web.close()}
