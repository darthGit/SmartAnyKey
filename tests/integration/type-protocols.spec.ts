// Integration. Protocols on the device type: every creation path takes the type's set,
// and "apply to existing" only adds what is missing. Service-role DB round-trips like
// manual-add-device.spec. Precondition: stack is up, migrations applied.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { confirmDevice } from '../../server/services/discovery-scan'
import { applyImport } from '../../server/repositories/import'
import { applyTypeActions, missingActionCount } from '../../server/repositories/device-types'

const service = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const POINT_NUMBER = 90722
const SLUG = '__type-protocols-test__'
const SLUG_OLD = '__type-protocols-old__'

let pointId: string
let typeId: string
let oldTypeId: string

const actionsOf = async (id: string) => {
  const { data } = await service.from('devices').select('actions').eq('id', id).single()
  return [...(data as { actions: string[] }).actions].sort()
}
const deviceAt = async (host: string) => {
  const { data } = await service.from('devices').select('id').eq('point_id', pointId).eq('host', host).single()
  return (data as { id: string }).id
}

beforeAll(async () => {
  await service.from('points').delete().eq('number', POINT_NUMBER)
  await service.from('device_types').delete().in('slug', [SLUG, SLUG_OLD])
  const { data: p } = await service.from('points').insert({ number: POINT_NUMBER, address: 'type-protocols-test', subnet: '10.90.73.0/24' }).select('id').single()
  pointId = (p as { id: string }).id
  const { data: t, error } = await service.from('device_types').insert({
    slug: SLUG, name: 'Type Protocols Test', icon: 'i-lucide-server', color: '#888', default_action: 'vnc', actions: ['vnc', 'ssh'],
  }).select('id').single()
  if (error) throw new Error(error.message)
  typeId = (t as { id: string }).id
  // a type as old seeds write it: no actions column given
  const { data: o } = await service.from('device_types').insert({
    slug: SLUG_OLD, name: 'Type Protocols Old', icon: 'i-lucide-server', color: '#888', default_action: 'rdp',
  }).select('id').single()
  oldTypeId = (o as { id: string }).id
})

afterAll(async () => {
  await service.from('points').delete().eq('number', POINT_NUMBER) // cascades devices
  await service.from('device_types').delete().in('slug', [SLUG, SLUG_OLD])
})

describe('type protocols', () => {
  it('discovery confirm gives the device every protocol of its type (AC-2)', async () => {
    const { id } = await confirmDevice(service, pointId, { ip: '10.90.73.2', typeId, label: 'confirmed' })
    expect(await actionsOf(id)).toEqual(['ssh', 'vnc'])
  })

  it('import gives the device every protocol of its type (AC-3)', async () => {
    const summary = await applyImport(service, 'devices', [
      { status: 'new', key: 'k1', row: { point: String(POINT_NUMBER), type_id: typeId, host: '10.90.73.3', label: 'imported' } },
    ])
    expect(summary.created).toBe(1)
    expect(await actionsOf(await deviceAt('10.90.73.3'))).toEqual(['ssh', 'vnc'])
  })

  it('a type without the column set creates devices with [default_action], as before (AC-7)', async () => {
    const { id } = await confirmDevice(service, pointId, { ip: '10.90.73.4', typeId: oldTypeId, label: 'old' })
    expect(await actionsOf(id)).toEqual(['rdp'])
  })

  it('apply to existing: counts the devices missing a protocol, adds only, repeat is 0 (AC-5)', async () => {
    const { data: rows } = await service.from('devices').insert([
      { point_id: pointId, type_id: typeId, label: 'a', host: '10.90.73.10', actions: ['vnc'] },
      { point_id: pointId, type_id: typeId, label: 'b', host: '10.90.73.11', actions: ['vnc', 'rdp'] },
    ]).select('id,host')
    const [a, b] = rows as { id: string }[]
    // confirmed + imported devices already have both → only a and b miss ssh
    expect(await missingActionCount(service, typeId)).toBe(2)
    expect(await applyTypeActions(service, typeId)).toBe(2)
    expect(await actionsOf(a!.id)).toEqual(['ssh', 'vnc'])
    expect(await actionsOf(b!.id)).toEqual(['rdp', 'ssh', 'vnc']) // rdp is not in the type, it stays
    expect(await missingActionCount(service, typeId)).toBe(0)
    expect(await applyTypeActions(service, typeId)).toBe(0)
  })
})
