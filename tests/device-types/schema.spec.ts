// RED (default_action is validated at the boundary). The zod schema lives in the
// service (importable, no Nitro globals). Written before the module existed → failed.
import { describe, expect, it } from 'vitest'
import { createSchema, patchSchema, typeActions } from '../../server/services/device-types'

const valid = { slug: 'pos', name: 'POS', icon: 'i-lucide-monitor', color: '#f0f', default_action: 'vnc' }

describe('createSchema (AC-4)', () => {
  it('accepts a valid default_action', () => {
    expect(() => createSchema.parse(valid)).not.toThrow()
  })
  it('rejects default_action outside {vnc,rdp,ssh,web}', () => {
    expect(() => createSchema.parse({ ...valid, default_action: 'telnet' })).toThrow()
  })
  it('rejects an empty slug', () => {
    expect(() => createSchema.parse({ ...valid, slug: '' })).toThrow()
  })
})

// Protocols on the type: a type lists several actions; new devices get all of them.
describe('type actions', () => {
  it('accepts several protocols that include default_action (AC-1)', () => {
    expect(createSchema.parse({ ...valid, actions: ['vnc', 'ssh'] }).actions).toEqual(['vnc', 'ssh'])
  })
  it('rejects a set without default_action, and an unknown protocol (AC-1)', () => {
    expect(() => createSchema.parse({ ...valid, actions: ['ssh'] })).toThrow()
    expect(() => createSchema.parse({ ...valid, actions: ['vnc', 'telnet'] })).toThrow()
    expect(() => patchSchema.parse({ default_action: 'rdp', actions: ['vnc'] })).toThrow()
  })
  it('effective set: the type\'s actions, or [default_action] when empty — old types and seeds (AC-7)', () => {
    expect(typeActions({ default_action: 'vnc', actions: ['vnc', 'ssh'] })).toEqual(['vnc', 'ssh'])
    expect(typeActions({ default_action: 'rdp', actions: [] })).toEqual(['rdp'])
    expect(typeActions({ default_action: 'rdp', actions: null })).toEqual(['rdp'])
  })
})
