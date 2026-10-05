// RED (re-import without duplicates, dry-run writes nothing). Pure
// function reconcileByKey — propose-don't-write (ADR-012): takes existing rows
// as an argument, returns proposals, no DB access. The module does not exist yet → fails.
import { describe, expect, it } from 'vitest'
import { reconcileByKey } from '../../server/services/import'

describe('reconcileByKey points (AC-5 key = number)', () => {
  const existing = [{ number: '147', address: 'Центр', subnet: '10.0.147.0/24' }]

  it('new number → new', () => {
    const [e] = reconcileByKey('points', [{ number: '148', address: 'Схід' }], existing)
    expect(e).toMatchObject({ status: 'new', key: '148' })
  })
  it('same number, identical fields → skip (re-import does not breed duplicates)', () => {
    const [e] = reconcileByKey('points', [{ number: '147', address: 'Центр', subnet: '10.0.147.0/24' }], existing)
    expect(e.status).toBe('skip')
  })
  it('same number, changed field → update (not a second row)', () => {
    const d = reconcileByKey('points', [{ number: '147', address: 'Нова адреса', subnet: '10.0.147.0/24' }], existing)
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ status: 'update', key: '147' })
  })
})

describe('reconcileByKey devices (AC-5 key = point+host)', () => {
  const existing = [{ point: '147', host: '10.0.147.5', type: 'pc', label: 'Каса 1' }]

  it('same (point,host), identical → skip', () => {
    const [e] = reconcileByKey('devices', [{ point: '147', host: '10.0.147.5', type: 'pc', label: 'Каса 1' }], existing)
    expect(e.status).toBe('skip')
  })
  it('same host on another point → new (the key includes the point)', () => {
    const [e] = reconcileByKey('devices', [{ point: '148', host: '10.0.147.5', type: 'pc', label: 'x' }], existing)
    expect(e.status).toBe('new')
  })
})

describe('reconcileByKey contacts (AC-11)', () => {
  // Key = (point, kind, value): the same triple is the same contact, so
  // re-importing the file gives skip, not a second row.
  const existing = [{ point: '147', kind: 'phone', value: '+380671234567', label: 'директор' }]

  it('repeat_contacts_import_is_skip', () => {
    const [e] = reconcileByKey('contacts', [
      { point: '147', kind: 'phone', value: '+380671234567', label: 'директор' },
    ], existing)
    expect(e.status).toBe('skip')
  })

  it('same number on another point → new (the key includes the point)', () => {
    const [e] = reconcileByKey('contacts', [
      { point: '148', kind: 'phone', value: '+380671234567' },
    ], existing)
    expect(e.status).toBe('new')
  })

  it('changed label with the same (point,kind,value) → update, not a duplicate', () => {
    const d = reconcileByKey('contacts', [
      { point: '147', kind: 'phone', value: '+380671234567', label: 'черговий' },
    ], existing)
    expect(d).toHaveLength(1)
    expect(d[0]!.status).toBe('update')
  })
})

describe('reconcileByKey (AC-6 dry-run: pure, writes nothing)', () => {
  it('no existing → all new; calling twice gives an identical result (no side effects)', () => {
    const rows = [{ number: '147' }, { number: '148' }]
    const a = reconcileByKey('points', rows, [])
    const b = reconcileByKey('points', rows, [])
    expect(a).toEqual(b)
    expect(a.every(e => e.status === 'new')).toBe(true)
  })
})
