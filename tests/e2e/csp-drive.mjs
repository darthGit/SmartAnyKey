// Live drive: walk every screen of the running app and collect CSP violations
// (securitypolicyviolation events + console). Needs the dev seed and one task on
// /admin/tasks whose log prints "tick 1".."tick 6". Run: node tests/e2e/csp-drive.mjs <url> <shotDir>
import { chromium } from 'playwright'

const URL = process.argv[2] || 'http://localhost:3000'
const DIR = process.argv[3] || '.'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addCookies([{ name: 'i18n_locale', value: 'uk', url: URL }])
// Violation events are the authoritative channel; console text is the second.
await ctx.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', (e) => {
    console.log(`CSPV ${e.violatedDirective} blocked=${e.blockedURI} src=${e.sourceFile}:${e.lineNumber}`)
  })
})
const page = await ctx.newPage()
const violations = []
let where = 'start'
page.on('console', (m) => {
  const t = m.text()
  if (t.startsWith('CSPV') || /Content Security Policy|Refused to/i.test(t)) violations.push(`[${where}] ${t.slice(0, 300)}`)
  else if (m.type() === 'error') console.log(`console-err [${where}]: ${t.slice(0, 160)}`)
})
page.on('pageerror', e => console.log(`PAGEERROR [${where}]: ${e.message.slice(0, 160)}`))
const shot = async name => page.screenshot({ path: `${DIR}/${name}.png` })
const step = async (name, fn) => {
  where = name
  try { await fn(); console.log(`ok   ${name}`) }
  catch (e) { console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`) }
  await shot(name)
}

try {
  await step('login', async () => {
    await page.goto(`${URL}/login`)
    const theme = await page.evaluate(() => ({ cls: document.documentElement.className, cm: !!window.__NUXT_COLOR_MODE__, cfg: !!window.__NUXT__?.config?.public?.supabase?.url }))
    console.log('inline scripts ran:', JSON.stringify(theme))
    await page.locator('input[type=email]').fill('dev@smartanykey.local')
    await page.locator('input[type=password]').fill('devpassword123')
    await page.getByRole('button', { name: /увійти/i }).first().click()
    await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 15000 })
  })

  await step('board', async () => {
    await page.waitForLoadState('networkidle')
    await page.getByText('9999').first().click()
    await page.getByTitle(/VNC dev/).first().waitFor({ timeout: 10000 })
  })

  const open = async (title, action) => {
    await page.getByTitle(title).first().click({ button: 'right' })
    await page.locator(`[data-action="${action}"]`).click()
  }
  await step('vnc', async () => {
    await open(/VNC dev/, 'vnc')
    await page.waitForTimeout(8000)
  })
  await step('rdp', async () => {
    await open(/RDP dev/, 'rdp')
    await page.waitForTimeout(10000)
  })
  await step('ssh', async () => {
    await open(/Testbox SSH/, 'ssh')
    await page.waitForTimeout(5000)
    const xterm = await page.locator('.xterm-rows').last().innerText().catch(() => '')
    console.log('ssh tail:', JSON.stringify(xterm.trim().split('\n').slice(-2)))
  })
  await step('files', async () => {
    await page.getByTitle(/Testbox SSH/).first().click({ button: 'right' })
    await page.getByRole('button', { name: 'Файли' }).click()
    await page.waitForTimeout(4000)
  })
  const canvases = await page.locator('canvas').count()
  console.log('canvases on board:', canvases)

  for (const p of ['points', 'devices', 'credentials', 'users', 'commands', 'device-types', 'discovery-inbox', 'signatures', 'runbooks', 'import', 'onboarding']) {
    await step(`admin-${p}`, async () => {
      await page.goto(`${URL}/admin/${p}`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(800)
    })
  }

  await step('admin-tasks', async () => {
    await page.goto(`${URL}/admin/tasks`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1500)
  })
  await step('task-live-log-mid', async () => {
    await page.getByRole('button', { name: 'Запустити зараз' }).first().click()
    await page.getByText('tick 2').first().waitFor({ timeout: 20000 })
  })
  await step('task-live-log-end', async () => {
    await page.getByText('tick 6').first().waitFor({ timeout: 20000 })
  })
}
finally {
  console.log(`\nCSP violations: ${violations.length}`)
  for (const v of violations) console.log('  ' + v)
  await browser.close()
}
