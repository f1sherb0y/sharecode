// Mock API, no real accounts. Native save-password bubbles require a normal browser profile.
import assert from 'node:assert/strict'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'
const user = { id: 'autofill-user', username: 'autofill_user', role: 'superuser', color: '#218568' }
const password = 'Autofill#2026Strong'
const web = await createServer({ cacheDir: 'node_modules/.vite-autofill-tests', server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
await web.listen()
async function open(browser, path, authenticated = false) {
  const context = await browser.newContext()
  await context.addInitScript(authenticated => {
    localStorage.setItem('i18nextLng', 'en')
    if (authenticated) sessionStorage.setItem('sharecode-tab-auth', JSON.stringify({ state: { token: 'fixture-token' }, version: 0 }))
  }, authenticated)
  const submissions = [], errors = []
  let rejectLogin = true
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (request.method() === 'POST') {
      submissions.push({ path, body: request.postDataJSON() })
      if (path === '/api/auth/login' && rejectLogin) {
        rejectLogin = false
        return route.fulfill({ status: 401, json: { error: 'Invalid credentials' } })
      }
      return route.fulfill({ json: { user, token: 'fixture-token', message: 'Password updated' } })
    }
    let data = {}
    if (path.includes('registration')) data = { allowRegistration: true }
    else if (path === '/api/auth/profile') data = { actorType: 'user', user }
    else if (path === '/api/admin/users') data = { users: [user], pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 } }
    else if (path === '/api/rooms') data = { rooms: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 } }
    else if (path.includes('notifications')) data = { notifications: [] }
    return route.fulfill({ json: data })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
  await page.goto(web.resolvedUrls.local[0] + path)
  return { context, page, submissions, errors }
}
async function autofill(form, values) {
  // Deliberately no input/change events, as with some password managers.
  await form.evaluate((form, values) => {
    for (const [name, value] of Object.entries(values)) form.elements.namedItem(name).value = value
  }, values)
}
async function semantics(form, fields) {
  assert.equal(await form.getAttribute('method'), 'post')
  for (const [name, autocomplete] of Object.entries(fields)) assert.equal(await form.locator(`[name="${name}"]`).getAttribute('autocomplete'), autocomplete)
}
async function submit(page, form, path) {
  const done = page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === 'POST')
  await form.locator('button[type=submit]').click()
  await done
}
try {
  for (const [engine, type] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await type.launch()
    try {
      {
        const { context, page, submissions, errors } = await open(browser, 'login')
        const form = page.locator('#login-form')
        await semantics(form, { username: 'username', password: 'current-password' })
        await autofill(form, { username: user.username, password })
        await submit(page, form, '/api/auth/login')
        await page.getByText('Incorrect username or password.', { exact: true }).waitFor()
        assert.equal(await form.locator('[name=password]').inputValue(), password)
        assert.equal(new URL(page.url()).pathname, '/login')
        await submit(page, form, '/api/auth/login')
        await page.waitForURL('**/rooms')
        assert.equal(await form.count(), 0)
        assert.deepEqual(submissions.map(s => s.body), [{ username: user.username, password }, { username: user.username, password }])
        assert.deepEqual(errors, [])
        await context.close()
      }
      {
        const { context, page, submissions, errors } = await open(browser, 'register')
        const form = page.locator('#register-form')
        await semantics(form, { username: 'username', email: 'email', password: 'new-password' })
        const fields = { username: user.username, password, email: 'autofill@example.invalid' }
        await autofill(form, fields)
        await submit(page, form, '/api/auth/register')
        await page.waitForURL('**/rooms')
        assert.deepEqual(submissions[0].body, fields)
        assert.deepEqual(errors, [])
        await context.close()
      }
      {
        const { context, page, submissions, errors } = await open(browser, 'settings', true)
        const form = page.locator('#change-password-form')
        await semantics(form, { username: 'username', currentPassword: 'current-password', newPassword: 'new-password', confirmPassword: 'new-password' })
        assert.equal(await form.locator('[name=username]').inputValue(), user.username)
        await autofill(form, { currentPassword: password, newPassword: 'NewAutofill#2026Strong', confirmPassword: 'NewAutofill#2026Strong' })
        await submit(page, form, '/api/auth/change-password')
        await page.waitForFunction(() => document.querySelector('#newPassword').value === '')
        assert.deepEqual(submissions[0].body, { oldPassword: password, newPassword: 'NewAutofill#2026Strong' })
        assert.deepEqual(errors, [])
        await context.close()
      }
      {
        const { context, page, submissions, errors } = await open(browser, 'admin', true)
        await page.getByRole('button', { name: 'Create User', exact: true }).click()
        const form = page.locator('#create-user-form')
        await semantics(form, { username: 'username', password: 'new-password', email: 'email' })
        await autofill(form, { username: 'new_user', password, email: 'new@example.invalid' })
        await submit(page, form, '/api/admin/users')
        await form.waitFor({ state: 'hidden' })
        assert.equal(submissions[0].body.username, 'new_user')
        assert.equal(submissions[0].body.password, password)
        assert.equal(submissions[0].body.email, 'new@example.invalid')
        assert.deepEqual(errors, [])
        await context.close()
      }
      console.log('PASS', engine, 'autofill login/retry, registration, password update, admin creation')
    } finally { await browser.close() }
  }
} finally { await web.close() }
