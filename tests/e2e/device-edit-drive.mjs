// E2E live drive for device edit (verified by observation: the rendered edit form).
// Not @playwright/test — a plain runnable script (roadmap phase 3 moves it to a runner).
// Needs: `pnpm dev` up (http://localhost:3000) + seeded DB (dev@ = admin).
// Run: node tests/e2e/device-edit-drive.mjs [screenshotPath]
import { chromium } from 'playwright'

const URL = 'http://localhost:3000'
const SHOT = process.argv[2] || '/tmp/device-edit.png'
const browser = await chromium.launch()
const context = await browser.newContext()
await context.addCookies([{ name: 'i18n_locale', value: 'uk', url: URL }]) // force uk (browser defaults to en)
const page = await context.newPage()
const log = (k, v) => console.log(`${k}: ${JSON.stringify(v)}`)
page.on('pageerror', e => console.log('PAGEERROR:', e.message))
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 200)) })

try {
  // --- login ---
  await page.goto(`${URL}/login`)
  await page.locator('input[type=email], input').first().fill('dev@smartanykey.local')
  await page.locator('input[type=password]').fill('devpassword123')
  await page.getByRole('button', { name: /увійти|sign|login/i }).first().click()
  await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 15000 })

  // --- devices page + server search (real keyboard in the Reka combobox) ---
  await page.goto(`${URL}/admin/devices`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)
  log('devices url', page.url())
  log('heading', (await page.locator('h1, h2').first().textContent().catch(() => '')) || '')
  const searchTrigger = page.getByText(/Лейбл або номер точки/).first()
  await searchTrigger.waitFor({ timeout: 10000 })
  await searchTrigger.click()
  await page.keyboard.type('dev', { delay: 40 })
  await page.waitForTimeout(1200)
  let opts = page.getByRole('option')
  let count = await opts.count()
  if (!count) { // fallback: search by point number
    await page.keyboard.type('1', { delay: 40 })
    await page.waitForTimeout(1200)
    opts = page.getByRole('option'); count = await opts.count()
  }
  log('search options', count)
  await opts.first().click()
  await page.waitForTimeout(1200)

  // --- edit form checks (UI) ---
  const typeSelect = page.getByLabel('Тип девайса')
  const typeVisible = await typeSelect.isVisible().catch(() => false)
  const typeValue = typeVisible ? (await typeSelect.textContent())?.trim() : null

  const credBadges = await page.locator('span').filter({ hasText: /кред:|нема креда/ }).allInnerTexts()
  const dupVisible = await page.getByRole('button', { name: /Дублювати/ }).isVisible().catch(() => false)
  const delBtn = page.getByRole('button', { name: /^Видалити$/ })
  const delVisible = await delBtn.first().isVisible().catch(() => false)

  // duplicate → add form prefilled (checked first, before the delete state)
  let dupPrefilled = false
  let dupCreateBtn = false
  if (dupVisible) {
    await page.getByRole('button', { name: /Дублювати/ }).click()
    await page.waitForTimeout(800)
    dupCreateBtn = await page.getByRole('button', { name: /Створити девайс/ }).isVisible().catch(() => false)
    const labelInputs = await page.locator('input').evaluateAll(els => els.map(e => e.value).filter(v => /\(копія\)/.test(v)))
    dupPrefilled = labelInputs.length > 0
  }

  // delete → confirm (NOT confirmed — only checking that it appears)
  let confirmShown = false
  if (delVisible) {
    await delBtn.first().click()
    confirmShown = await page.getByText('Видалити цей девайс?').isVisible().catch(() => false)
    await page.getByRole('button', { name: /Скасувати/ }).click().catch(() => {})
  }

  log('AC-2 type dropdown visible', typeVisible)
  log('AC-2 type value', typeValue)
  log('AC-5 cred badges', credBadges)
  log('AC-4 delete button', delVisible)
  log('AC-4 confirm shown', confirmShown)
  log('AC-7 duplicate visible', dupVisible)
  log('AC-7 duplicate add-form open (create button)', dupCreateBtn)
  log('AC-7 duplicate prefilled label (copy suffix)', dupPrefilled)

  await page.screenshot({ path: SHOT, fullPage: true })
  log('screenshot', SHOT)
} catch (e) {
  log('ERR', e.message)
  await page.screenshot({ path: SHOT, fullPage: true }).catch(() => {})
} finally {
  await browser.close()
}
