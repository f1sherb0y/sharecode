// Requires the disposable localhost stack; never connects to production.
import assert from 'node:assert/strict'
const API='http://127.0.0.1:55440'
async function request(path,method='GET',body,token){const r=await fetch(API+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()}}
const login=await request('/api/auth/login','POST',{username:'audit_admin',password:'LocalAudit#2026Strong'});assert.equal(login.status,200);const token=login.body.token
const name=`duplicate_${Date.now()}`,password='DuplicateCheck#2026Strong',email=name+'@example.invalid'
const create=data=>request('/api/admin/users','POST',{username:name,password,email,role:'user',...data},token)
const first=await create({});assert.equal(first.status,201)
const duplicate=await create({});assert.equal(duplicate.status,400);assert.match(duplicate.body.error,/Username already taken/)
const sameEmail=await create({username:name+'_other'});assert.equal(sameEmail.status,400);assert.match(sameEmail.body.error,/Email already in use/)
assert.equal((await request('/api/admin/users/'+first.body.user.id,'DELETE',undefined,token)).status,200)
const deletedName=await create({});assert.equal(deletedName.status,400);assert.match(deletedName.body.error,/deleted account/)
const deletedEmail=await create({username:name+'_other'});assert.equal(deletedEmail.status,400);assert.match(deletedEmail.body.error,/deleted account/)
assert.equal((await request('/api/auth/login','POST',{username:name,password})).status,401)
const publicDuplicate=await request('/api/auth/register','POST',{username:name,password});assert.equal(publicDuplicate.status,400)
const publicEmail=await request('/api/auth/register','POST',{username:name+'_public',email,password});assert.equal(publicEmail.status,400)
const race=await Promise.all([create({username:name+'_race',email:null}),create({username:name+'_race',email:null})]);assert.deepEqual(race.map(r=>r.status).sort(),[201,400])
console.log('PASS active/deleted duplicate username/email, registration and concurrent creation return 400; deleted identity stays revoked')
