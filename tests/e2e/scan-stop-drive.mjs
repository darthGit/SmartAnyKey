// Live drive for one scan per point and Stop, seen by two admins at once: both open the
// discovery drawer of the same point (the second one joins the scan of the first), one
// presses Stop, both drawers must show "stopped" and offer Scan again.
// Not @playwright/test — a plain runnable script, like device-edit-drive.mjs.
// Needs: `pnpm dev` (http://localhost:3000), an admin login, a point whose subnet scans for
// a while (an unreachable one is fine).
// Run: node tests/e2e/scan-stop-drive.mjs <pointNumber> [shotDir]
// Env: DRIVE_EMAIL / DRIVE_PASSWORD (default: the dev seed admin).
import { chromium } from 'playwright'

const URL = 'http://localhost:3000'
const POINT = process.argv[2]
const SHOTS = process.argv[3] || '/tmp'
const EMAIL = process.env.DRIVE_EMAIL || 'dev@smartanykey.local'
const PASSWORD = process.env.DRIVE_PASSWORD || 'devpassword123'
if (!POINT)
  throw new Error('usage: node tests/e2e/scan-stop-drive.mjs <pointNumber> [shotDir]')

const browser = await chromium.launch()
let failed = 0
const check = (what, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what} — ${detail}`); if (!ok) failed++ }

async function admin(name) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage()
  page.on('pageerror', e => console.log(`${name} PAGEERROR:`, e.message))
  await page.goto(`${URL}/login`)
  await page.locator('input[type=email]').fill(EMAIL)
  await page.locator('input[type=password]').fill(PASSWORD)
  await page.locator('button[type=submit]').click()
  await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 15000 })
  return page
}

async function openDrawer(page) {
  await page.getByRole('searchbox').first().fill(POINT)
  const row = page.getByText(new RegExp(`№\\s?${POINT}\\b`)).first()
  await row.waitFor({ timeout: 15000 })
  await row.hover()
  await page.getByRole('button', { name: /^(Discover|Розвідка)$/ }).first().click()
}

const scanning = page => page.getByText(/Scanning subnet|Сканування підмережі/).first()
const stopped = page => page.getByText(/Scan stopped|Скан зупинено/).first()

try {
  const a = await admin('A')
  const b = await admin('B')
  await openDrawer(a)
  await scanning(a).waitFor({ timeout: 15000 })
  await openDrawer(b)
  await scanning(b).waitFor({ timeout: 15000 })
  check('second admin joins', true, 'both drawers show the scan in progress')

  await a.getByRole('button', { name: /^(Stop|Зупинити)$/ }).click()
  const seenA = await stopped(a).waitFor({ timeout: 10000 }).then(() => true, () => false)
  const seenB = await stopped(b).waitFor({ timeout: 10000 }).then(() => true, () => false)
  await a.screenshot({ path: `${SHOTS}/scan-stopped-a.png` })
  await b.screenshot({ path: `${SHOTS}/scan-stopped-b.png` })
  check('stopper sees stopped', seenA, `screenshot ${SHOTS}/scan-stopped-a.png`)
  check('other admin sees stopped', seenB, `screenshot ${SHOTS}/scan-stopped-b.png`)
  const again = await a.getByRole('button', { name: /^(Scan|Сканувати)$/ }).isEnabled().catch(() => false)
  check('scan can start again', again, 'the Scan button is enabled after the stop')
}
finally {
  await browser.close()
}
process.exit(failed ? 1 : 0)
