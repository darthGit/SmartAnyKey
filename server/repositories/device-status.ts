// Repository: device_status cache. The only layer with
// DB access; timestamptz(ISO) ↔ epoch ms is converted here (the health service
// computes the cache gate in ms). Written by the service-role client (no write policy → deny).
import { createError } from 'h3'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { StatusRow } from '../services/health'

export async function readByDevices(client: SupabaseClient, deviceIds: string[]): Promise<StatusRow[]> {
  if (deviceIds.length === 0)
    return []
  const { data, error } = await client
    .from('device_status')
    .select('device_id,action,status,latency_ms,error,checked_at')
    .in('device_id', deviceIds)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return (data ?? []).map(r => ({
    device_id: r.device_id as string,
    action: r.action as string,
    status: r.status as StatusRow['status'],
    latency_ms: r.latency_ms as number | null,
    error: r.error as string | null,
    checked_at: new Date(r.checked_at as string).getTime(),
  }))
}

// Upsert on (device_id, action) — the last probe wins (the race is harmless).
export async function upsertStatuses(client: SupabaseClient, rows: StatusRow[]): Promise<void> {
  if (rows.length === 0)
    return
  const { error } = await client.from('device_status').upsert(
    rows.map(r => ({
      device_id: r.device_id,
      action: r.action,
      status: r.status,
      latency_ms: r.latency_ms,
      error: r.error,
      checked_at: new Date(r.checked_at).toISOString(),
    })),
    { onConflict: 'device_id,action' },
  )
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
}
