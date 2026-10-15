// README media: records the GIF scenes and the screenshots on a running in-compose
// stack seeded with `pnpm seed:showcase` (fictional branch network). One run per locale:
//
//   SHOWCASE_EMAIL=… SHOWCASE_PASSWORD=… node tests/e2e/showcase-drive.mjs <url> <outDir> <en|uk>
//
// Shoot on a database holding the showcase seed only — dev rows (point 9999, dev
// credential sets) end up in the frames otherwise. Recipe: docs/development.md.
// Writes <outDir>/<scene>.webm (hero, tiling, discovery) and <name>-{dark,light}.png;
// scripts/showcase-media.sh turns the videos into GIFs. Button texts come from the
// locale files, so the same scenes run in both languages.
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { psql } from '../../scripts/lib/pg.mjs'

const [URL = 'http://localhost:3000', DIR = '.', LOCALE = 'en'] = process.argv.slice(2)
const L = JSON.parse(readFileSync(`i18n/locales/${LOCALE}.json`, 'utf8'))
const t = key => key.split('.').reduce((o, k) => o[k], L)
const VIDEO = { width: 1280, height: 760 }
const SHOT = { width: 1440, height: 900 }

// Headless Chromium draws no pointer; a dot that follows the mouse makes the GIFs readable.
// The magenta square marks frames the GIF drops (showcase-gif.mjs finds it by colour):
// shown from the first paint until the scene starts, and around any wait (a scan).
const CURSOR = () => {
  addEventListener('DOMContentLoaded', () => {
    const m = document.createElement('div')
    m.id = 'cut-mark'
    m.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:12px;height:12px;background:#ff00ff'
    document.body.append(m)
    const d = document.createElement('div')
    d.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(255,255,255,.85);box-shadow:0 0 0 2px rgba(0,0,0,.6);transition:transform .12s;left:-50px;top:-50px'
    document.body.append(d)
    addEventListener('mousemove', e => { d.style.left = `${e.clientX}px`; d.style.top = `${e.clientY}px` }, true)
    addEventListener('mousedown', () => { d.style.transform = 'scale(.7)' }, true)
    addEventListener('mouseup', () => { d.style.transform = '' }, true)
  })
}

const browser = await chromium.launch()

async function login() {
  const ctx = await browser.newContext({ viewport: SHOT })
  await ctx.addCookies([{ name: 'i18n_locale', value: LOCALE, url: URL }])
  const page = await ctx.newPage()
  await page.goto(`${URL}/login`)
  await page.locator('input[type=email]').fill(process.env.SHOWCASE_EMAIL ?? 'dev@smartanykey.local')
  await page.locator('input[type=password]').fill(process.env.SHOWCASE_PASSWORD ?? 'devpassword123')
  await page.locator('button[type=submit]').click()
  await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 15000 })
  const state = await ctx.storageState()
  await ctx.close()
  return state
}
const storageState = await login()

