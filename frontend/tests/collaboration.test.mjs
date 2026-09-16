import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { chromium, firefox } from 'playwright'
import { createServer } from 'vite'
let server
const browsers = []
before(async () => {
  server = await createServer({server:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'error'})
  await server.listen()
  for (const type of [chromium, firefox]) browsers.push(await type.launch())
})
after(async () => {for (const b of browsers) await b.close(); await server?.close()})
for (const engine of ['chromium','firefox']) {
  test(`${engine}: collaborative undo, CRLF projection, unicode and concurrent changes converge`, async () => {
    const page = await browsers[engine==='chromium'?0:1].newPage()
    await page.goto(`${server.resolvedUrls.local[0]}tests/collaboration.html`)
    await page.waitForFunction(()=>window.collaborationTest)
    const result = await page.evaluate(async()=>{
      const {monaco:m,MonacoBinding:Binding,Y}=window.collaborationTest
      const checks=[]
      async function scenario(seed,fn){
        const a=new Y.Doc(),b=new Y.Doc();a.getText('codemirror').insert(0,seed);Y.applyUpdate(b,Y.encodeStateAsUpdate(a))
        const ma=m.editor.createModel(seed),mb=m.editor.createModel(seed)
        const ea=m.editor.create(document.getElementById('a'),{model:ma,occurrencesHighlight:'off'}),eb=m.editor.create(document.getElementById('b'),{model:mb,occurrencesHighlight:'off'})
        const ba=new Binding(m,a.getText('codemirror'),ma,new Set([ea])),bb=new Binding(m,b.getText('codemirror'),mb,new Set([eb]))
        a.on('update',(u,o)=>{if(o!=='remote')Y.applyUpdate(b,u,'remote')});b.on('update',(u,o)=>{if(o!=='remote')Y.applyUpdate(a,u,'remote')})
        await fn({a,b,ma,mb,ea,eb})
        const texts=[ma.getValue(),mb.getValue(),a.getText('codemirror').toString().replace(/\r\n?/g,'\n').replace(/^\ufeff/,''),b.getText('codemirror').toString().replace(/\r\n?/g,'\n').replace(/^\ufeff/,'')]
        checks.push(texts);ba.destroy();bb.destroy();ea.dispose();eb.dispose();ma.dispose();mb.dispose();a.destroy();b.destroy()
      }
      await scenario('',async({ea,eb,ma})=>{ea.trigger('keyboard','type',{text:'abc'});ea.pushUndoStop();eb.setPosition({lineNumber:1,column:1});eb.trigger('keyboard','type',{text:'X'});await ma.undo()})
      await scenario('first\r\nsecond',({ma,mb})=>{ma.setEOL(1);ma.applyEdits([{range:new m.Range(2,7,2,7),text:'A'}]);mb.applyEdits([{range:new m.Range(2,8,2,8),text:'B'}])})
      await scenario('first\nsecond',({a,mb})=>{a.getText('codemirror').insert(0,'pasted\r\n');mb.applyEdits([{range:new m.Range(3,7,3,7),text:'X'}])})
      await scenario('你好😀\n世界',({ma,mb})=>{ma.applyEdits([{range:new m.Range(2,2,2,2),text:'🚀\r\n中'}]);mb.applyEdits([{range:new m.Range(1,3,1,5),text:'🙂'}])})
      await scenario('\ufeff首行\r\n末尾',({ma,mb})=>{ma.applyEdits([{range:new m.Range(1,1,1,1),text:'开头'}]);mb.applyEdits([{range:new m.Range(2,3,2,3),text:'𠮷'}])})
      await scenario('',({ma})=>ma.applyEdits([{range:new m.Range(1,1,1,1),text:'isolated \ud800 x \udc00'}]))
      return checks
    })
    assert.deepEqual(result[0],['X','X','X','X'])
    for(const texts of result) assert.equal(new Set(texts).size,1,JSON.stringify(texts))
    await page.close()
  })
}

test('local recovery survives reload; stale acknowledgement cannot clear a newer edit',async()=>{
  const page=await browsers[0].newPage();await page.goto(`${server.resolvedUrls.local[0]}tests/collaboration.html`);await page.waitForFunction(()=>window.collaborationTest)
  const initial=await page.evaluate(async()=>{
    const {PendingDocument,Y}=window.collaborationTest;const p=await PendingDocument.open('local','room','test-token');const d=new Y.Doc();let updates=[];d.on('update',u=>updates.push(u));d.getText('codemirror').insert(0,'one');await p.append(updates.pop());const version=p.currentVersion;sessionStorage.setItem('test-durable-prefix',JSON.stringify(Array.from(Y.encodeStateAsUpdate(d))));d.getText('codemirror').insert(3,'two');await p.append(updates.pop());await p.acknowledge(version);const pending=p.hasPending;await p.close();return pending
  });assert.equal(initial,true)
  await page.reload();await page.waitForFunction(()=>window.collaborationTest)
  const restored=await page.evaluate(async()=>{const {PendingDocument,Y}=window.collaborationTest;const p=await PendingDocument.open('local','room','test-token'),d=new Y.Doc();Y.applyUpdate(d,Uint8Array.from(JSON.parse(sessionStorage.getItem('test-durable-prefix'))));p.restore(d);const text=d.getText('codemirror').toString();await p.acknowledge(p.currentVersion);await p.close();return text});assert.equal(restored,'onetwo');await page.close()
})
