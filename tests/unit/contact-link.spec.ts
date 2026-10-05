// RED. The decision "which link scheme for which contact kind" is a pure function
// (same pattern as app/utils/device-icon.ts::resolveDeviceIcon): code knows the
// render schemes, while the list of kinds is client data (no domain defaults), so
// an unknown kind does not break but renders as text.
// app/utils/contact-link.ts does not exist yet → the suite fails.
import { describe, expect, it } from 'vitest'
import { contactHref, sortContacts } from '../../app/utils/contact-link'

describe('contactHref (AC-6)', () => {
  it('phone_becomes_tel', () => {
    expect(contactHref('phone', '+380 67 123-45-67')).toBe('tel:+380671234567')
  })

  it('email_becomes_mailto', () => {
    expect(contactHref('email', 'ivan@example.ua')).toBe('mailto:ivan@example.ua')
  })

  it('unknown_kind_is_plain_text: no scheme → no link, no crash', () => {
    // A client may add telegram/viber/radio without a migration — code does not
    // know them in advance and must not.
    expect(contactHref('telegram', '@ivan')).toBeNull()
    expect(contactHref('рація', 'канал 3')).toBeNull()
  })

  it('phone_href_strips_formatting_but_keeps_plus', () => {
    // tel: must be dialable — spaces/parens/hyphens removed, '+' kept.
    expect(contactHref('phone', '(067) 123 45 67')).toBe('tel:0671234567')
  })

  it('empty_value_has_no_href', () => {
    expect(contactHref('phone', '')).toBeNull()
    expect(contactHref('email', '   ')).toBeNull()
  })
})

describe('sortContacts (the list must not "scatter")', () => {
  // Repro from the live screen 2026-08-12: imported contacts arrive with sort=0
  // and interleave with seeded ones by id → PHONE/EMAIL/PHONE/PHONE/EMAIL/TELEGRAM.
  const raw = [
    { kind: 'phone', value: '+380 50 111-22-33', sort: 0 },
    { kind: 'email', value: 'new@example.ua', sort: 0 },
    { kind: 'phone', value: '+380 67 123-45-67', sort: 0 },
    { kind: 'phone', value: '032 245 10 10', sort: 1 },
    { kind: 'email', value: 'shevchenka5@example.ua', sort: 2 },
    { kind: 'telegram', value: '@shevchenka5', sort: 3 },
  ]

  it('groups_by_kind_phones_first_then_email_then_rest', () => {
    expect(sortContacts(raw).map(c => c.kind)).toEqual([
      'phone', 'phone', 'phone', 'email', 'email', 'telegram',
    ])
  })

  it('within_kind_sort_then_value', () => {
    const phones = sortContacts(raw).filter(c => c.kind === 'phone')
    // sort 0 before sort 1; among the two sort=0 — by value.
    expect(phones.map(c => c.value)).toEqual([
      '+380 50 111-22-33', '+380 67 123-45-67', '032 245 10 10',
    ])
  })

  it('unknown_kinds_go_last_alphabetically', () => {
    const out = sortContacts([
      { kind: 'viber', value: 'v', sort: 0 },
      { kind: 'telegram', value: 't', sort: 0 },
      { kind: 'phone', value: 'p', sort: 0 },
    ])
    expect(out.map(c => c.kind)).toEqual(['phone', 'telegram', 'viber'])
  })

  it('does_not_mutate_input', () => {
    const input = [...raw]
    sortContacts(input)
    expect(input.map(c => c.value)).toEqual(raw.map(c => c.value))
  })
})