const ONLY = process.env.SCENES?.split(',')
async function scene(name, { video = false, theme = 'dark', viewport = video ? VIDEO : SHOT } = {}, fn) {
  if (ONLY && !ONLY.includes(name))
    return
  const ctx = await browser.newContext({
    viewport, storageState,
    ...(video ? { recordVideo: { dir: `${DIR}/.video`, size: viewport } } : {}),
  })
  await ctx.addInitScript((m) => { localStorage.setItem('nuxt-color-mode', m) }, theme)
  if (video)
    await ctx.addInitScript(CURSOR)
  const page = await ctx.newPage()
  const mark = on => page.evaluate((v) => { const m = document.getElementById('cut-mark'); if (m) m.style.display = v ? '' : 'none' }, on)
  const cut = { from: () => mark(true), to: () => mark(false) }
  try {
    await page.goto(URL)
    await page.waitForLoadState('networkidle')
    if (video)
      await cut.to()
    await fn(page, cut)
    console.log(`ok   ${name}`)
  }
  catch (e) { console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`) }
  await ctx.close()
  if (video) {
    await page.video().saveAs(`${DIR}/${name}.webm`)
  }
}

// Move the visible cursor to an element, then click it — the GIF shows where the click lands.
async function glide(page, loc, opts = {}) {
  await loc.scrollIntoViewIfNeeded()
  const b = await loc.boundingBox()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 })
  await page.waitForTimeout(150)
  if (opts.button === 'right' || !opts.hover)
    await loc.click({ button: opts.button ?? 'left' })
}
const point = (page, n) => page.locator('button', { hasText: `№${n}` }).first()
const row = (page, n) => page.locator('div.group', { has: point(page, n) }).first()
// The title is `<type> — <label>`, plus a hostname line once a scan has named the device.
const device = (page, label) => page.getByTitle(new RegExp(`— ${label}(\\n|$)`)).first()

// Branch 142 back to its seeded inventory, so the scan shows the same diff every run.
// It talks to the LOCAL database (scripts/lib/pg.mjs), so only when shooting a local stack.
function resetBranch142() {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(URL))
    return
  psql(['-c', `
    delete from public.devices d using public.points p
      where d.point_id = p.id and p.number = 142
        and d.label not in ('Router', 'Front desk', 'Back office', 'Old printer');
    update public.devices d set hostname = null, hostname_source = null, hostname_at = null
      from public.points p where d.point_id = p.id and p.number = 142;
    delete from public.discovered_hosts h using public.points p where h.point_id = p.id and p.number = 142;`])
}

try {
  await scene('hero', { video: true }, async (page) => {
    await page.waitForTimeout(800)
    const search = page.locator('input').first()
    await glide(page, search)
    await search.pressSequentially('+1 555 0142', { delay: 90 })
    // A single search hit opens itself — the technician goes straight to the device.
    await page.waitForTimeout(1200)
    await glide(page, device(page, 'Router'))
    await page.waitForTimeout(2500)
    // Focus stays on the chip (a link) — Enter there would open a second session.
    await glide(page, page.locator('.xterm').first())
    await page.keyboard.type('ip route', { delay: 70 })
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1500)
    await glide(page, device(page, 'Front desk'))
    await page.waitForTimeout(5000)
  })

  await scene('tiling', { video: true }, async (page) => {
    await glide(page, point(page, 142))
    await glide(page, device(page, 'Router'))
    await page.waitForTimeout(1500)
    await glide(page, device(page, 'Front desk'))
    await page.waitForTimeout(3000)
    await glide(page, device(page, 'Back office'))
    await page.waitForTimeout(5000)
    // Dock the RDP pane under the terminal: drag its header onto the terminal's bottom zone.
    const headers = page.locator('[draggable="true"]')
    const rdp = headers.nth(2)
    const term = page.locator('.xterm').first()
    const tb = await term.boundingBox()
    const rb = await rdp.boundingBox()
    await page.mouse.move(rb.x + 60, rb.y + rb.height / 2, { steps: 15 })
    await rdp.dragTo(term, { targetPosition: { x: tb.width / 2, y: tb.height - 20 }, steps: 25 })
    await page.waitForTimeout(3000)
    const term2 = page.locator('.xterm').first()
    await glide(page, term2)
    await page.keyboard.type('uptime', { delay: 70 })
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2500)
  })

  resetBranch142()
  await scene('discovery', { video: true }, async (page, cut) => {
    await glide(page, point(page, 142), { hover: true })
    await glide(page, row(page, 142).getByTitle(t('discovery.discover')))
    // Opening the drawer starts the scan itself; keep its first seconds, drop the wait.
    await page.waitForTimeout(2500)
    await cut.from()
    await page.getByRole('button', { name: new RegExp(t('discovery.addAll').split('(')[0].trim()) }).waitFor({ timeout: 90000 })
    await cut.to()
    await page.waitForTimeout(2500)
    await glide(page, page.getByRole('button', { name: new RegExp(t('discovery.addAll').split('(')[0].trim()) }))
    await page.waitForTimeout(2500)
    await glide(page, page.getByRole('button', { name: t('discovery.close') }).last())
    await page.waitForTimeout(800)
    await glide(page, point(page, 142))
    await page.waitForTimeout(2000)
  })

  resetBranch142()
  for (const theme of ['dark', 'light']) {
    await scene(`board-${theme}`, { theme }, async (page) => {
      for (const n of [117, 142, 188])
        await point(page, n).click()
      await row(page, 142).hover()
      await row(page, 142).getByTitle(t('board.health.open')).click()
      await page.waitForTimeout(4000)
      await page.screenshot({ path: `${DIR}/board-${theme}.png` })
    })
    await scene(`credentials-${theme}`, { theme }, async (page) => {
      await page.goto(`${URL}/admin/credentials`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1000)
      await page.screenshot({ path: `${DIR}/credentials-${theme}.png` })
    })
    await scene(`tasks-${theme}`, { theme }, async (page) => {
      await page.goto(`${URL}/admin/tasks`)
      await page.waitForLoadState('networkidle')
      const row = page.locator('[data-testid="task-row"]', { hasText: 'Nightly router config backup' })
      await row.locator('[data-action="task-run"]').click()
      await page.waitForTimeout(7000)
      await page.screenshot({ path: `${DIR}/tasks-${theme}.png` })
    })
    await scene(`files-${theme}`, { theme }, async (page) => {
      await point(page, 142).click()
      await device(page, 'Router').click({ button: 'right' })
      await page.getByRole('button', { name: t('sftp.menuOpen') }).click()
      await page.waitForTimeout(4000)
      await page.screenshot({ path: `${DIR}/files-${theme}.png` })
    })
  }
}
finally {
  await browser.close()
}
