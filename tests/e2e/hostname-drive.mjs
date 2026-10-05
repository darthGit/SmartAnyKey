// Live drive for device hostname (verified by observation on all four changed surfaces).
// Needs: pnpm dev + seed DB (dev@=admin), point 9999 with the cash-desk device (Kasa 1)
// (host 172.17.0.2, hostname 73ac3e1374dc → mismatch with the label).
import { chromium } from 'playwright'

const URL = 'http://localhost:3000'
const OUT = process.argv[2] || '/tmp/hostname'
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await context.addCookies([{ name: 'i18n_locale', value: 'uk', url: URL }])
const page = await context.newPage()
const log = (k, v) => console.log(`${k}: ${JSON.stringify(v)}`)
page.on('pageerror', e => console.log('PAGEERROR:', e.message))
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 160)) })

try {
  await page.goto(`${URL}/login`)
  await page.locator('input[type=email], input').first().fill('dev@smartanykey.local')
  await page.locator('input[type=password]').fill('devpassword123')
  await page.getByRole('button', { name: /увійти|sign|login/i }).first().click()
  await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 15000 })
  await page.waitForTimeout(2500)

  // --- 1. tree: find point 9999, expand ---
  const search = page.getByRole('searchbox').first()
  await search.fill('9999')
  await page.waitForTimeout(1200)
  const pointRow = page.getByRole('button', { name: /9999/ }).first()
  await pointRow.hover()          // a single search result expands by itself; a click would collapse it
  await page.waitForTimeout(600)

  // tree tooltip = title attribute of the device button
  const kasa = page.getByRole('link', { name: /Каса 1/ }).first()
  await kasa.waitFor({ timeout: 8000 })
  log('tree tooltip', await kasa.getAttribute('title'))
  await kasa.hover()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}-tree.png` })

  // --- 2. point card (pane 'card') ---
  // Open the card via the button on the point row (radar/card) — found by title.
  await pointRow.hover()
  await page.getByRole('button', { name: /Карта точки|health/i }).first().click()
  await page.waitForTimeout(3500)
  const hn = page.locator('[data-testid^="hostname-"]').first()
  log('card hostname visible', await hn.count() > 0 ? await hn.textContent() : null)
  log('mismatch marker', await page.locator('[data-testid=hostname-mismatch]').count())
  log('check button', await page.locator('[data-action=hostname-check]').count())
  log('accept button', await page.locator('[data-action=hostname-accept]').count())
  await page.screenshot({ path: `${OUT}-card.png` })

  // --- 3. discover drawer: NSE name chip ---
  await pointRow.hover()
  await page.getByRole('button', { name: /Розвідка/i }).first().click()
  await page.waitForTimeout(15000)   // /24 scan + diff render
  log('nse chip', await page.locator('[data-testid=chip-nse-hostname]').count())
  log('nse chip text', await page.locator('[data-testid=chip-nse-hostname]').first().textContent().catch(() => null))
  await page.screenshot({ path: `${OUT}-discover.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)

  // --- 4. /admin/devices ---
  await page.goto(`${URL}/admin/devices`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)
  const trigger = page.getByText(/Лейбл або номер точки/).first()
  await trigger.click()
  await page.keyboard.type('9999', { delay: 40 })   // search by point number — the Kasa 1 name exists on hundreds of points
  await page.waitForTimeout(2000)
  const opt = page.getByRole('option').filter({ hasText: /Каса 1/ }).first()
  await opt.click()
  await page.waitForTimeout(1500)
  log('admin hostname', await page.locator('[data-testid=admin-hostname]').textContent().catch(() => null))
  log('admin accept btn', await page.locator('[data-action=hostname-accept]').count())
  await page.screenshot({ path: `${OUT}-admin.png`, fullPage: true })
}
finally {
  await browser.close()
}
