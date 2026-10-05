// RED (per-protocol cred status — resolvable cred + level, without decrypt).
// On top of resolveChosenBinding (device→type→point→global). credStatus in
// server/services/credentials.ts does not exist yet → fails.
import { describe, expect, it } from 'vitest'
import { credStatus } from '../../server/services/credentials'

// Mock client: devices → (type_id,point_id); credential_bindings → rows by action.
function mockClient(bindingsByAction: Record<string, { level: string, cred_set_id: string }[]>) {
  return {
    from: (table: string) => {
      if (table === 'devices') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { type_id: 't1', point_id: 'p1' }, error: null }) }) }) }
      }
      // credential_bindings: .select(...).eq('action', action).or(...)
      let action = ''
      return {
        select: () => ({
          eq: (_col: string, val: string) => { action = val; return { or: () => Promise.resolve({ data: bindingsByAction[action] ?? [], error: null }) } },
        }),
      }
    },
  }
}

describe('credStatus (AC-5)', () => {
  it('returns per-action resolved + level; no binding → resolved:false, level:null', async () => {
    const client = mockClient({
      vnc: [{ level: 'device', cred_set_id: 'c1' }],
      ssh: [{ level: 'point', cred_set_id: 'c2' }],
      // rdp — no binding
    })
    const out = await credStatus(client as never, 'd1', ['vnc', 'ssh', 'rdp'])
    expect(out).toEqual([
      { action: 'vnc', resolved: true, level: 'device' },
      { action: 'ssh', resolved: true, level: 'point' },
      { action: 'rdp', resolved: false, level: null },
    ])
  })

  it('device wins over point (resolve order)', async () => {
    const client = mockClient({ vnc: [{ level: 'point', cred_set_id: 'c2' }, { level: 'device', cred_set_id: 'c1' }] })
    const out = await credStatus(client as never, 'd1', ['vnc'])
    expect(out[0]).toEqual({ action: 'vnc', resolved: true, level: 'device' })
  })
})
