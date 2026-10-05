// RED: structural completeness of moving the admin pages onto <AdminPage>.
// Reads SFC files and locales from disk — a "no page forgotten" gate for the 9-file
// sweep. Does not render — checks the source.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const adminDir = resolve(here, '../../app/pages/admin')
const pages = readdirSync(adminDir).filter(f => f.endsWith('.vue'))
const src = (f: string) => readFileSync(resolve(adminDir, f), 'utf8')
const componentSrc = () => readFileSync(resolve(here, '../../app/components/AdminPage.vue'), 'utf8')
const locale = (l: string) => JSON.parse(readFileSync(resolve(here, `../../i18n/locales/${l}.json`), 'utf8'))

describe('admin header/container unification', () => {
  it('every_admin_page_uses_AdminPage (AC-1)', () => {
    expect(pages.length).toBeGreaterThanOrEqual(9)
    const missing = pages.filter(f => !/\bAdminPage\b/.test(src(f)))
    expect(missing, `pages not on AdminPage: ${missing.join(', ')}`).toEqual([])
  })

  it('no_admin_page_hardcodes_container_width (AC-2)', () => {
    // The root container = `mx-auto`+`max-w-*` together (either class order)
    // belongs to AdminPage; pages do not hold it. An incidental `max-w-*` on a
    // modal/element (without `mx-auto`) is legitimate, not caught.
    const rootContainer = /mx-auto\s+max-w-\S+|max-w-\S+\s+mx-auto/
    const offenders = pages.filter(f => rootContainer.test(src(f)))
    expect(offenders, `pages hardcoding root container: ${offenders.join(', ')}`).toEqual([])
    expect(componentSrc()).toMatch(/max-w-3xl/)
  })

  it('no_admin_page_hardcodes_back_button (AC-4)', () => {
    const offenders = pages.filter(f => /i-lucide-arrow-left/.test(src(f)))
    expect(offenders, `pages with bespoke back button: ${offenders.join(', ')}`).toEqual([])
    const c = componentSrc()
    expect(c).toMatch(/i-lucide-arrow-left/)
    expect(c).toMatch(/admin\.back/)
  })

  it('admin_back_key_parity_en_uk (AC-3)', () => {
    expect(locale('en').admin?.back, 'en admin.back').toBeTruthy()
    expect(locale('uk').admin?.back, 'uk admin.back').toBeTruthy()
  })
})
