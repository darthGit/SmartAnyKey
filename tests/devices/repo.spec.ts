// RED (updateDevice persists the patch; FK violation → 409, not 500).
// The data-access layer maps PG codes to human statuses (not silent / not 500).
// updateDevice in server/repositories/devices.ts does not exist yet → fails.
import { describe, expect, it } from 'vitest'
import { deleteDevice, updateDevice } from '../../server/repositories/devices'

describe('updateDevice (AC-2)', () => {
  it('saves the patch and returns the updated device', async () => {
    let captured: unknown
    const sr = { from: () => ({ update: (v: unknown) => { captured = v; return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'd1', ...(v as object) }, error: null }) }) }) } } }) }
    const out = await updateDevice(sr as never, 'd1', { actions: ['vnc', 'ssh'], default_action: 'ssh' })
    expect(captured).toMatchObject({ actions: ['vnc', 'ssh'], default_action: 'ssh' })
    expect(out).toMatchObject({ id: 'd1', actions: ['vnc', 'ssh'] })
  })

  it('FK violation (PG 23503) → 409, not 500', async () => {
    const sr = { from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code: '23503', message: 'fk' } }) }) }) }) }) }
    await expect(updateDevice(sr as never, 'd1', { actions: ['vnc'] }))
      .rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('deleteDevice (AC-4)', () => {
  it('removes orphaned device-level bindings, then deletes the device row', async () => {
    const calls: { table: string, filters: Record<string, unknown> }[] = []
    const sr = {
      from: (table: string) => ({
        delete: () => {
          const filters: Record<string, unknown> = {}
          const chain = {
            eq: (col: string, val: unknown) => { filters[col] = val; return chain },
            then: (res: (v: { error: null }) => void) => { calls.push({ table, filters }); return Promise.resolve({ error: null }).then(res) },
          }
          return chain
        },
      }),
    }
    await deleteDevice(sr as never, 'd1')
    // 1) clean up credential_bindings (level=device, target_id=d1) before deleting the device
    expect(calls[0]).toMatchObject({ table: 'credential_bindings', filters: { level: 'device', target_id: 'd1' } })
    expect(calls[1]).toMatchObject({ table: 'devices', filters: { id: 'd1' } })
  })

  it('FK violation (PG 23503) → 409, not 500', async () => {
    const sr = {
      from: () => ({
        delete: () => {
          const chain = {
            eq: () => chain,
            then: (res: (v: { error: { code: string, message: string } }) => void) =>
              Promise.resolve({ error: { code: '23503', message: 'fk' } }).then(res),
          }
          return chain
        },
      }),
    }
    await expect(deleteDevice(sr as never, 'd1')).rejects.toMatchObject({ statusCode: 409 })
  })
})
