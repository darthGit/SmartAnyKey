// RED→GREEN (points only through apply, devices bound to a point).
// Rework: a device row carries an already resolved `type_id` (from value mapping, not by
// name); applyImport only resolves point number→id + insert. The applyImport contract
// changed against the fleet → fails until rewritten.
import { describe, expect, it } from 'vitest'
import { applyImport } from '../../server/repositories/import'

function fakeSr(seed: Record<string, Array<Record<string, unknown>>> = {}) {
  const writes: Record<string, Array<Record<string, unknown>>> = {}
  return {
    writes,
    from(table: string) {
      return {
        insert(rows: Record<string, unknown> | Array<Record<string, unknown>>) {
          const arr = Array.isArray(rows) ? rows : [rows]
          ;(writes[table] ||= []).push(...arr)
          return { select: () => Promise.resolve({ data: arr.map((_, i) => ({ id: `${table}-${i}` })), error: null }) }
        },
        select() {
          const rows = seed[table] || []
          return {
            in: (col: string, vals: unknown[]) => Promise.resolve({ data: rows.filter(r => vals.includes(r[col])), error: null }),
            then: (res: (x: { data: unknown[], error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
          }
        },
      }
    },
  }
}

describe('applyImport points (AC-1)', () => {
  it('new → insert into points; skip → nothing', async () => {
    const sr = fakeSr()
    const summary = await applyImport(sr as never, 'points', [
      { status: 'new', key: '148', row: { number: '148', address: 'Схід', subnet: '10.0.148.0/24' } },
      { status: 'skip', key: '147', row: { number: '147' } },
    ])
    expect(sr.writes.points).toHaveLength(1)
    expect(sr.writes.points[0]).toMatchObject({ number: '148' })
    expect(summary).toMatchObject({ created: 1, skipped: 1 })
  })
})

describe('applyImport devices (AC-2: type_id already resolved by value mapping)', () => {
  it('resolves point number→id, inserts with the ready type_id (no lookup by name)', async () => {
    const sr = fakeSr({ points: [{ id: 'p-147', number: '147' }], device_types: [{ id: 't-pos', default_action: 'vnc' }] })
    const summary = await applyImport(sr as never, 'devices', [
      { status: 'new', key: '147 10.0.147.9', row: { point: '147', host: '10.0.147.9', label: 'Каса 9', type_id: 't-pos' } },
    ])
    expect(sr.writes.devices).toHaveLength(1)
    expect(sr.writes.devices[0]).toMatchObject({ point_id: 'p-147', type_id: 't-pos', host: '10.0.147.9', label: 'Каса 9' })
    expect(summary).toMatchObject({ created: 1 })
    expect(sr.writes.device_types).toBeUndefined() // no resolve-by-name (only reads default_action)
  })
})

describe('applyImport devices (AC-5: default actions=[type.default_action])', () => {
  it('imported device → actions=[type.default_action] (import has no protocols column)', async () => {
    const sr = fakeSr({ points: [{ id: 'p-147', number: '147' }], device_types: [{ id: 't-pos', default_action: 'vnc' }] })
    await applyImport(sr as never, 'devices', [
      { status: 'new', key: '147 10.0.147.9', row: { point: '147', host: '10.0.147.9', label: 'Каса 9', type_id: 't-pos' } },
    ])
    expect(sr.writes.devices[0]).toMatchObject({ actions: ['vnc'] })
  })
})
