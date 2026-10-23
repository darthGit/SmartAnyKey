// Live drive for first-run setup on a FRESH install (no admin yet): create the admin, set up
// the authenticator right there (the default policy covers admins), reach the backup step.
// Not @playwright/test — a plain runnable script. Run against a clean-room install only:
// it creates the first admin, after which /setup is closed for good.
// Run: node tests/e2e/setup-mfa-drive.mjs <baseUrl> <email> <password> [shotDir]
import { chromium } from 'playwright'
import { totp } from '../helpers/totp.mjs'

const [BASE, EMAIL, PASSWORD, SHOTS = '/tmp'] = process.argv.slice(2)
if (!PASSWORD)
  throw new Error('usage: node tests/e2e/setup-mfa-drive.mjs <baseUrl> <email> <password> [shotDir]')

let failed = 0
const check = (what, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what} — ${detail}`); if (!ok) failed++ }
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  page.on('pageerror', e => console.log('PAGEERROR:', e.message))
  await page.goto(`${BASE}/setup`)
  await page.locator('input[autocomplete=username]').fill(EMAIL)
  const pw = page.locator('input[autocomplete=new-password]')
  await pw.nth(0).fill(PASSWORD)
  await pw.nth(1).fill(PASSWORD)
  await page.locator('button[type=submit]').click()
  const mfaStep = await page.getByTestId('setup-mfa').waitFor({ timeout: 20000 }).then(() => true, () => false)
  await page.screenshot({ path: `${SHOTS}/setup-1-mfa-step.png` })
  check('new admin is asked to set up 2FA first', mfaStep, `${SHOTS}/setup-1-mfa-step.png`)

  await page.getByRole('button', { name: /Set up authenticator app|Налаштувати автентифікатор/ }).click()
  const secret = (await page.locator('code').first().textContent()).trim()
  await page.locator('input[autocomplete=one-time-code]').fill(totp(secret))
  await page.getByRole('button', { name: /^(Turn on|Увімкнути)$/ }).click()
  const backupStep = await page.getByTestId('setup-backup').waitFor({ timeout: 20000 }).then(() => true, () => false)
  await page.screenshot({ path: `${SHOTS}/setup-2-backup-step.png` })
  check('after 2FA the backup step loads (server answers the aal2 admin)', backupStep, `${SHOTS}/setup-2-backup-step.png`)
}
finally {
  await browser.close()
}
process.exit(failed ? 1 : 0)
