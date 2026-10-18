// Requires the disposable localhost stack; never connects to production.
import assert from 'node:assert/strict'
const API='http://127.0.0.1:55440'
async function request(path,method='GET',body,token){const r=await fetch(API+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()}}
const login=await request('/api/auth/login','POST',{username:'audit_admin',password:'LocalAudit#2026Strong'});assert.equal(login.status,200);const token=login.body.token
const name=`duplicate_${Date.now()}`,password='DuplicateCheck#2026Strong'
const create=data=>request('/api/admin/users','POST',{username:name,password,role:'tech',...data},token)
const first=await create({});assert.equal(first.status,201);assert.equal('email' in first.body.user,false)
const duplicate=await create({});assert.equal(duplicate.status,400);assert.match(duplicate.body.error,/Username already taken/)
// Accounts have no email any more: one sent along is ignored, so it can repeat.
const mailed=[await create({username:name+'_mail',email:name+'@example.invalid'}),await create({username:name+'_mail2',email:name+'@example.invalid'})]
assert.deepEqual(mailed.map(r=>[r.status,'email' in r.body.user]),[[201,false],[201,false]])
assert.equal((await request('/api/admin/users/'+first.body.user.id,'DELETE',undefined,token)).status,200)
const deletedName=await create({});assert.equal(deletedName.status,400);assert.match(deletedName.body.error,/deleted account/)
assert.equal((await request('/api/auth/login','POST',{username:name,password})).status,401)
const invite=(await request('/api/invites','POST',{},token)).body.invite
const publicDuplicate=await request('/api/auth/register','POST',{username:name,password,inviteCode:invite.code});assert.equal(publicDuplicate.status,400)
const race=await Promise.all([create({username:name+'_race'}),create({username:name+'_race'})]);assert.deepEqual(race.map(r=>r.status).sort(),[201,400])
console.log('PASS active/deleted duplicate usernames, registration and concurrent creation return 400; deleted identity stays revoked; emails are ignored')
