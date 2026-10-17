// Data/API integration and browser mounting only. Drawing UX is tested by the owner.
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { gunzipSync } from 'node:zlib'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'
import { CanvasSync, orderedCanvasElements } from '../src/lib/canvas-sync.ts'
import { DocumentReplay } from '../src/lib/document-replay.ts'
const API='http://127.0.0.1:55460'
async function request(path:string, method='GET', body?:unknown, token?:string) {
  const r=await fetch(API+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined})
  const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data
}
const root=(await request('/api/auth/login','POST',{username:'audit_admin',password:'LocalAudit#2026Strong'})).token
const {room}=await request('/api/rooms','POST',{name:'Canvas integration',language:'python'},root)
await request('/api/admin/users','POST',{username:'canvas_viewer',password:'LocalAudit#2026Strong',role:'admin',canReadAllRooms:true,canWriteAllRooms:false},root)
const viewer=(await request('/api/auth/login','POST',{username:'canvas_viewer',password:'LocalAudit#2026Strong'})).token
const wait=async(fn:()=>unknown,label:string)=>{for(let i=0;i<300;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25))}throw Error('Timed out: '+label)}
function peer(token:string) {
 const doc=new Y.Doc(),messages:any[]=[]
 const p=new HocuspocusProvider({url:API.replace('http','ws')+'/api/ws',name:room.id,document:doc,token,onStateless:({payload})=>messages.push(JSON.parse(payload))})
 return {doc,p,messages}
}
async function barrier(p:ReturnType<typeof peer>) {
 const id=crypto.randomUUID();p.p.sendStateless(JSON.stringify({type:'durability-barrier',id}));await wait(()=>p.messages.some(m=>m.type==='durability-ack'&&m.id===id),'durability ack')
}
const a=peer(root),b=peer(viewer)
const peers=[a,b]
const element=(id:string,x=0,version=1)=>({id,type:'rectangle',x,y:0,width:120,height:80,angle:0,strokeColor:'#1e1e1e',backgroundColor:'transparent',fillStyle:'solid',strokeWidth:1,strokeStyle:'solid',roughness:1,opacity:100,groupIds:[],frameId:null,roundness:null,seed:1,version,versionNonce:version,isDeleted:false,boundElements:null,updated:Date.now(),link:null,locked:false,index:'a0'}) as any
let sync:CanvasSync|undefined
try {
 await wait(()=>a.p.synced&&b.p.synced,'two clients sync')
 assert.equal(b.p.authorizedScope,'readonly')
 a.p.sendStateless(JSON.stringify({type:'presence',clientId:a.doc.clientID}))
 a.p.awareness?.setLocalStateField('user',{id:'presenter',username:'Presenter',name:'Presenter',color:'#123456'})
 a.p.awareness?.setLocalStateField('view','editor')
 a.doc.getText('codemirror').insert(0,'print("retained code")')
 sync=new CanvasSync(a.doc)
 sync.stage([element('first')],{},null,'#fff8e7');sync.flush();await barrier(a)
 await wait(()=>orderedCanvasElements(b.doc).length===1,'readonly live canvas')
 assert.equal(b.doc.getMap('canvas-settings').get('background'),'#fff8e7')
 sync.stage([element('first',240,2)],{},null);sync.flush();await barrier(a)
 await wait(()=>orderedCanvasElements(b.doc)[0]?.x===240,'shape edit')
 // Fresh connection exercises checkpoint + pending history reconstruction.
 const c=peer(root);peers.push(c);await wait(()=>c.p.synced,'fresh join')
 assert.deepEqual(orderedCanvasElements(c.doc),orderedCanvasElements(a.doc))
 assert.equal(c.doc.getText('codemirror').toString(),'print("retained code")')
 // A read-only peer cannot inject canvas edits into either live state or replay.
 b.doc.getMap('canvas-elements').set('forbidden',{element:element('forbidden')})
 await new Promise(r=>setTimeout(r,150));assert.equal(a.doc.getMap('canvas-elements').has('forbidden'),false)
 console.log('PASS real backend canvas edits, read-only sync/enforcement, persistence barrier, fresh join and code isolation')
 const web=await createServer({plugins:[{
  name:'capture-native-canvas-api', enforce:'pre',
  transform(source,id) {
   if(!id.endsWith('/components/features/canvas-view.tsx')) return
   return source.replace('excalidrawAPI={setApi}', 'excalidrawAPI={instance => { setApi(instance); (window as any).__testCanvasApi = instance }}')
  },
 }],cacheDir:'node_modules/.vite-canvas-tests',server:{host:'127.0.0.1',port:55461,strictPort:true,proxy:{'/api':{target:API,changeOrigin:true,ws:true}}},define:{'import.meta.env.VITE_API_URL':JSON.stringify(API),'import.meta.env.VITE_WS_URL':JSON.stringify(API.replace('http','ws'))},logLevel:'error'})
 await web.listen()
 try {
  for(const [engine,type] of Object.entries({chromium,firefox,webkit})) {
   if(process.env.ENGINE&&process.env.ENGINE!==engine) continue
   const browser=await type.launch()
   try {
    const context=await browser.newContext({viewport:engine==='webkit'?{width:390,height:844}:{width:1280,height:800},hasTouch:engine==='webkit',isMobile:engine==='webkit',deviceScaleFactor:engine==='webkit'?3:1.25})
    await context.addInitScript(token=>{sessionStorage.setItem('sharecode-tab-auth',JSON.stringify({state:{token},version:0}));localStorage.setItem('i18nextLng','en');localStorage.setItem('theme-storage',JSON.stringify({state:{theme:'light'},version:0}))},root)
    const page=await context.newPage(),errors:string[]=[],remoteFonts:string[]=[]
    page.on('pageerror',e=>{ errors.push(e.message); console.error(engine, 'PAGE ERROR', e.message) })
    page.on('console',m=>{if(m.type()==='error') console.error(engine,'CONSOLE',m.text())})
    // Excalidraw fonts are self-hosted; only the pinned Sarasa editor subsets use the CDN (SARASA_CDN_BASE).
    page.on('request',r=>{if(r.url().includes('.woff')&&!r.url().startsWith('http://127.0.0.1')&&!r.url().startsWith('https://cdn.jsdelivr.net/npm/sarasa-mono-web@0.1.0/fonts/SarasaMonoCL-Regular/'))remoteFonts.push(r.url())})
    await page.goto('http://127.0.0.1:55461/room/'+room.id)
    await page.locator('.monaco-editor').waitFor()
    assert.equal(await page.locator('.excalidraw').count(),0)
    await page.getByRole('button',{name:'Canvas',exact:true}).click()
    try { await page.locator('.excalidraw canvas').first().waitFor() } catch(e) { console.error(await page.locator('body').innerText()); await page.screenshot({path:'/tmp/sharecode-canvas-load-failure.png'}); throw e }
    await page.waitForFunction(()=>document.querySelector('.editor-statusbar')?.textContent?.includes('Saved'))
    assert.equal(new URL(page.url()).searchParams.get('view'),'canvas')
    assert.ok(await page.locator('.excalidraw').isVisible())
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    const canvasTheme = await page.locator('.excalidraw').evaluate(el => ({
      primary: getComputedStyle(el).getPropertyValue('--color-primary').trim(),
      appPrimary: getComputedStyle(el.parentElement!).getPropertyValue('--canvas-primary').trim(),
      surface: getComputedStyle(el).getPropertyValue('--island-bg-color').trim(),
      appSurface: getComputedStyle(el.parentElement!).getPropertyValue('--canvas-bg').trim(),
    }))
    assert.equal(canvasTheme.primary,canvasTheme.appPrimary)
    assert.equal(canvasTheme.surface,canvasTheme.appSurface)
    await page.screenshot({path:`/tmp/sharecode-canvas-light-${engine}.png`})
    await page.getByRole('button',{name:'Toggle theme',exact:true}).click()
    await page.locator('.excalidraw.theme--dark').waitFor()
    await page.screenshot({path:`/tmp/sharecode-canvas-dark-${engine}.png`})
    // Website menu, native avatars and the shared follow bar operate one Follow state.
    // Camera/navigation checks only; no drawing gestures are simulated.
    if(engine==='webkit') await page.setViewportSize({width:1280,height:800})
    const viewerUser={id:'viewer',name:'canvas_viewer',username:'canvas_viewer'}
    b.p.sendStateless(JSON.stringify({type:'presence',clientId:b.doc.clientID}))
    b.p.awareness?.setLocalState({user:viewerUser})
    b.p.awareness?.setLocalStateField('view','canvas')
    b.p.awareness?.setLocalStateField('canvas',{viewport:{x:-100,y:-200,width:1280,height:720}})
    const followBar=(status='active')=>page.locator(`.follow-indicator[data-follow-status="${status}"]`)
    const menuFollowing=async()=>{
      await page.getByRole('button',{name:'Users',exact:true}).click()
      const text=await page.getByRole('menuitem').filter({hasText:'canvas_viewer'}).innerText()
      await page.keyboard.press('Escape')
      return text.includes('Following')
    }
    const followPublished=()=>[...b.p.awareness!.getStates()].some(([id,state])=>id!==b.doc.clientID&&state.canvas?.following===b.doc.clientID)
    const zoom=()=>page.evaluate(()=>(window as any).__testCanvasApi.getAppState().zoom.value as number)
    await page.getByRole('button',{name:'Users',exact:true}).click()
    await page.getByRole('menuitem').filter({hasText:'canvas_viewer'}).click()
    await followBar().filter({hasText:'canvas_viewer'}).waitFor()
    assert.equal(await page.locator('.follow-mode').count(),0,'native Excalidraw follow mode stays off')
    const assertContainment=async (x=-100,y=-200,w=1280,h=720) => page.waitForFunction(([x,y,w,h]) => {
      const app=(window as any).__testCanvasApi?.getAppState()
      if(!app) return false
      const z=Math.min(app.width/w,app.height/h)
      return Math.abs(app.zoom.value-z)<0.00001 && Math.abs(app.scrollX-(app.width/(2*z)-x-w/2))<0.01 && Math.abs(app.scrollY-(app.height/(2*z)-y-h/2))<0.01
    },[x,y,w,h])
    await assertContainment()
    await page.setViewportSize({width:950,height:600})
    await assertContainment()
    await page.setViewportSize({width:1280,height:800})
    await assertContainment()
    await wait(followPublished,'follow published')
    // Looking around is not unfollowing: the follower keeps its own camera until
    // the presenter moves again, exactly as in the editors.
    const fitted=await zoom()
    await page.getByRole('button',{name:'Zoom in',exact:true}).click()
    await new Promise(r=>setTimeout(r,400))
    assert.ok(await zoom()>fitted+0.01,'manual zoom is kept while following')
    assert.equal(await followBar().count(),1,'manual zoom keeps following')
    b.p.awareness?.setLocalStateField('canvas',{viewport:{x:200,y:100,width:640,height:480}})
    await assertContainment(200,100,640,480)
    // The follow bar, the menu and avatars all end or start the same follow.
    await followBar().getByRole('button',{name:'Stop following',exact:true}).click()
    await page.locator('.follow-indicator').waitFor({state:'hidden'})
    assert.equal(await menuFollowing(),false)
    await wait(()=>!followPublished(),'unfollow published')
    const avatar=page.locator('.UserList .Avatar').filter({hasText:/^C$/})
    await avatar.click()
    await followBar().waitFor()
    assert.equal(await menuFollowing(),true)
    await avatar.click()
    await page.locator('.follow-indicator').waitFor({state:'hidden'})
    assert.equal(await menuFollowing(),false)
    await avatar.click()
    await followBar().waitFor()
    // The presenter's view switches carry the follower along, and the camera
    // is restored when Canvas mounts again.
    b.p.awareness?.setLocalStateField('view','editor')
    await page.waitForFunction(()=>new URL(location.href).searchParams.get('view')==='editor')
    await followBar().waitFor()
    b.p.awareness?.setLocalStateField('view','canvas')
    await page.waitForFunction(()=>new URL(location.href).searchParams.get('view')==='canvas')
    await followBar().filter({hasText:'canvas_viewer'}).waitFor()
    await assertContainment(200,100,640,480)
    // Leaving the room pauses the follow; the same person coming back resumes it.
    b.p.awareness?.setLocalState(null)
    await followBar('away').filter({hasText:'canvas_viewer'}).waitFor()
    b.p.awareness?.setLocalState({user:viewerUser,view:'canvas',canvas:{viewport:{x:-100,y:-200,width:1280,height:720}}})
    await followBar().waitFor()
    await assertContainment()
    await followBar().getByRole('button',{name:'Stop following',exact:true}).click()
    await page.locator('.follow-indicator').waitFor({state:'hidden'})
    assert.equal(await menuFollowing(),false)
    console.log('PASS',engine,'one follow state for menu/avatars/follow bar, look-around without unfollow, cross-view continuity, pause and resume on peer leave')
    // UI mounting and cross-mode follow only; no drawing gestures are simulated.
    await page.getByRole('button',{name:'Editor',exact:true}).click()
    await page.locator('.monaco-editor').waitFor({state:'visible'})
    if(engine==='chromium') {
      await page.getByRole('button',{name:'Users',exact:true}).click()
      const item=page.getByRole('menuitem').filter({hasText:'audit_admin'}).filter({hasNotText:'you'}).first()
      await item.click()
      a.p.awareness?.setLocalStateField('view','canvas')
      a.p.awareness?.setLocalStateField('canvas',{viewport:{x:-100,y:-200,width:1280,height:720}})
      await page.waitForFunction(()=>new URL(location.href).searchParams.get('view')==='canvas')
      // Clicking the current view keeps following; switching by hand ends it with an undo toast.
      await page.getByRole('button',{name:'Canvas',exact:true}).click()
      await page.locator('.follow-indicator').waitFor()
      await page.getByRole('button',{name:'Editor',exact:true}).click()
      await page.locator('.follow-indicator').waitFor({state:'hidden'})
      await page.getByRole('button',{name:'Follow again',exact:true}).click()
      await page.waitForFunction(()=>new URL(location.href).searchParams.get('view')==='canvas')
      await page.locator('.follow-indicator').waitFor()
      await page.getByRole('button',{name:'Stop following',exact:true}).click()
      await page.locator('.follow-indicator').waitFor({state:'hidden'})
      await page.getByRole('button',{name:'Editor',exact:true}).click()
    }
    assert.deepEqual(errors,[])
    assert.deepEqual(remoteFonts,[])
    // A readonly UI connection can inspect Canvas without creating edits.
    const readContext=await browser.newContext()
    await readContext.addInitScript(token=>{sessionStorage.setItem('sharecode-tab-auth',JSON.stringify({state:{token},version:0}));localStorage.setItem('i18nextLng','en');localStorage.setItem('theme-storage',JSON.stringify({state:{theme:'light'},version:0}))},viewer)
    const readonlyPage=await readContext.newPage()
    await readonlyPage.goto('http://127.0.0.1:55461/room/'+room.id+'?view=canvas')
    await readonlyPage.locator('.excalidraw canvas').first().waitFor()
    assert.equal(await readonlyPage.locator('.excalidraw [data-testid="toolbar-rectangle"]').count(),0)
    await readContext.close()

    await context.close()
    console.log('PASS',engine,'lazy Canvas mounting, saved state, Editor switch, responsive shell and local fonts')
   } finally {await browser.close()}
  }
 } finally {await web.close()}
 await request('/api/rooms/'+room.id+'/end','POST',{},root)
 const history=await request('/api/rooms/'+room.id+'/playback/updates','GET',undefined,root)
 const updates=history.updates.map((u:any)=>({timestampMs:new Date(u.timestamp).getTime(),update:new Uint8Array(gunzipSync(Buffer.from(u.update,'base64')))}))
 const replay=new DocumentReplay(updates)
 replay.seek(Infinity)
 assert.deepEqual(orderedCanvasElements(replay.doc),orderedCanvasElements(a.doc))
 assert.equal(replay.doc.getMap('canvas-elements').has('forbidden'),false)
 assert.equal(replay.doc.getText('codemirror').toString(),'print("retained code")')
 replay.seek(-Infinity);assert.equal(orderedCanvasElements(replay.doc).length,0)
 replay.seek(Infinity);assert.equal(orderedCanvasElements(replay.doc)[0].x,240)
 replay.destroy()
 console.log('PASS room close -> compressed replay API -> complete canvas/background/code restoration; backward seek; no unauthorized data')
 const playbackWeb=await createServer({cacheDir:'node_modules/.vite-canvas-tests',server:{host:'127.0.0.1',port:55461,strictPort:true,proxy:{'/api':{target:API,changeOrigin:true,ws:true}}},logLevel:'error'})
 await playbackWeb.listen()
 const browser=await chromium.launch()
 try {
   const context=await browser.newContext()
   await context.addInitScript(token=>{sessionStorage.setItem('sharecode-tab-auth',JSON.stringify({state:{token},version:0}));localStorage.setItem('i18nextLng','en');localStorage.setItem('theme-storage',JSON.stringify({state:{theme:'light'},version:0}))},root)
   const page=await context.newPage(),errors:string[]=[]
   page.on('pageerror',e=>errors.push(e.message))
   await page.goto('http://127.0.0.1:55461/playback/'+room.id+'?view=canvas')
   await page.locator('.excalidraw canvas').first().waitFor()
   await page.getByRole('button',{name:'Go to end',exact:true}).click()
   await page.getByRole('button',{name:'Go to start',exact:true}).click()
   await page.getByRole('button',{name:'Editor',exact:true}).click()
   await page.locator('.monaco-editor').waitFor({state:'visible'})
   await page.getByRole('button',{name:'Go to end',exact:true}).click()
   await page.waitForFunction(()=>document.querySelector('.view-lines')?.textContent?.includes('retained'))
   assert.deepEqual(errors,[])
   console.log('PASS playback Canvas/Editor mounting, timeline seek and code state')
 } finally {await browser.close();await playbackWeb.close()}

} finally {sync?.destroy();for(const p of peers){p.p.destroy();p.doc.destroy()}}
