// Uses a disposable local API/database. Code runs in the configured Piston sandbox.
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { HocuspocusProvider } from '@hocuspocus/provider'
const API = process.env.RUNNER_TEST_API || 'http://127.0.0.1:55460'
assert.equal(new URL(API).hostname, '127.0.0.1')
const request = async (path, method = 'GET', body, token) => {
  const response = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, body: await response.json() }
}
const ok = async (...args) => { const r = await request(...args); assert.ok(r.status < 300, JSON.stringify(r)); return r.body }
const login = async username => (await ok('/api/auth/login', 'POST', { username, password: 'LocalAudit#2026Strong' })).token
const root = await login('audit_admin')
const actors = {}
for (const [username, role] of [['owner','tech'], ['agent','agent'], ['readonly','tech'], ['outsider','tech'], ['member','tech']]) {
  const { user } = await ok('/api/admin/users', 'POST', { username, role, password: 'LocalAudit#2026Strong' }, root)
  actors[username] = { user, token: await login(username) }
}
const { room } = await ok('/api/rooms', 'POST', { name: 'Language permissions regression', language: 'python' }, actors.owner.token)
// Techs share rooms with each other only through links; the link decides editing.
for (const [actor, canEdit] of [['readonly', false], ['member', true]]) {
  const { shareLink } = await ok(`/api/rooms/${room.id}/share-links`, 'POST', { canEdit }, actors.owner.token)
  await ok(`/api/share/${shareLink.token}/accept`, 'POST', {}, actors[actor].token)
}
const doc = new Y.Doc(), messages = []
let peer = new HocuspocusProvider({ url: API.replace('http', 'ws') + '/api/ws', name: room.id, document: doc, token: actors.readonly.token, onStateless: ({ payload }) => messages.push(JSON.parse(payload)) })
const wait = async predicate => { for (let i=0;i<200;i++) { if(predicate())return; await new Promise(r=>setTimeout(r,25)) } throw Error('Timed out waiting for language synchronization') }
try {
  await wait(() => peer.synced)
  assert.equal(peer.authorizedScope, 'readonly')
  // The owner, agents and admins switch the language, and so does a member whose link lets them edit.
  for (const [token, language] of [[root,'java'], [actors.agent.token,'c'], [actors.member.token,'typescript'], [actors.owner.token,'javascript']]) {
    await ok('/api/rooms/' + room.id, 'PUT', { language }, token)
    await wait(() => messages.at(-1)?.language === language)
    assert.equal((await ok('/api/rooms/' + room.id, 'GET', undefined, actors.owner.token)).room.language, language)
  }
  // Other room settings stay with the owner, agents and admins, even for link members who edit.
  for (const actor of ['member', 'readonly', 'outsider']) {
    if (actor !== 'member') assert.equal((await request('/api/rooms/' + room.id, 'PUT', { language:'python' }, actors[actor].token)).status, 404)
    assert.equal((await request('/api/rooms/' + room.id, 'PUT', { language:'python', name:'not allowed' }, actors[actor].token)).status, 404)
  }
  // Share guests follow their link too: a guest who edits switches the language and nothing else.
  for (const canEdit of [true, false]) {
    const { shareLink } = await ok(`/api/rooms/${room.id}/share-links`, 'POST', { canEdit }, actors.owner.token)
    actors[canEdit ? 'guestWriter' : 'guestReader'] = await ok(`/api/share/${shareLink.token}/join`, 'POST', { username: canEdit ? 'Editing guest' : 'Viewing guest' })
  }
  const updated = await ok('/api/rooms/' + room.id, 'PUT', { language:'go' }, actors.guestWriter.token)
  assert.equal(updated.room.language, 'go'); assert.equal(updated.room.owner, undefined)
  await wait(() => messages.at(-1)?.language === 'go')
  for (const [actor, body] of [['guestWriter', { language:'python', name:'not allowed' }], ['guestWriter', { company:'not allowed' }], ['guestReader', { language:'python' }]])
    assert.equal((await request('/api/rooms/' + room.id, 'PUT', body, actors[actor].token)).status, 403)
  await ok('/api/rooms/' + room.id, 'PUT', { language:'javascript' }, actors.owner.token)
  await wait(() => messages.at(-1)?.language === 'javascript')
  assert.equal((await request('/api/rooms/' + room.id, 'PUT', { language:'bogus' }, root)).status, 400)
  peer.destroy(); messages.length=0
  peer = new HocuspocusProvider({ url: API.replace('http','ws')+'/api/ws', name: room.id, document:doc, token:actors.readonly.token, onStateless:({payload})=>messages.push(JSON.parse(payload)) })
  await wait(() => messages.some(m=>m.type==='room-language' && m.language==='javascript'))
  assert.equal(peer.authorizedScope, 'readonly')
  console.log('PASS owner/agent/admin, editing link members and editing guests switch the language; read-only members and guests and outsiders denied; read-only live sync and reconnect')
  const samples = [
    ['python', 'print(input())'],
    ['java', 'public class Main { public static void main(String[] args) { System.out.println(new java.util.Scanner(System.in).nextLine()); } }'],
    ['c', '#include <stdio.h>\nint main(){char s[100];fgets(s,100,stdin);printf("%s",s);return 0;}'],
    ['cpp', '#include <iostream>\n#include <string>\nint main(){std::string s;std::getline(std::cin,s);std::cout<<s<<std::endl;}'],
    ['javascript', 'console.log(require("fs").readFileSync(0,"utf8").trim())'],
    ['typescript', 'declare function require(name: string): any; const s: string = require("fs").readFileSync(0,"utf8").trim(); console.log(s);'],
  ]
  const health = await ok('/api/code/health')
  assert.equal(health.status, 'ok'); assert.deepEqual(health.missingLanguages, [])
  const languages = (await ok('/api/code/languages')).languages.map(l=>l.id)
  for (const [language_id, source_code] of samples) {
    assert.ok(languages.includes(language_id))
    const result = await ok('/api/code/execute', 'POST', { language_id, source_code, stdin:'runner-ok\n' }, actors.owner.token)
    assert.equal(result.isSuccess, true, JSON.stringify(result)); assert.equal(result.output.trim(), 'runner-ok')
    console.log('PASS execution and stdin:', language_id)
  }
  for (const [language_id, source_code, statusId] of [['c','int main( {',6], ['typescript','const x: number = "wrong"',6], ['python','raise RuntimeError("expected")',11], ['python','while True: pass',5]]) {
    const result = await ok('/api/code/execute', 'POST', { language_id, source_code }, actors.owner.token)
    assert.equal(result.isSuccess, false); assert.equal(result.statusId, statusId, JSON.stringify(result)); assert.ok(result.error || result.output)
    console.log('PASS diagnostics:', language_id, result.status)
  }
  assert.equal((await request('/api/code/execute','POST',{source_code:'print(1)',language_id:'python'})).status,401)
  const web = await createServer({ server:{host:'127.0.0.1',port:55461,strictPort:true,proxy:{'/api':{target:API,changeOrigin:true,ws:true}}}, define:{'import.meta.env.VITE_API_URL':JSON.stringify(API), 'import.meta.env.VITE_WS_URL':JSON.stringify(API.replace('http','ws'))}, logLevel:'error' })
  await web.listen()
  const browser = await chromium.launch()
  try {
    for (const actor of ['agent','readonly','member','guestReader','guestWriter']) {
      const context = await browser.newContext()
      await context.addInitScript(token=>{
        sessionStorage.setItem('sharecode-tab-auth',JSON.stringify({state:{token},version:0}))
        localStorage.setItem('i18nextLng','en')
      },actors[actor].token)
      const page = await context.newPage(), errors=[]
      page.on('pageerror',e=>errors.push(e.message))
      await page.goto('http://127.0.0.1:55461/room/'+room.id)
      await page.locator('.monaco-editor').waitFor()
      const picker=page.getByRole('combobox',{name:'Language',exact:true})
      if(actor==='readonly'||actor==='guestReader') assert.equal(await picker.count(),0)
      else {
        const language = { agent:'python', member:'java', guestWriter:'rust' }[actor]
        await picker.click()
        await page.getByRole('option',{name:language,exact:true}).click()
        await page.waitForFunction(language=>document.querySelector('.editor-statusbar [role=combobox]')?.textContent===language,language)
        assert.equal((await ok('/api/rooms/'+room.id,'GET',undefined,root)).room.language,language)
      }
      assert.deepEqual(errors,[])
      await context.close()
    }
    console.log('PASS browser language picker: agent, editing link member and editing guest change it; read-only member and guest do not see it')
  } finally { await browser.close(); await web.close() }

} finally { peer.destroy(); doc.destroy() }
