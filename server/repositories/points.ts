// Repository: the single writer of `points`
// on the CRUD path. Under RLS `points` has only a select policy (0009) → all writes
// go through the service-role client from the BFF.
import { createError } from 'h3'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BlastRadius, PointCreate, PointPatch } from '../services/points'

const COLS = 'id,number,address,subnet,note,scan_cadence_minutes,next_scan_at'

const numberTaken = () => {
  throw createError({ statusCode: 409, statusMessage: 'point number already exists' })
}
const dbFail = (msg: string) => {
  throw createError({ statusCode: 502, statusMessage: `DB: ${msg}` })
}

// PG codes → human statuses (not silent, not 500). 22P02 = a malformed
// cidr literal; zod should catch it earlier, this is a guard for a direct repo call.
function mapWriteError(error: { code?: string, message: string }): never {
  if (error.code === '23505')
    numberTaken()
  if (error.code === '23503')
    throw createError({ statusCode: 409, statusMessage: `FK: ${error.message}` })
  if (error.code === '22P02')
    throw createError({ statusCode: 400, statusMessage: `invalid literal: ${error.message}` })
  dbFail(error.message)
}

export async function createPoint(sr: SupabaseClient, input: PointCreate) {
  const { data, error } = await sr.from('points').insert(input).select(COLS).single()
  if (error)
    mapWriteError(error)
  return data!
}

export async function updatePoint(sr: SupabaseClient, id: string, patch: PointPatch) {
  const { data, error } = await sr.from('points').update(patch).eq('id', id).select(COLS).single()
  if (error)
    mapWriteError(error)
  return data!
}

async function countOf(sr: SupabaseClient, table: string, col: string, val: string): Promise<number> {
  const { count, error } = await sr.from(table).select('id', { count: 'exact', head: true }).eq(col, val)
  if (error)
    dbFail(error.message)
  return count ?? 0
}

// Blast radius for the delete confirmation (a deferred effect is said out
// loud): what exactly disappears together with the point.
export async function countBlastRadius(sr: SupabaseClient, id: string): Promise<BlastRadius> {
  const deviceIds = await pointDeviceIds(sr, id)
  const [devices, runbooks, contacts, discoveredHosts, driftEvents] = await Promise.all([
    countOf(sr, 'devices', 'point_id', id),
    countOf(sr, 'runbooks', 'point_id', id),
    countOf(sr, 'point_contacts', 'point_id', id),
    countOf(sr, 'discovered_hosts', 'point_id', id),
    countOf(sr, 'drift_events', 'point_id', id),
  ])

  const { count: pointBindings, error } = await sr.from('credential_bindings')
    .select('id', { count: 'exact', head: true }).eq('level', 'point').eq('target_id', id)
  if (error)
    dbFail(error.message)

  let deviceBindings = 0
  if (deviceIds.length) {
    const { count, error: e2 } = await sr.from('credential_bindings')
      .select('id', { count: 'exact', head: true }).eq('level', 'device').in('target_id', deviceIds)
    if (e2)
      dbFail(e2.message)
    deviceBindings = count ?? 0
  }

  return {
    devices,
    runbooks,
    contacts,
    discoveredHosts,
    driftEvents,
    bindings: (pointBindings ?? 0) + deviceBindings,
  }
}

async function pointDeviceIds(sr: SupabaseClient, id: string): Promise<string[]> {
  const { data, error } = await sr.from('devices').select('id').eq('point_id', id)
  if (error)
    dbFail(error.message)
  return (data ?? []).map(d => (d as { id: string }).id)
}

// Point deletion. `credential_bindings.target_id` is polymorphic and has no FK
// (0004) → the cascade does not touch them. The points→devices cascade removes devices
// without calling deleteDevice (repositories/devices.ts), so device-level bindings
// would be orphaned silently — we clean them here, as a separate step, before point-level.
// The other children (devices, device_status, discovered_hosts, drift_events,
// point runbooks, point_contacts) go by cascade; credential_access_log and
// drift_events.device_id — `set null`; `task_run` has no FK → history stays.
export async function deletePoint(sr: SupabaseClient, id: string): Promise<void> {
  const deviceIds = await pointDeviceIds(sr, id)

  const steps: (() => PromiseLike<{ error: { code?: string, message: string } | null }>)[] = [
    ...(deviceIds.length
      ? [() => sr.from('credential_bindings').delete().eq('level', 'device').in('target_id', deviceIds)]
      : []),
    () => sr.from('credential_bindings').delete().eq('level', 'point').eq('target_id', id),
    () => sr.from('points').delete().eq('id', id),
  ]

  for (const step of steps) {
    const { error } = await step()
    if (error)
      mapWriteError(error)
  }
}
