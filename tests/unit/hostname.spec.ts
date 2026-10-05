// RED. The `label` ↔ `hostname` mismatch marker
// is a pure function in app/utils (PointHealthCard has no mock layer,
// so the decision lives in a utility
// and the rendering is checked with a screenshot).
import { describe, expect, it } from 'vitest'
import { hostnameMismatch } from '../../app/utils/hostname'

describe('hostnameMismatch (AC-5)', () => {
  it('different names → mismatch', () => {
    expect(hostnameMismatch('Каса 3', 'kasa-7')).toBe(true)
  })

  it('no observed name → no marker (empty ≠ mismatch)', () => {
    expect(hostnameMismatch('Каса 3', null)).toBe(false)
    expect(hostnameMismatch('Каса 3', '')).toBe(false)
  })

  it('the same string → no mismatch', () => {
    expect(hostnameMismatch('kasa-7', 'kasa-7')).toBe(false)
  })

  it('a difference only in case or in the trailing DNS dot — not a mismatch', () => {
    expect(hostnameMismatch('DESKTOP-4F8H2K', 'desktop-4f8h2k')).toBe(false)
    expect(hostnameMismatch('kasa-7', 'kasa-7.')).toBe(false)
    expect(hostnameMismatch(' kasa-7 ', 'kasa-7')).toBe(false)
  })
})
