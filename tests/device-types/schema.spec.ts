// RED (default_action is validated at the boundary). The zod schema lives in the
// service (importable, no Nitro globals). Written before the module existed → failed.
import { describe, expect, it } from 'vitest'
import { createSchema } from '../../server/services/device-types'

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
