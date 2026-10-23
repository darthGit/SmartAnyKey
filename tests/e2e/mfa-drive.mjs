// Live drive for two-factor sign-in, on throwaway users:
//   an admin under the policy is sent to set up an authenticator, sets it up with the QR key,
//   signs out, signs in again with the code; the server refuses a password-only token; the
//   admin page shows the 2FA column and the policy, and resets another user's factor.
// Not @playwright/test — a plain runnable script, like scan-stop-drive.mjs.
// Needs: `pnpm dev` (http://localhost:3000), the stack, the root .env.
// Run: node tests/e2e/mfa-drive.mjs [shotDir]
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'
import { totp } from '../helpers/totp.mjs'

for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0 && !line.startsWith('#'))
    process.env[line.slice(0, i)] ??= line.slice(i + 1)
}
const BASE = 'http://localhost:3000'
const SHOTS = process.argv[2] || '/tmp'
const PASSWORD = 'mfa-drive-pass-123'
const service = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

let failed = 0
const check = (what, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what} — ${detail}`); if (!ok) failed++ }

async function makeUser(tag, role) {
  const email = `mfa-drive-${tag}-${process.pid}@test.local`
  const { data, error } = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })
  if (error)
    throw new Error(`createUser: ${error.message}`)
  await service.from('profiles').upsert({ user_id: data.user.id, role })
  return { id: data.user.id, email }
}

// A code from the next 30 s window: the server does not accept the same code twice.
async function freshCode(secret) {
  const left = 30_000 - (Date.now() % 30_000)
  await new Promise(r => setTimeout(r, left + 500))
  return totp(secret)
}

async function passwordToken(email) {
  const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false } })
  const { data, error } = await c.auth.signInWithPassword({ email, password: PASSWORD })
  if (error)
    throw new Error(`signIn: ${error.message}`)
  return data.session.access_token
}

const api = (path, token) => fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  .then(async r => ({ status: r.status, body: await r.text() }))

const { data: saved } = await service.from('app_settings').select('mfa_required_role').single()
await service.from('app_settings').update({ mfa_required_role: 'admin' }).eq('id', true)
const admin = await makeUser('admin', 'admin')
const other = await makeUser('other', 'operator')
const browser = await chromium.launch()

try {
  // The other user gets a factor through the API, so the admin has something to reset.
  {
    const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false } })
    await c.auth.signInWithPassword({ email: other.email, password: PASSWORD })
    const { data: f } = await c.auth.mfa.enroll({ factorType: 'totp' })
    await c.auth.mfa.challengeAndVerify({ factorId: f.id, code: totp(f.totp.secret) })
  }

  const r0 = await api('/api/admin/users', await passwordToken(admin.email))
  check('server refuses an unenrolled admin', r0.status === 403 && r0.body.includes('mfa_enroll_required'), `${r0.status} ${r0.body.slice(0, 80)}`)

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  page.on('pageerror', e => console.log('PAGEERROR:', e.message))
  await page.goto(`${BASE}/login`)
  await page.locator('input[type=email]').fill(admin.email)
  await page.locator('input[type=password]').fill(PASSWORD)
  await page.locator('button[type=submit]').click()
  await page.waitForURL(u => u.pathname === '/account', { timeout: 20000 })
  await page.getByText(/Your role requires two-factor|Ваша роль вимагає/).waitFor()
  await page.screenshot({ path: `${SHOTS}/mfa-1-forced.png` })
  check('unenrolled admin is sent to /account', true, `${SHOTS}/mfa-1-forced.png`)

  await page.getByRole('button', { name: /Set up authenticator app|Налаштувати автентифікатор/ }).click()
  const secret = (await page.locator('code').first().textContent()).trim()
  await page.screenshot({ path: `${SHOTS}/mfa-2-qr.png` })
  check('QR and key shown', /^[A-Z2-7]{16,}$/.test(secret) && await page.locator('img[alt]').first().isVisible(), `${SHOTS}/mfa-2-qr.png`)
  await page.locator('input[autocomplete=one-time-code]').fill('000000')
  await page.getByRole('button', { name: /^(Turn on|Увімкнути)$/ }).click()
  const wrong = await page.getByText(/Wrong code|Невірний код/).waitFor({ timeout: 5000 }).then(() => true, () => false)
  check('wrong first code is rejected', wrong, 'error shown')
  await page.locator('input[autocomplete=one-time-code]').fill(totp(secret))
  await page.getByRole('button', { name: /^(Turn on|Увімкнути)$/ }).click()
  await page.waitForURL(u => u.pathname === '/', { timeout: 20000 })
  check('after enrollment the board opens', true, page.url())

  await page.getByRole('button', { name: /^(Sign out|Вийти)$/ }).click()
  await page.waitForURL(u => u.pathname === '/login', { timeout: 15000 })
  await page.locator('input[type=email]').fill(admin.email)
  await page.locator('input[type=password]').fill(PASSWORD)
  await page.locator('button[type=submit]').click()
  await page.locator('input[autocomplete=one-time-code]').waitFor({ timeout: 15000 })
  await page.screenshot({ path: `${SHOTS}/mfa-3-code-step.png` })
  check('sign-in asks for the code', true, `${SHOTS}/mfa-3-code-step.png`)

  const r1 = await api('/api/admin/users', await passwordToken(admin.email))
  check('server refuses a password-only token of an enrolled user', r1.status === 403 && r1.body.includes('mfa_required'), `${r1.status}`)

  await page.locator('input[autocomplete=one-time-code]').fill(await freshCode(secret))
  await page.getByRole('button', { name: /^(Verify|Підтвердити)$/ }).click()
  await page.getByRole('button', { name: /^(Sign out|Вийти)$/ }).waitFor({ timeout: 20000 })
  const aal = await page.evaluate(() => {
    const raw = Object.entries(localStorage).find(([k]) => k.includes('auth-token'))?.[1]
    const tok = raw && JSON.parse(raw).access_token
    return tok ? JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).aal : 'cookie'
  }).catch(() => 'unknown')
  check('the code opens the board', page.url() === `${BASE}/`, `aal in the browser session: ${aal}`)
  await page.screenshot({ path: `${SHOTS}/mfa-4-board.png` })

  await page.goto(`${BASE}/admin/users`)
  const row = page.locator('tr', { hasText: other.email })
  await row.waitFor({ timeout: 15000 })
  await page.screenshot({ path: `${SHOTS}/mfa-5-admin-users.png`, fullPage: true })
  check('admin page shows the policy and 2FA column', await page.getByText(/Require two-factor sign-in for|обов.язковий для/).isVisible(), `${SHOTS}/mfa-5-admin-users.png`)
  page.once('dialog', d => d.accept())
  await row.getByRole('button', { name: /Reset 2FA|Скинути 2FA/ }).click()
  await row.getByRole('button', { name: /Reset 2FA|Скинути 2FA/ }).waitFor({ state: 'detached', timeout: 10000 })
  const { data: left } = await service.auth.admin.mfa.listFactors({ userId: other.id })
  check('admin reset removes the other user\'s factor', (left?.factors ?? []).length === 0, `${(left?.factors ?? []).length} factor(s) left`)
}
finally {
  await browser.close()
  await service.from('app_settings').update({ mfa_required_role: saved?.mfa_required_role ?? null }).eq('id', true)
  for (const u of [admin, other]) await service.auth.admin.deleteUser(u.id).catch(() => {})
}
process.exit(failed ? 1 : 0)
