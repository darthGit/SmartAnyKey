// Live drive for /admin/devices by point: pick a point once, see and manage its devices.
// Not @playwright/test — a plain runnable script, like device-edit-drive.mjs.
// Needs: `pnpm dev` (http://localhost:3000), an admin login, a point with devices.
// Run: node tests/e2e/devices-by-point-drive.mjs [pointNumber] [otherPointNumber] [shotDir]
// Env: DRIVE_EMAIL / DRIVE_PASSWORD (default: the dev seed admin).
import { chromium } from 'playwright'

const URL = 'http://localhost:3000'
const POINT = process.argv[2] || '142'
const OTHER = process.argv[3] || '9999'
const SHOTS = process.argv[4] || '/tmp'
const EMAIL = process.env.DRIVE_EMAIL || 'dev@smartanykey.local'
const PASSWORD = process.env.DRIVE_PASSWORD || 'devpassword123'

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage()
page.on('pageerror', e => console.log('PAGEERROR:', e.message))
let failed = 0
const check = (ac, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${ac} — ${detail}`); if (!ok) failed++ }
const rows = () => page.locator('[data-testid=point-device-row]')
const labels = () => rows().locator('[data-testid=row-label]').allTextContents()
const point = () => new globalThis.URL(page.url()).searchParams.get('point')
const settle = () => page.waitForTimeout(1500)

try {
  await page.goto(`${URL}/login`)
  await page.locator('input[type=email]').fill(EMAIL)
  await page.locator('input[type=password]').fill(PASSWORD)
  await page.locator('button[type=submit]').click()
  await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 15000 })

  // AC-1/AC-2: the point's devices, each with a credential state per protocol
  await page.goto(`${URL}/admin/devices?point=${POINT}`)
  await rows().first().waitFor({ timeout: 15000 }).catch(() => {})
  const before = await labels()
  check('AC-1', before.length > 0, `point ${POINT} lists ${before.length} devices: ${before.join(', ')}`)
  const badges = await rows().first().locator('[data-testid^=cred-]').count()
  check('AC-2', badges > 0, `first row shows ${badges} credential badge(s)`)
  await page.screenshot({ path: `${SHOTS}/devices-point.png` })

  // AC-3: reload and leave-and-Back keep the point
  await page.reload(); await rows().first().waitFor({ timeout: 15000 }).catch(() => {})
  const afterReload = before.length > 0 && point() === POINT && (await labels()).length === before.length
  await page.evaluate(() => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router.push('/admin/credentials'))
  await settle()
  await page.goBack(); await settle()
  check('AC-3', afterReload && point() === POINT && (await labels()).length === before.length, `after reload and Back: ?point=${point()}`)

  // AC-4: add a device without choosing the point again
  await page.locator('[data-action=add-device]').click()
  const form = page.locator('[data-testid=add-form]')
  await form.getByLabel('Device type').click()
  await page.getByRole('option').first().click()
  await form.getByLabel('Label').fill('Drive check')
  await form.getByLabel('Host / IP').fill('10.255.0.99')
  await form.getByText('SSH — terminal').click()
  await form.getByRole('button', { name: 'Create device' }).click()
  await settle()
  check('AC-4', (await labels()).includes('Drive check'), 'new device shows up in the point list')

  // AC-5: edit and delete from the form refresh the list
  await rows().filter({ hasText: 'Drive check' }).first().click(); await settle()
  await page.locator('[data-testid=edit-form]').getByLabel('Label').fill('Drive check 2')
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await settle()
  const renamed = (await labels()).includes('Drive check 2')
  await page.getByRole('button', { name: 'Delete' }).first().click()
  await page.locator('[data-testid=edit-form]').getByRole('button', { name: 'Delete' }).last().click(); await settle()
  check('AC-5', renamed && !(await labels()).some(l => l.startsWith('Drive check')), `renamed in list: ${renamed}; gone after delete`)

  // AC-6: search finds a device on another point and moves the page to it
  await page.getByText('Label or point number…').click()
  await page.keyboard.type(OTHER, { delay: 40 }); await settle()
  await page.getByRole('option').first().click(); await settle()
  check('AC-6', point() === OTHER && await page.locator('[data-testid=edit-form]').isVisible(), `?point=${point()} and the form is open`)

  // AC-7: the point card on the board links to its devices (admin)
  await page.goto(URL); await settle()
  const p = page.locator('button', { hasText: `№${POINT}` }).first()
  await p.hover()
  await page.locator('div.group', { has: p }).first().getByTitle('Point health card').click(); await settle()
  const link = page.locator(`a[href="/admin/devices?point=${POINT}"]`)
  check('AC-7', await link.count() > 0, 'admin sees the "devices of this point" link in the card')
  await page.screenshot({ path: `${SHOTS}/devices-card-link.png` })
}
catch (e) {
  console.log('ERROR:', e.message.split('\n').slice(0, 3).join(' | ')); failed++
  await page.screenshot({ path: `${SHOTS}/devices-error.png` }).catch(() => {})
}
await browser.close()
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
