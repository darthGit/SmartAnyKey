// RED: maps the signals chosen on the teach screen
// → device_type_signatures rows. regex/capture → a row. Several samples per type
// generalise (OR / several rows, not 1:1). Module app/utils/teachSignatureDraft does
// not exist yet → fails.
import { describe, expect, it } from 'vitest'
import { teachSignatureDraft } from '../../app/utils/teachSignatureDraft'

describe('teachSignatureDraft (AC-3)', () => {
  it('chosen signal + regex + capture → a device_type_signatures row', () => {
    const rows = teachSignatureDraft('router', [
      { signal_type: 'banner', pattern: 'RouterOS ([\\d.]+)', capture_target: 'hostname' },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      type_id: 'router',
      signal_type: 'banner',
      pattern: 'RouterOS ([\\d.]+)',
      capture_target: 'hostname',
      weight: 50,
    })
  })

  it('defaults: capture_target null, weight 50', () => {
    const rows = teachSignatureDraft('router', [{ signal_type: 'port', pattern: '8291' }])
    expect(rows[0].capture_target).toBeNull()
    expect(rows[0].weight).toBe(50)
  })
})

describe('teachSignatureDraft (AC-6): several samples per type → OR / several rows, not 1:1', () => {
  it('duplicates of one signal are deduplicated (not 1:1)', () => {
    const rows = teachSignatureDraft('router', [
      { signal_type: 'port', pattern: '8291' },
      { signal_type: 'port', pattern: '8291' }, // the same port from another sample
    ])
    expect(rows).toHaveLength(1)
  })

  it('different ports of one type → several rows', () => {
    const rows = teachSignatureDraft('router', [
      { signal_type: 'port', pattern: '8291' },
      { signal_type: 'port', pattern: '8728' },
    ])
    expect(rows.filter(r => r.signal_type === 'port')).toHaveLength(2)
  })

  it('several regex variants of one signal_type → one OR row', () => {
    const rows = teachSignatureDraft('router', [
      { signal_type: 'banner', pattern: 'RouterOS 6' },
      { signal_type: 'banner', pattern: 'RouterOS 7' },
    ])
    const banner = rows.filter(r => r.signal_type === 'banner')
    expect(banner).toHaveLength(1)
    // OR form — matches any variant (generalisation, not 1:1)
    expect(new RegExp(banner[0].pattern).test('RouterOS 7.1')).toBe(true)
    expect(new RegExp(banner[0].pattern).test('RouterOS 6.4')).toBe(true)
  })
})
