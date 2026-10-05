// RED: the new layout strings (rail toggle) are localized — keys
// board.railCollapse / board.railExpand in en and uk. Keys missing → fails.
// Locales via fs (_locales) — the i18n vite plugin precompiles the JSON (ADR-006).
import { describe, expect, it } from 'vitest'
import { en, uk } from '../i18n/_locales'

const KEYS = ['railCollapse', 'railExpand']

describe('board layout i18n keys', () => {
  it.each([['en', en], ['uk', uk]] as const)('%s has rail keys', (loc, locale) => {
    expect(locale.board, `${loc}.board`).toBeTypeOf('object')
    for (const k of KEYS)
      expect(locale.board, `${loc}.board.${k}`).toHaveProperty(k)
  })
})

// en↔uk parity is already gated by tests/i18n/locales.spec.ts — here we check
// that the keys exist at all (otherwise parity is green on two equally empty locales).
const POINTS_KEYS = [
  'title', 'search', 'empty', 'number', 'numberHint', 'address', 'subnet',
  'note', 'cadence', 'save', 'saveError', 'numberTaken', 'subnetInvalid',
  'addToggle', 'addSubmit', 'duplicate', 'deletePoint', 'deleteConfirm',
  'deleteBlast', 'deleteError',
]
const CONTACTS_KEYS = [
  'title', 'empty', 'kind', 'value', 'label', 'kindPhone', 'kindEmail',
  'kindOther', 'add', 'save', 'delete', 'deleteConfirm', 'saveError',
  'duplicateValue',
]

describe('points_and_contacts_keys_present (AC-13)', () => {
  it.each([['en', en], ['uk', uk]] as const)('%s has points.* keys', (loc, locale) => {
    expect(locale.points, `${loc}.points`).toBeTypeOf('object')
    for (const k of POINTS_KEYS)
      expect(locale.points, `${loc}.points.${k}`).toHaveProperty(k)
  })

  it.each([['en', en], ['uk', uk]] as const)('%s has contacts.* keys', (loc, locale) => {
    expect(locale.contacts, `${loc}.contacts`).toBeTypeOf('object')
    for (const k of CONTACTS_KEYS)
      expect(locale.contacts, `${loc}.contacts.${k}`).toHaveProperty(k)
  })

  it.each([['en', en], ['uk', uk]] as const)('%s has nav + match-reason keys', (loc, locale) => {
    expect(locale.rbac, `${loc}.rbac.navPoints`).toHaveProperty('navPoints')
    expect(locale.board.match, `${loc}.board.match.contact`).toHaveProperty('contact')
  })
})

// `admin/import.vue` renders field labels as `t(\`import.field.${f}\`)` —
// a missing key shows the raw key on screen, and key parity does not catch it
// (missing in both locales alike). Caught on a live screenshot 2026-08-12
// (`import.field.kind` / `import.field.value` after adding Kind='contacts').
const IMPORT_FIELDS = ['number', 'address', 'subnet', 'host', 'label', 'type', 'point', 'kind', 'value']

describe('import field labels resolve (no raw keys on screen)', () => {
  it.each([['en', en], ['uk', uk]] as const)('%s has import.field.* for every mapped field', (loc, locale) => {
    for (const f of IMPORT_FIELDS)
      expect(locale.import.field, `${loc}.import.field.${f}`).toHaveProperty(f)
  })
})
