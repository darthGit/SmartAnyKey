// Integration.
// Harness as in tests/integration/manual-add-device.spec.ts: service-role
// round-trips, no HTTP to :3000 (requireRole needs an H3Event — the gates are
// checked by tests/points/guard.spec.ts). Precondition: the stack is up.
//
// The point-delete test is the main one. credential_bindings.target_id has no FK
// (0004_credential_bindings.sql), and the points→devices cascade does NOT call
// deleteDevice → without an explicit cleanup bindings of both levels are orphaned.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createSchema } from '../../server/services/points'
import { countBlastRadius, createPoint, deletePoint } from '../../server/repositories/points'
import { createContact, deleteContact, findPointsByValue } from '../../server/repositories/point-contacts'

const service = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)

const POINT_NUMBER = 90812
const OTHER_NUMBER = 90813
const TYPE_SLUG = '__point-crud-test__'
const CRED_NAME = '__point-crud-test-cred__'

let typeId: string
let credSetId: string

async function cleanup() {
  for (const n of [POINT_NUMBER, OTHER_NUMBER, OTHER_NUMBER + 1]) {
    const { data } = await service.from('points').select('id').eq('number', n).maybeSingle()
    const id = (data as { id: string } | null)?.id
    if (id) {
      const { data: devs } = await service.from('devices').select('id').eq('point_id', id)
      const devIds = (devs ?? []).map(d => (d as { id: string }).id)
      if (devIds.length)
        await service.from('credential_bindings').delete().eq('level', 'device').in('target_id', devIds)
      await service.from('credential_bindings').delete().eq('level', 'point').eq('target_id', id)
      await service.from('points').delete().eq('id', id)
    }
  }
  await service.from('device_types').delete().eq('slug', TYPE_SLUG)
  await service.from('credential_sets').delete().eq('name', CRED_NAME)
}

beforeAll(async () => {
  await cleanup()
  const { data: t } = await service.from('device_types').insert({
    slug: TYPE_SLUG, name: 'Point CRUD Test', icon: '🧪', color: '#888', default_action: 'ssh',
  }).select('id').single()
  typeId = (t as { id: string }).id

  const { data: c } = await service.from('credential_sets')
    .insert({ name: CRED_NAME, username: 'tester' }).select('id').single()
  credSetId = (c as { id: string }).id
})

afterAll(cleanup)

// A full "live" node: point + device + bindings of both levels + runbook + contacts.
async function seedFullPoint(number: number) {
  const input = createSchema.parse({
    number, address: 'point-crud-test', subnet: '10.90.81.0/24',
  })
  const point = await createPoint(service, input)

  const { data: d } = await service.from('devices').insert({
    point_id: point.id, type_id: typeId, label: 'PC-1', host: '10.90.81.10', actions: ['ssh'],
  }).select('id').single()
  const deviceId = (d as { id: string }).id

  await service.from('credential_bindings').insert([
    { level: 'point', target_id: point.id, action: 'ssh', cred_set_id: credSetId },
    { level: 'device', target_id: deviceId, action: 'ssh', cred_set_id: credSetId },
  ])

  await service.from('runbooks').insert({
    point_id: point.id, title: 'point-crud-test runbook', body: 'body',
  })

  await createContact(service, point.id, { kind: 'phone', value: '+380 67 123-45-67', label: 'директор' })
  await createContact(service, point.id, { kind: 'email', value: 'Ivan@Example.UA' })

  return { pointId: point.id, deviceId }
}

