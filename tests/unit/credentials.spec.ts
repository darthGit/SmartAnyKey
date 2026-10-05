// Unit tests for credential resolution.
// pickCredentialSet is a pure function: the first non-null in the order
// device → type → point → global (ADR-009).
import { describe, expect, it } from 'vitest'
import { pickCredentialSet } from '../../server/services/credentials'

const dev = { id: 'dev' }
const type = { id: 'type' }
const point = { id: 'point' }
const global = { id: 'global' }

describe('pickCredentialSet (AC-3/4/5)', () => {
  it('AC-3: the device set beats all', () => {
    expect(pickCredentialSet({ device: dev, type, point, global })).toBe(dev)
  })

  it('AC-4: no device → type', () => {
    expect(pickCredentialSet({ device: null, type, point, global })).toBe(type)
  })

  it('AC-4: no device or type → point', () => {
    expect(pickCredentialSet({ device: null, type: null, point, global })).toBe(point)
  })

  it('AC-4: only global left → global', () => {
    expect(pickCredentialSet({ device: null, type: null, point: null, global })).toBe(global)
  })

  it('AC-5: no set at all → null', () => {
    expect(pickCredentialSet({ device: null, type: null, point: null, global: null })).toBeNull()
  })
})
