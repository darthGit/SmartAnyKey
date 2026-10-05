// RED→GREEN (value mapping: type via our id, not a guessed name; validation
// in preview: unresolvable → blocked, not a silent fail). Pure functions.
import { describe, expect, it } from 'vitest'
import { buildImport, distinctValues, parseCsv } from '../../server/services/import'

describe('distinctValues (AC-7 — values for value mapping)', () => {
  it('unique non-empty values of the mapped column', () => {
    const parsed = parseCsv('host,type,point\n10.0.0.1,kassa,147\n10.0.0.2,kassa,147\n10.0.0.3,router,147')
    expect(distinctValues(parsed, { host: 'host', type: 'type', point: 'point' }, 'type').sort())
      .toEqual(['kassa', 'router'])
  })
})

const DEVICES_CSV = 'host,type,point\n10.0.147.9,kassa,147\n10.0.147.10,unknowntype,147\n10.0.147.11,kassa,999'
const mapping = { host: 'host', type: 'type', point: 'point' }
const ctx = {
  existing: [],
  valueMap: { kassa: 't-pos' }, // the client mapped "kassa" → our type t-pos
  typeIds: new Set(['t-pos', 't-router']),
  pointNumbers: new Set(['147']),
}

describe('buildImport devices (AC-7/8)', () => {
  const plan = buildImport('devices', DEVICES_CSV, mapping, ctx)

  it('AC-7: a valid row carries the resolved type_id from valueMap (not the name)', () => {
    const ok = plan.diff.find(d => d.row.host === '10.0.147.9')
    expect(ok).toBeTruthy()
    expect(ok.row.type_id).toBe('t-pos')
    expect(ok.status).toBe('new')
  })

  it('AC-8: an unresolvable type (not in valueMap/typeIds) → blocked, not in diff', () => {
    expect(plan.diff.some(d => d.row.host === '10.0.147.10')).toBe(false)
    expect(plan.blocked.some(b => b.row.host === '10.0.147.10')).toBe(true)
  })

  it('AC-8: a nonexistent point → blocked, not in diff', () => {
    expect(plan.diff.some(d => d.row.host === '10.0.147.11')).toBe(false)
    expect(plan.blocked.some(b => b.row.host === '10.0.147.11')).toBe(true)
  })

  it('typeValues exposes distinct values for the value-mapping UI', () => {
    expect(plan.typeValues.sort()).toEqual(['kassa', 'unknowntype'])
  })
})
