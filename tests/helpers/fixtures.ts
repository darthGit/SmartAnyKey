// An isolated "point → type → device" branch for integration tests.
//
// Why not seed rows: in a live DB there are either several of them (`username='smartanykey'` —
// in two sets, `.single()` throws), or they already have their own bindings
// (the "PC" device type carries a vnc set that overrides the point level) — a test on
// someone else's data is green only on a clean dev seed. The test owns its rows
// and cleans them up.
import type { SupabaseClient } from '@supabase/supabase-js'

export interface DeviceFixture {
  pointId: string
  typeId: string
  deviceId: string
  cleanup: () => Promise<void>
}

export async function createDeviceFixture(service: SupabaseClient, tag: string): Promise<DeviceFixture> {
  const uniq = `${tag}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`

  const { data: type, error: typeErr } = await service.from('device_types')
    .insert({ slug: uniq, name: uniq, icon: 'i-lucide-box', color: 'gray', default_action: 'ssh' })
    .select('id').single()
  if (typeErr) throw new Error(`fixture device_types: ${typeErr.message}`)

  // ponytail: the point number is random from a high range (real numbers are
  // small). A collision hits the unique constraint, i.e. shows up as an insert
  // error, not as a falsely green test; a sequential counter — when
  // fixtures start running in parallel by the hundreds.
  const { data: point, error: pointErr } = await service.from('points')
    .insert({
      number: 900_000_000 + Math.floor(Math.random() * 100_000_000),
      address: `fixture ${uniq}`,
      subnet: '10.255.255.0/24',
    })
    .select('id').single()
  if (pointErr) throw new Error(`fixture points: ${pointErr.message}`)

  const { data: device, error: devErr } = await service.from('devices')
    .insert({
      point_id: point!.id,
      type_id: type!.id,
      label: `fixture ${uniq}`,
      host: '127.0.0.1',
      actions: ['ssh', 'vnc', 'rdp'],
    })
    .select('id').single()
  if (devErr) throw new Error(`fixture devices: ${devErr.message}`)

  return {
    pointId: point!.id,
    typeId: type!.id,
    deviceId: device!.id,
    async cleanup() {
      // points → devices cascade; device_types has no cascade from devices
      await service.from('points').delete().eq('id', point!.id)
      await service.from('device_types').delete().eq('id', type!.id)
    },
  }
}
