import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const API='http://127.0.0.1:55440',WEB='http://127.0.0.1:55441'
async function api(path,method='GET',data,token){const res=await fetch(API+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:data?JSON.stringify(data):undefined});const body=await res.json();assert.ok(res.ok,JSON.stringify(body));return body}
const token=(await api('/api/auth/login','POST',{username:'audit_admin',password:'LocalAudit#2026Strong'})).token
const room=(await api('/api/rooms','POST',{name:'audit-markdown',language:'markdown'},token)).room
const browser=await chromium.launch()
try{
 const contexts=await Promise.all([browser.newContext(),browser.newContext()]);const pages=[];const errors=[]
 for(const c of contexts){const p=await c.newPage();p.on('dialog',d=>d.accept());p.on('pageerror',e=>errors.push(e.message));await p.goto(WEB+'/login');await p.evaluate(token=>{sessionStorage.setItem('sharecode-tab-auth',JSON.stringify({state:{token},version:0}));localStorage.setItem('i18nextLng','en')},token);await p.goto(WEB+'/room/'+room.id);await p.locator('.ProseMirror[contenteditable=true]').waitFor({timeout:15000});pages.push(p)}
 await pages[0].locator('.ProseMirror').click();await pages[0].keyboard.insertText('中文😀 é collaborative markdown');await pages[1].waitForFunction(()=>document.querySelector('.ProseMirror')?.textContent.includes('collaborative markdown'))
 await pages[1].locator('.ProseMirror').click();await pages[1].keyboard.press('Control+End');await pages[1].keyboard.insertText(' 第二位𠮷');await pages[0].waitForFunction(()=>document.querySelector('.ProseMirror')?.textContent.includes('第二位'))
 const clean = p => p.locator('.ProseMirror').evaluate(el=>{const c=el.cloneNode(true);c.querySelectorAll('.ProseMirror-yjs-cursor').forEach(n=>n.remove());return c.textContent}); assert.equal(await clean(pages[0]),await clean(pages[1]))
 await pages[0].waitForFunction(()=>document.querySelector('[role=status]')?.textContent.includes('Saved'))
 const source=await pages[0].locator('.ProseMirror').innerText()
 await pages[0].reload();await pages[0].waitForFunction(()=>document.querySelector('.ProseMirror')?.textContent.includes('第二位'))
 console.log('PASS markdown canonical XML two-client convergence and reload')
 // Switch through the real UI, retaining serialized content.
 await pages[0].getByRole('combobox').first().click();await pages[0].getByRole('option',{name:'python',exact:true}).click();await pages[0].locator('.monaco-editor').waitFor();const code=await pages[0].evaluate(async()=>{const {loadMonaco}=await import('/src/lib/monaco-loader.ts');return (await loadMonaco()).editor.getModels()[0].getValue()});assert.ok(code.includes('第二位'))
 await pages[0].getByRole('combobox').first().click();await pages[0].getByRole('option',{name:'markdown',exact:true}).click();await pages[0].waitForFunction(()=>document.querySelector('.ProseMirror')?.textContent.includes('第二位'))
 console.log('PASS markdown/code/markdown transition preserves source')
 await pages[0].waitForFunction(()=>document.querySelector('[role=status]')?.textContent.includes('Saved'));await api('/api/rooms/'+room.id+'/end','POST',{},token);await pages[0].waitForURL('**/playback/**');await pages[0].locator('.ProseMirror').waitFor();await pages[0].locator('button').filter({has:pages[0].locator('[aria-label="Go to end"]')}).click()
 await pages[0].waitForFunction(()=>document.querySelector('.ProseMirror')?.textContent.includes('第二位'))
 assert.deepEqual(errors.filter(e=>!e.includes('Canceled')),[])
 console.log('PASS markdown playback initializes from canonical history')
}finally{await browser.close()}
