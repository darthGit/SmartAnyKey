// Repository: points schedule + drift_events access. Only layer that
// touches the DB.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DriftRow, InboxEventRow } from '../services/drift'

export interface DuePoint { id: string, number: number, subnet: string, scan_cadence_minutes: number }

// Points whose schedule is due: cadence set AND next_scan_at reached.
export async function duePoints(client: SupabaseClient, now: Date): Promise<DuePoint[]> {
  const { data, error } = await client
    .from('points')
    .select('id,number,subnet,scan_cadence_minutes')
    .not('scan_cadence_minutes', 'is', null)
    .lte('next_scan_at', now.toISOString())
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return (data ?? []) as DuePoint[]
}

// Advance the point's next due time. Called BEFORE the scan runs → the next tick
// won't re-pick a point already in flight (re-entrancy guard).
export async function bumpNextScan(client: SupabaseClient, pointId: string, cadenceMinutes: number, from: Date): Promise<void> {
  const next = new Date(from.getTime() + cadenceMinutes * 60_000).toISOString()
  const { error } = await client.from('points').update({ next_scan_at: next }).eq('id', pointId)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
}

// Set/clear a point's rescan schedule (admin). Enabling → next_scan_at = now so the
// next tick scans it (immediate feedback); disabling (null) → clears both.
export async function setSchedule(client: SupabaseClient, pointId: string, cadenceMinutes: number | null, now: Date): Promise<void> {
  const { error } = await client.from('points')
    .update({ scan_cadence_minutes: cadenceMinutes, next_scan_at: cadenceMinutes == null ? null : now.toISOString() })
    .eq('id', pointId)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
}

export async function insertDriftEvents(client: SupabaseClient, rows: DriftRow[]): Promise<void> {
  if (rows.length === 0)
    return
  const { error } = await client.from('drift_events').insert(rows)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
}

// All unacknowledged drift, flattened with the point number (for inbox grouping).
// ponytail: no pagination — the inbox is a review queue meant to be acked down;
// add .range() paging if unacked drift ever crosses the PGRST 1000-cap.
export async function unackedDriftEvents(client: SupabaseClient): Promise<InboxEventRow[]> {
  const { data, error } = await client
    .from('drift_events')
    .select('point_id,change_type,host_ip,device_id,scan_run_id,points(number)')
    .is('acknowledged_at', null)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return (data ?? []).map((r: Record<string, unknown>) => ({
    point_id: r.point_id as string,
    point_number: (r.points as { number: number } | null)?.number ?? 0,
    change_type: r.change_type as InboxEventRow['change_type'],
    host_ip: (r.host_ip as string | null) ?? null,
    // identity fallback for `missing` rows (no IP) — grouping dedupes on it
    device_id: (r.device_id as string | null) ?? null,
    scan_run_id: r.scan_run_id as string,
  }))
}

// Ack clears a point's unacknowledged drift in one action (bulk per point).
export async function ackPoint(client: SupabaseClient, pointId: string, now: Date): Promise<number> {
  const { data, error } = await client
    .from('drift_events')
    .update({ acknowledged_at: now.toISOString() })
    .eq('point_id', pointId).is('acknowledged_at', null)
    .select('id')
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return (data ?? []).length
}
