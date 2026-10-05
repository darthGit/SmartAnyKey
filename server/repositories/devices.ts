// Repository: reads a device with credentials using the service key (bypasses RLS —
// `credential_sets` are closed to clients). The only layer with DB access.
// Takes a ready service-role client: HTTP controllers pass
// serverSupabaseServiceRole(event); the ws controller (no H3Event) — adminClient().
import { createError } from 'h3'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DeviceCredentials } from '../services/remote-session'
import type { DeviceCreate, DevicePatch } from '../services/devices'

export interface DeviceForConnection {
  id: string
  label: string
  host: string
  actions: string[]
  default_action: string | null
  type_default_action: string
  // Free-form device data → env of a local task.
  meta: Record<string, unknown>
  // Filled at the call site via resolveCredentials(deviceId, action).
  credentials: DeviceCredentials | null
}

export async function getDeviceForConnection(client: SupabaseClient, deviceId: string): Promise<DeviceForConnection | null> {
  const { data, error } = await client
    .from('devices')
    .select('id,label,host,actions,default_action,meta,device_types(default_action)')
    .eq('id', deviceId)
    .maybeSingle()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  if (!data)
    return null
  return {
    id: data.id,
    label: data.label,
    host: data.host,
    actions: data.actions,
    default_action: data.default_action,
    type_default_action: (data.device_types as { default_action: string }).default_action,
    meta: (data.meta as Record<string, unknown> | null) ?? {},
    credentials: null,
  }
}

// Tier-B fingerprint: last stored hash (for drift)
// + write of a fresh stable probe result (hash + last-raw).
export async function readProbeHash(client: SupabaseClient, deviceId: string): Promise<string | null> {
  const { data, error } = await client
    .from('devices').select('probe_fp_hash').eq('id', deviceId).maybeSingle()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return (data?.probe_fp_hash as string | null) ?? null
}

// The current observed name fact: needed so a weaker
// source does not overwrite a stronger one — decided by `pickHostname`, not the DB.
export async function readHostnameFact(client: SupabaseClient, deviceId: string) {
  const { data, error } = await client
    .from('devices').select('hostname,hostname_source,hostname_at').eq('id', deviceId).maybeSingle()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  if (!data?.hostname)
    return null
  return { value: data.hostname as string, source: (data.hostname_source ?? 'ptr') as 'ssh' | 'nse' | 'ptr', at: (data.hostname_at ?? '') as string }
}

export async function writeProbeFingerprint(client: SupabaseClient, deviceId: string, fp: { hash: string, raw: string }): Promise<void> {
  const { error } = await client.from('devices')
    .update({ probe_fp_hash: fp.hash, probe_fp_raw: fp.raw, probe_fp_at: new Date().toISOString() })
    .eq('id', deviceId)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
}

// Update of a device's protocols/label/default action.
// The single writer of the edit path; an FK violation (23503) → 409, not an FK-500.
export async function createDevice(sr: SupabaseClient, input: DeviceCreate) {
  const { data, error } = await sr.from('devices')
    .insert(input).select('id,point_id,type_id,label,host,actions,default_action').single()
  if (error) {
    if (error.code === '23503')
      throw createError({ statusCode: 409, statusMessage: `FK: ${error.message}` })
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  }
  return data
}

export async function updateDevice(sr: SupabaseClient, id: string, patch: DevicePatch) {
  const { data, error } = await sr.from('devices')
    .update(patch).eq('id', id).select('id,type_id,label,host,actions,default_action,meta').single()
  if (error) {
    if (error.code === '23503')
      throw createError({ statusCode: 409, statusMessage: `FK: ${error.message}` })
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  }
  return data
}

// Device deletion. Device-level `credential_bindings` are
// polymorphic (target_id without FK) → we clean them before delete, otherwise orphaned
// rows remain. Other references to devices are `on delete set null`
// (credential_access_log/discovered_hosts/drift_events) → the DB cleans them itself.
// Any 23503 on the delete path → 409 (not an FK-500).
export async function deleteDevice(sr: SupabaseClient, id: string) {
  const steps = [
    () => sr.from('credential_bindings').delete().eq('level', 'device').eq('target_id', id),
    () => sr.from('devices').delete().eq('id', id),
  ]
  for (const step of steps) {
    const { error } = await step()
    if (error) {
      if (error.code === '23503')
        throw createError({ statusCode: 409, statusMessage: `FK: ${error.message}` })
      throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
    }
  }
}
