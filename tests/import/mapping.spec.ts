// RED (generic mapping, malformed report). Pure functions — module
// server/services/import.ts does not exist yet → the suite fails. The mapping does
// NOT assume a fixed client schema (pilot data validates the engine): the user
// maps their own headers to domain fields.
import { describe, expect, it } from 'vitest'
import { autoMatch, mapRows, parseCsv } from '../../server/services/import'

describe('parseCsv (RFC-4180 minimum)', () => {
  it('parses headers + rows; quotes with a comma inside — one field', () => {
    const p = parseCsv('number,address\n147,"вул. Лесі, 3"\n148,Центр')
    expect(p.headers).toEqual(['number', 'address'])
    expect(p.rows).toEqual([['147', 'вул. Лесі, 3'], ['148', 'Центр']])
  })
})

describe('autoMatch (AC-3 initial mapping by name, not a fixed schema)', () => {
  it('points: human-readable headers → domain fields', () => {
    const m = autoMatch(['Point #', 'Адреса', 'CIDR'], 'points')
    expect(m).toMatchObject({ number: 'Point #', address: 'Адреса', subnet: 'CIDR' })
  })
  it('devices: host/type/point are recognised from aliases', () => {
    const m = autoMatch(['IP', 'Назва', 'Тип', 'Точка'], 'devices')
    expect(m).toMatchObject({ host: 'IP', label: 'Назва', type: 'Тип', point: 'Точка' })
  })
  it('an unrecognised header is not mapped (no fixed schema)', () => {
    expect(autoMatch(['zzz_custom'], 'points').number).toBeUndefined()
  })
})

describe('mapRows (AC-3 arbitrary headers via an explicit mapping)', () => {
  it('client headers a/b/c → number/address/subnet via the mapping', () => {
    const parsed = parseCsv('a,b,c\n147,Центр,10.0.147.0/24')
    const { rows, errors } = mapRows(parsed, { number: 'a', address: 'b', subnet: 'c' }, 'points')
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ number: '147', address: 'Центр', subnet: '10.0.147.0/24' })
  })
})

describe('mapRows (AC-4 malformed rows are reported, NOT silently lost)', () => {
  it('a row without the required number → in errors with its line number, not in rows', () => {
    // subnet is now required too → a full mapping, otherwise the valid row 148
    // would also become malformed and the test would check something other
    // than what it claims.
    const parsed = parseCsv('number,address,subnet\n,Центр,10.0.1.0/24\n148,Схід,10.0.2.0/24')
    const { rows, errors } = mapRows(parsed, { number: 'number', address: 'address', subnet: 'subnet' }, 'points')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ number: '148' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ line: 2 }) // 1-based, header = line 1
  })
  it('a device without host/type/point → error, not a silent drop', () => {
    const parsed = parseCsv('host,type,point\n10.0.0.5,,147')
    const { rows, errors } = mapRows(parsed, { host: 'host', type: 'type', point: 'point' }, 'devices')
    expect(rows).toHaveLength(0)
    expect(errors).toHaveLength(1)
  })

  it('points_require_address_and_subnet', () => {
    // Earlier bug: REQUIRED.points = ['number'], while address/subnet are
    // NOT NULL in 0001_schema.sql → a CSV without them passed preview and failed
    // with a raw 502 on apply (all validation belongs in preview).
    const parsed = parseCsv('number\n147\n148')
    const { rows, errors } = mapRows(parsed, { number: 'number' }, 'points')
    expect(rows).toHaveLength(0)
    expect(errors).toHaveLength(2)
    expect(errors[0]!.reason).toMatch(/address/)
    expect(errors[0]!.reason).toMatch(/subnet/)
  })
})

describe('contacts kind (AC-11)', () => {
  it('contacts_kind_maps_required_fields', () => {
    const parsed = parseCsv('Точка,Вид,Значення,Підпис\n147,phone,+380671234567,директор')
    const m = autoMatch(parsed.headers, 'contacts')
    expect(m).toMatchObject({ point: 'Точка', kind: 'Вид', value: 'Значення', label: 'Підпис' })
    const { rows, errors } = mapRows(parsed, m, 'contacts')
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ point: '147', kind: 'phone', value: '+380671234567', label: 'директор' })
  })

  it('contacts_without_value_is_malformed: label is optional, value is not', () => {
    const parsed = parseCsv('point,kind,value\n147,phone,\n148,email,ivan@example.ua')
    const { rows, errors } = mapRows(parsed, { point: 'point', kind: 'kind', value: 'value' }, 'contacts')
    expect(rows).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ line: 2 })
  })
})
