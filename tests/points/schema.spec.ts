// RED. The zod boundary of point CRUD lives
// in the service (importable, no Nitro globals). A bad CIDR must be caught here,
// not fail as a raw PG 22P02.
// server/services/points.ts does not exist yet → the suite fails.
import { describe, expect, it } from 'vitest'
import { NOTE_MAX, createSchema, patchSchema } from '../../server/services/points'

const valid = { number: 147, address: 'вул. Лесі Українки, 3', subnet: '10.0.147.0/24' }

describe('createSchema (AC-3)', () => {
  it('accepts_valid_point: a valid body parses', () => {
    expect(() => createSchema.parse(valid)).not.toThrow()
  })

  it('number_must_be_positive_int: 0, negative and fractional are rejected', () => {
    expect(() => createSchema.parse({ ...valid, number: 0 })).toThrow()
    expect(() => createSchema.parse({ ...valid, number: -1 })).toThrow()
    expect(() => createSchema.parse({ ...valid, number: 1.5 })).toThrow()
  })

  it('cidr_rejects_octet_over_255: 10.0.515.0/24 is not a valid CIDR', () => {
    // Octet ∈ 0-255 (numeric examples are verified, not fabricated).
    expect(() => createSchema.parse({ ...valid, subnet: '10.0.515.0/24' })).toThrow()
  })

  it('cidr_rejects_bad_prefix_and_shape', () => {
    expect(() => createSchema.parse({ ...valid, subnet: '10.0.147.0/33' })).toThrow()
    expect(() => createSchema.parse({ ...valid, subnet: '10.0.147.0' })).toThrow() // no prefix
    expect(() => createSchema.parse({ ...valid, subnet: 'not-a-cidr' })).toThrow()
  })

  it('cidr_accepts_edge_prefixes: /0 and /32 are valid', () => {
    expect(() => createSchema.parse({ ...valid, subnet: '0.0.0.0/0' })).not.toThrow()
    expect(() => createSchema.parse({ ...valid, subnet: '10.0.147.5/32' })).not.toThrow()
  })

  it('requires_address_and_subnet: empty/missing are rejected', () => {
    expect(() => createSchema.parse({ ...valid, address: '' })).toThrow()
    expect(() => createSchema.parse({ number: 147, subnet: '10.0.147.0/24' })).toThrow()
    expect(() => createSchema.parse({ number: 147, address: 'x' })).toThrow()
  })
})

describe('patchSchema (AC-2)', () => {
  it('accepts_single_field: partial patch does not require the other fields', () => {
    expect(() => patchSchema.parse({ address: 'нова адреса' })).not.toThrow()
    expect(() => patchSchema.parse({ number: 148 })).not.toThrow()
    expect(() => patchSchema.parse({ scan_cadence_minutes: null })).not.toThrow()
  })

  it('validates_same_rules_as_create: a bad CIDR in patch is rejected too', () => {
    expect(() => patchSchema.parse({ subnet: '10.0.515.0/24' })).toThrow()
  })

  it('note_respects_NOTE_MAX: limit shared with services/notes (one duplicate removed)', () => {
    expect(NOTE_MAX).toBe(2000)
    expect(() => patchSchema.parse({ note: 'x'.repeat(NOTE_MAX) })).not.toThrow()
    expect(() => patchSchema.parse({ note: 'x'.repeat(NOTE_MAX + 1) })).toThrow()
  })

  it('cadence_must_be_positive_or_null: 0 is not a schedule but an error', () => {
    expect(() => patchSchema.parse({ scan_cadence_minutes: 0 })).toThrow()
    expect(() => patchSchema.parse({ scan_cadence_minutes: 60 })).not.toThrow()
  })
})
