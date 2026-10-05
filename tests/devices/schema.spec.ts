// RED (patchSchema validates the protocol set + default_action at the boundary).
// The zod schema lives in the service (importable, no Nitro globals). The module
// server/services/devices.ts does not exist yet → fails.
import { describe, expect, it } from 'vitest'
import { patchSchema } from '../../server/services/devices'

const valid = { actions: ['vnc', 'ssh'], label: 'Каса 9', host: '10.0.1.9', default_action: 'vnc' }

describe('devices patchSchema (AC-4)', () => {
  it('accepts a valid patch', () => {
    expect(() => patchSchema.parse(valid)).not.toThrow()
  })
  it('accepts default_action = null (clear the override)', () => {
    expect(() => patchSchema.parse({ ...valid, default_action: null })).not.toThrow()
  })
  it('accepts a patch without default_action (left untouched)', () => {
    expect(() => patchSchema.parse({ actions: ['vnc'] })).not.toThrow()
  })
  it('rejects empty actions', () => {
    expect(() => patchSchema.parse({ ...valid, actions: [] })).toThrow()
  })
  it('rejects an empty host', () => {
    expect(() => patchSchema.parse({ ...valid, host: '' })).toThrow()
  })
  it('rejects values outside {vnc,rdp,ssh,web}', () => {
    expect(() => patchSchema.parse({ ...valid, actions: ['telnet'] })).toThrow()
  })
  it('rejects a default_action that is not in actions', () => {
    expect(() => patchSchema.parse({ actions: ['vnc'], default_action: 'ssh' })).toThrow()
  })

  // The device type is edited through the same partial patch.
  it('AC-3: accepts a valid type_id (uuid)', () => {
    expect(() => patchSchema.parse({ type_id: '11111111-1111-4111-8111-111111111111' })).not.toThrow()
  })
  it('AC-3: rejects a type_id that is not a uuid', () => {
    expect(() => patchSchema.parse({ type_id: 'not-a-uuid' })).toThrow()
  })
})

// host = a valid IPv4 (octets 0-255) OR a hostname; validated at the boundary.
describe('devices host validation (AC-6)', () => {
  const ok = (host: string) => expect(() => patchSchema.parse({ host })).not.toThrow()
  const bad = (host: string) => expect(() => patchSchema.parse({ host })).toThrow()
  it('accepts a valid IPv4', () => ok('10.0.1.9'))
  it('accepts loopback', () => ok('127.0.0.1'))
  it('accepts a hostname', () => ok('mikrotik-01.local'))
  it('rejects an IP octet > 255', () => bad('10.0.515.103'))
  it('rejects invalid characters', () => bad('bad host!'))
  it('rejects an empty host', () => bad(''))
})
