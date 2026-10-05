// Integration. Manual device add by an admin.
// Harness like the drift/rbac specs: service-role DB round-trips + a pure RBAC util, no
// HTTP to :3000 (requireRole needs an H3Event — we test its decision via hasRole,
// the zod boundary via createSchema, insert via createDevice). Precondition: stack is up.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { hasRole } from '../../server/utils/rbac'
import { createSchema } from '../../server/services/devices'
import { createDevice } from '../../server/repositories/devices'

const service = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const POINT_NUMBER = 90721
const TYPE_SLUG = '__manual-add-test__'

let pointId: string
let typeId: string
const deviceIds: string[] = []

beforeAll(async () => {
  await service.from('points').delete().eq('number', POINT_NUMBER)
  const { data: p } = await service.from('points').insert({
    number: POINT_NUMBER, address: 'manual-add-test', subnet: '10.90.72.0/24',
  }).select('id').single()
  pointId = (p as { id: string }).id

  await service.from('device_types').delete().eq('slug', TYPE_SLUG)
  const { data: t } = await service.from('device_types').insert({
    slug: TYPE_SLUG, name: 'Manual Add Test', icon: 'i-lucide-server', color: '#888', default_action: 'ssh',
  }).select('id').single()
  typeId = (t as { id: string }).id
})

afterAll(async () => {
  if (deviceIds.length) await service.from('devices').delete().in('id', deviceIds)
  await service.from('points').delete().eq('number', POINT_NUMBER)
  await service.from('device_types').delete().eq('slug', TYPE_SLUG)
})

describe('manual add device', () => {
  it('admin_creates_device_201: valid body → createDevice inserts a row with those values (AC-1)', async () => {
    const input = createSchema.parse({
      point_id: pointId, type_id: typeId, label: 'MA-1', host: '10.90.72.10',
      actions: ['ssh', 'web'], default_action: 'ssh',
    })
    const row = await createDevice(service, input)
    deviceIds.push(row.id)
    expect(row.id).toBeTruthy()

    const { data } = await service.from('devices')
      .select('point_id,type_id,label,host,actions,default_action').eq('id', row.id).single()
    expect(data).toMatchObject({
      point_id: pointId, type_id: typeId, label: 'MA-1', host: '10.90.72.10',
      actions: ['ssh', 'web'], default_action: 'ssh',
    })
  })

  it('non_admin_or_no_bearer_403: controller guard = admin-only, operator/viewer/no-role fall short (AC-2)', () => {
    // The route does requireRole(event,'admin'); the decision is hasRole(role,'admin').
    expect(hasRole('admin', 'admin')).toBe(true)
    expect(hasRole('operator', 'admin')).toBe(false)
    expect(hasRole('viewer', 'admin')).toBe(false)
    expect(hasRole(null, 'admin')).toBe(false) // no Bearer/profile → deny
  })

  it('invalid_body_400: empty actions / default_action∉actions / missing required → zod throw (AC-3)', () => {
    const base = { point_id: pointId, type_id: typeId, label: 'x', host: 'h' }
    // A valid body parses — proves this is a real zod schema, not undefined.parse
    // (otherwise the check would "pass" tautologically from a TypeError in RED).
    expect(() => createSchema.parse({ ...base, actions: ['ssh'] })).not.toThrow()
    expect(() => createSchema.parse({ ...base, actions: [] })).toThrow()
    expect(() => createSchema.parse({ ...base, actions: ['ssh'], default_action: 'rdp' })).toThrow()
    expect(() => createSchema.parse({ type_id: typeId, label: 'x', host: 'h', actions: ['ssh'] })).toThrow() // no point_id
    expect(() => createSchema.parse({ point_id: pointId, label: 'x', host: 'h', actions: ['ssh'] })).toThrow() // no type_id
    expect(() => createSchema.parse({ ...base, label: '', actions: ['ssh'] })).toThrow() // empty label
    expect(() => createSchema.parse({ ...base, host: '', actions: ['ssh'] })).toThrow() // empty host
  })

  it('created_device_visible_in_inventory: the created device reads under its point with type_id, like the inventory board (AC-4)', async () => {
    const input = createSchema.parse({
      point_id: pointId, type_id: typeId, label: 'MA-visible', host: '10.90.72.20', actions: ['ssh'],
    })
    const row = await createDevice(service, input)
    deviceIds.push(row.id)

    // Mirrors the inventory read (repositories/discovered.ts: devices by point_id).
    const { data } = await service.from('devices')
      .select('id,host,label,type_id').eq('point_id', pointId)
    const found = (data ?? []).find(d => d.id === row.id)
    expect(found).toMatchObject({ label: 'MA-visible', host: '10.90.72.20', type_id: typeId })
  })
})
