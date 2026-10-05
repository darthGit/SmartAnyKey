// RED. Contact value normalisation and matching
// are pure functions the PBX webhook will later reuse unchanged.
// server/services/point-contacts.ts does not exist yet → the suite fails.
//
// No domain defaults: the length of a number's "national part" is NOT baked into code. Without
// PHONE_MATCH_TAIL the match is exact only; the tail is a parameter that comes from env.
import { describe, expect, it } from 'vitest'
import { contactCreateSchema, matchesValue, normalizeValue } from '../../server/services/point-contacts'

describe('normalizeValue (mirrors SQL value_norm)', () => {
  it('phone_strips_every_non_digit', () => {
    expect(normalizeValue('phone', '+380 67 123-45-67')).toBe('380671234567')
    expect(normalizeValue('phone', '(067) 123-45-67')).toBe('0671234567')
    expect(normalizeValue('phone', '0671234567')).toBe('0671234567')
  })

  it('non_phone_lowercases_and_trims: email does not take the digit branch', () => {
    expect(normalizeValue('email', '  Ivan@Example.UA  ')).toBe('ivan@example.ua')
    // A kind outside phone/email is not the digit branch either (kind is free-form, no domain defaults).
    expect(normalizeValue('telegram', '  @Ivan  ')).toBe('@ivan')
  })
})

describe('matchesValue (AC-9)', () => {
  it('matches_exact_without_tail_env: without PHONE_MATCH_TAIL — exact equality only', () => {
    expect(matchesValue('380671234567', '380671234567', 'phone', undefined)).toBe(true)
    // 380671234567 does NOT end with 0671234567 (leading trunk zero) —
    // which is why a plain suffix match will not do and an explicit tail is needed.
    expect(matchesValue('380671234567', '0671234567', 'phone', undefined)).toBe(false)
  })

  it('matches_by_tail_when_configured: tail 9 unifies the national and international form', () => {
    // last 9 of both = 671234567
    expect(matchesValue('380671234567', '0671234567', 'phone', 9)).toBe(true)
    expect(matchesValue('0671234567', '380671234567', 'phone', 9)).toBe(true)
  })

  it('tail_does_not_create_false_positives: different numbers are not unified', () => {
    expect(matchesValue('380671234567', '380991112233', 'phone', 9)).toBe(false)
  })

  it('tail_applies_only_to_phone: email is compared in full even with a tail', () => {
    expect(matchesValue('ivan@example.ua', 'ivan@example.ua', 'email', 9)).toBe(true)
    expect(matchesValue('ivan@example.ua', 'stepan@example.ua', 'email', 9)).toBe(false)
  })

  it('short_values_not_tail_matched: shorter than the tail — exact match only', () => {
    expect(matchesValue('12345', '99912345', 'phone', 9)).toBe(false)
  })
})

describe('contactCreateSchema (AC-6/AC-10)', () => {
  it('accepts_any_kind: the list of kinds is customer data, not an enum in code', () => {
    expect(() => contactCreateSchema.parse({ kind: 'phone', value: '+380671234567' })).not.toThrow()
    expect(() => contactCreateSchema.parse({ kind: 'email', value: 'ivan@example.ua' })).not.toThrow()
    expect(() => contactCreateSchema.parse({ kind: 'telegram', value: '@ivan' })).not.toThrow()
  })

  it('label_is_optional', () => {
    expect(() => contactCreateSchema.parse({ kind: 'phone', value: '+380671234567', label: 'директор' })).not.toThrow()
    expect(() => contactCreateSchema.parse({ kind: 'phone', value: '+380671234567' })).not.toThrow()
  })

  it('rejects_empty_kind_or_value', () => {
    expect(() => contactCreateSchema.parse({ kind: '', value: '+380671234567' })).toThrow()
    expect(() => contactCreateSchema.parse({ kind: 'phone', value: '' })).toThrow()
    expect(() => contactCreateSchema.parse({ value: '+380671234567' })).toThrow()
  })

  it('rejects_oversized_value: the limit mirrors the DB CHECK (200)', () => {
    expect(() => contactCreateSchema.parse({ kind: 'email', value: `${'x'.repeat(200)}` })).not.toThrow()
    expect(() => contactCreateSchema.parse({ kind: 'email', value: `${'x'.repeat(201)}` })).toThrow()
  })
})
