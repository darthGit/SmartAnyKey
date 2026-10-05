// RED→GREEN (download of a CSV template per kind). A pure function.
import { describe, expect, it } from 'vitest'
import { csvTemplate, parseCsv } from '../../server/services/import'

describe('csvTemplate (AC-9)', () => {
  it('points: headers number/address/subnet + a sample row', () => {
    const t = csvTemplate('points')
    const p = parseCsv(t)
    expect(p.headers).toEqual(['number', 'address', 'subnet'])
    expect(p.rows).toHaveLength(1) // the sample row
  })
  it('devices: headers host/label/type/point + a sample row', () => {
    const p = parseCsv(csvTemplate('devices'))
    expect(p.headers).toEqual(['host', 'label', 'type', 'point'])
    expect(p.rows).toHaveLength(1)
  })
})