describe('createPoint (AC-1, AC-3)', () => {
  it('inserts_point_with_given_values', async () => {
    const point = await createPoint(service, createSchema.parse({
      number: OTHER_NUMBER, address: 'створено вручну', subnet: '10.90.82.0/24',
    }))
    expect(point.id).toBeTruthy()

    const { data } = await service.from('points')
      .select('number,address,subnet').eq('id', point.id).single()
    expect(data).toMatchObject({
      number: OTHER_NUMBER, address: 'створено вручну', subnet: '10.90.82.0/24',
    })
  })

  it('duplicate_number_maps_to_409: a taken number = a user conflict, not 502', async () => {
    await expect(createPoint(service, createSchema.parse({
      number: OTHER_NUMBER, address: 'дубль', subnet: '10.90.83.0/24',
    }))).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('countBlastRadius (AC-5)', () => {
  it('blast_radius_counts_children: shows exactly what disappears along with the point', async () => {
    const { pointId } = await seedFullPoint(POINT_NUMBER)
    const counts = await countBlastRadius(service, pointId)
    expect(counts.devices).toBe(1)
    expect(counts.runbooks).toBe(1)
    expect(counts.contacts).toBe(2)
    await deletePoint(service, pointId)
  })
})

describe('deletePoint (AC-4)', () => {
  it('delete_point_clears_bindings_of_both_levels', async () => {
    const { pointId, deviceId } = await seedFullPoint(POINT_NUMBER)

    // Precondition: both bindings really exist — otherwise the test is tautological.
    const { count: before } = await service.from('credential_bindings')
      .select('id', { count: 'exact', head: true })
      .or(`and(level.eq.point,target_id.eq.${pointId}),and(level.eq.device,target_id.eq.${deviceId})`)
    expect(before).toBe(2)

    await deletePoint(service, pointId)

    const { data: point } = await service.from('points').select('id').eq('id', pointId).maybeSingle()
    expect(point).toBeNull()

    const { count: devices } = await service.from('devices')
      .select('id', { count: 'exact', head: true }).eq('point_id', pointId)
    expect(devices).toBe(0)

    const { count: runbooks } = await service.from('runbooks')
      .select('id', { count: 'exact', head: true }).eq('point_id', pointId)
    expect(runbooks).toBe(0)

    const { count: contacts } = await service.from('point_contacts')
      .select('id', { count: 'exact', head: true }).eq('point_id', pointId)
    expect(contacts).toBe(0)

    // The point: no orphaned binding — neither point- nor device-level.
    const { count: pointBindings } = await service.from('credential_bindings')
      .select('id', { count: 'exact', head: true }).eq('level', 'point').eq('target_id', pointId)
    expect(pointBindings).toBe(0)

    const { count: deviceBindings } = await service.from('credential_bindings')
      .select('id', { count: 'exact', head: true }).eq('level', 'device').eq('target_id', deviceId)
    expect(deviceBindings).toBe(0)
  })
})

describe('contacts (AC-9, AC-10)', () => {
  it('duplicate_contact_value_maps_to_409: the same number on the same point — a conflict, not 502', async () => {
    const { pointId } = await seedFullPoint(POINT_NUMBER)
    // Another human spelling of the same number → the same value_norm.
    await expect(createContact(service, pointId, { kind: 'phone', value: '0671234567' }))
      .resolves.toBeTruthy() // a different number by value_norm — not a duplicate
    await expect(createContact(service, pointId, { kind: 'phone', value: '+380 (67) 123 45 67' }))
      .rejects.toMatchObject({ statusCode: 409 })
    await deletePoint(service, pointId)
  })

  it('lookup_by_value_returns_owning_point: an exact match works without PHONE_MATCH_TAIL', async () => {
    const { pointId } = await seedFullPoint(POINT_NUMBER)
    const hits = await findPointsByValue(service, '+380671234567', 'phone', undefined)
    expect(hits.map(h => h.point_id)).toContain(pointId)
    expect(hits.find(h => h.point_id === pointId)).toMatchObject({ number: POINT_NUMBER })
    await deletePoint(service, pointId)
  })

  it('lookup_matches_national_form_with_tail: 0671234567 finds +380… by a tail of 9', async () => {
    const { pointId } = await seedFullPoint(POINT_NUMBER)
    expect((await findPointsByValue(service, '0671234567', 'phone', undefined))
      .map(h => h.point_id)).not.toContain(pointId)
    expect((await findPointsByValue(service, '0671234567', 'phone', 9))
      .map(h => h.point_id)).toContain(pointId)
    await deletePoint(service, pointId)
  })

  it('deleteContact_is_scoped_by_point: a foreign pointId does not delete the contact', async () => {
    const { pointId } = await seedFullPoint(POINT_NUMBER)
    const { data: rows } = await service.from('point_contacts').select('id').eq('point_id', pointId)
    const contactId = (rows as { id: string }[])[0]!.id
    const strangerPoint = await createPoint(service, createSchema.parse({
      number: OTHER_NUMBER + 1, address: 'stranger', subnet: '10.90.84.0/24',
    }))

    await expect(deleteContact(service, strangerPoint.id, contactId)).rejects.toMatchObject({ statusCode: 404 })
    const { data: still } = await service.from('point_contacts').select('id').eq('id', contactId).maybeSingle()
    expect(still).not.toBeNull()

    await deletePoint(service, strangerPoint.id)
    await deletePoint(service, pointId)
  })
})
