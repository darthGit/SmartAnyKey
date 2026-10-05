// RED: client-side board search over the already-loaded board.
// app/utils/fuzzy.ts + app/utils/boardSearch.ts do not exist yet → fails.
// Pure logic, node env. Minimal data — only the fields the search reads.
import { describe, expect, it } from 'vitest'
import { searchBoard } from '../../app/utils/boardSearch'
import { fuzzyScore } from '../../app/utils/fuzzy'

// number — a unique discriminator; address — for fuzzy; note — note search.
const points = [
  { id: 'p1', number: 101, address: 'Shevchenka 5', subnet: '10.0.1.0/24', note: 'Router behind counter' },
  { id: 'p2', number: 202, address: 'Franka 12', subnet: '10.0.2.0/24', note: '' },
  { id: 'p3', number: 303, address: 'Lypynskoho 8', subnet: '198.51.100.0/24', note: '' },
]
const devicesByPoint = new Map<string, { id: string, label: string, host: string }[]>([
  ['p1', [{ id: 'd1', label: 'Каса 1', host: '10.0.1.5' }]],
  ['p3', [{ id: 'd3', label: 'POS self-service', host: '198.51.100.5' }]],
])
const runbooksByPoint = new Map<string, { title: string, body: string }[]>([
  ['p2', [{ title: 'Reboot the router', body: 'Open WebFig then System > Reboot' }]],
])

// Contacts as a search signal.
// value_norm mirrors the SQL column (phone → digits only, other → lower+trim).
const contactsByPoint = new Map<string, { kind: string, value: string, value_norm: string, label: string | null }[]>([
  ['p2', [
    { kind: 'phone', value: '+380 67 123-45-67', value_norm: '380671234567', label: 'директор' },
    { kind: 'email', value: 'Ivan@Example.UA', value_norm: 'ivan@example.ua', label: null },
  ]],
])

const ctx = { points, devicesByPoint, runbooksByPoint, contactsByPoint, phoneMatchTail: 9 }

describe('fuzzyScore', () => {
  it('exact_and_subsequence_score_above_zero', () => {
    expect(fuzzyScore('Shevchenka', 'shevchenka')).toBeGreaterThan(0)
    expect(fuzzyScore('Shevchenka', 'shvchenka')).toBeGreaterThan(0) // a missing letter
  })
  it('no_match_is_zero', () => {
    expect(fuzzyScore('Shevchenka', 'xyzzy')).toBe(0)
  })
})

describe('searchBoard', () => {
  it('single_match_auto_expands', () => { // a unique query → exactly 1 point
    const res = searchBoard('202', ctx)
    expect(res).toHaveLength(1)
    expect(res[0]!.point.id).toBe('p2')
  })

  it('matches_number_address_device_host_ip', () => {
    expect(searchBoard('101', ctx).map(r => r.point.id)).toContain('p1') // number
    expect(searchBoard('franka', ctx).map(r => r.point.id)).toContain('p2') // address
    expect(searchBoard('self-service', ctx).map(r => r.point.id)).toContain('p3') // device label
    const byIp = searchBoard('198.51.100.5', ctx) // device IP/host → its point
    expect(byIp.map(r => r.point.id)).toContain('p3')
    expect(byIp.find(r => r.point.id === 'p3')!.matchReason).toBe('device')
  })

  it('matches_note_and_runbook', () => {
    const byNote = searchBoard('counter', ctx)
    expect(byNote.map(r => r.point.id)).toContain('p1')
    expect(byNote.find(r => r.point.id === 'p1')!.matchReason).toBe('note')
    const byRunbook = searchBoard('webfig', ctx)
    expect(byRunbook.map(r => r.point.id)).toContain('p2')
    expect(byRunbook.find(r => r.point.id === 'p2')!.matchReason).toBe('runbook')
  })

  it('ranks_exact_number_first_and_fuzzy_address', () => {
    // '10' matches no number prefix, but matches the address/host of many;
    // an exact number must come first when it exists.
    const exact = searchBoard('303', ctx)
    expect(exact[0]!.point.id).toBe('p3') // exact number — first
    // a small typo in the address still matches (fuzzy)
    const typo = searchBoard('shevchnka', ctx) // missing 'e'
    expect(typo.map(r => r.point.id)).toContain('p1')
  })

  it('phone_formats_resolve_to_same_point', () => {
    // Three human spellings of one number → the same point. International and
    // national forms meet only via phoneMatchTail (the leading trunk zero is a
    // country convention, not baked into code).
    for (const q of ['+380671234567', '0671234567', '067-123-45-67']) {
      const res = searchBoard(q, ctx)
      expect(res.map(r => r.point.id), q).toContain('p2')
      expect(res.find(r => r.point.id === 'p2')!.matchReason, q).toBe('contact')
    }
  })

  it('matches_contact_email_and_label', () => {
    const byMail = searchBoard('ivan@example', ctx)
    expect(byMail.map(r => r.point.id)).toContain('p2')
    expect(byMail.find(r => r.point.id === 'p2')!.matchReason).toBe('contact')
    const byLabel = searchBoard('директор', ctx)
    expect(byLabel.find(r => r.point.id === 'p2')!.matchReason).toBe('contact')
  })

  it('phone_match_does_not_hijack_point_number', () => { // ranking regression
    // '202' is the exact number of point p2; it must stay reason 'point',
    // not be overridden by the contact tier.
    expect(searchBoard('202', ctx)[0]!.matchReason).toBe('point')
  })

  it('empty_query_returns_all_by_number', () => {
    const res = searchBoard('', ctx)
    expect(res.map(r => r.point.id)).toEqual(['p1', 'p2', 'p3'])
    expect(res.every(r => r.matchReason === 'point')).toBe(true)
  })
})
