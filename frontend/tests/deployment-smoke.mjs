// Public read-only checks: no login, fixtures or application writes.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { chromium, firefox, webkit } from 'playwright'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const base = new URL(process.argv[2] || 'https://collabcode.cc').origin
const out = await mkdtemp(join(tmpdir(), 'sharecode-deployment-smoke-'))
console.log('Public smoke artifacts:', out)
const results=[]
for(const [name,engine] of Object.entries({chromium,firefox,webkit})) {
 const browser=await engine.launch()
 try {
  for(const mobile of [false,true]) {
   const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:900},deviceScaleFactor:mobile?3:1,colorScheme:mobile?'dark':'light',isMobile:mobile&&name!=='firefox',hasTouch:mobile})
   try {
    const page=await context.newPage(),errors=[],failures=[]
    page.on('pageerror',e=>errors.push(e.message))
    page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('/api/auth/refresh'))failures.push([r.url(),r.status()])})
    await page.goto(base + '/login')
    await page.locator('#username').waitFor()
    assert.equal(await page.locator('#username').getAttribute('autocomplete'),'username')
    assert.equal(await page.locator('#password').getAttribute('autocomplete'),'current-password')
    assert.equal(await page.evaluate(()=>document.documentElement.getAttribute('data-theme') === 'dark'),mobile)
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
    const refresh=await page.evaluate(async()=>{const r=await fetch('/api/auth/refresh',{method:'POST',credentials:'include',headers:{'X-Sharecode-Client':'web'}});return r.status})
    assert.equal(refresh,401)
    assert.equal((await context.request.get(base + '/api/rooms')).status(),401)
    const health = await context.request.get(base + '/api/code/health')
    assert.equal(health.status(),200)
    const runner = await health.json()
    assert(runner.status === 'ok' || runner.available || runner.success || runner.healthy)
    assert.deepEqual(errors,[]);assert.deepEqual(failures,[])
    await page.screenshot({path:`${out}/${name}-${mobile?'mobile':'desktop'}.png`})
    results.push({engine:name,mobile,login:true,autofill:true,systemTheme:true,layout:true,anonymousRefreshDenied:true,noPageErrors:true})
   } finally {await context.close()}
  }
 } finally {await browser.close()}
 console.log('PASS',name)
}
await writeFile(`${out}/results.json`,JSON.stringify(results,null,2)+'\n')
