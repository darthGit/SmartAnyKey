// Domain service: pure drift logic —
// reconcile-diff → drift_events rows, rogue-over-time escalation, inbox grouping.
// No DB/HTTP here (3-Tier); the repo persists, the routes serve.
// Domain-agnostic: only generic recon fields (change_type/host_ip), zero
// domain assumptions (pilot data validates the engine, it is not a default).
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DiffEntry } from './discovery'
import { unackedDriftEvents } from '../repositories/drift'

export type ChangeType = 'new' | 'changed' | 'missing' | 'rogue'

export interface DriftRow {
  point_id: string
  device_id: string | null
  host_ip: string | null
  change_type: ChangeType
  scan_run_id: string
}

// A scan yielding changes → one drift row per non-matched reconcile entry.
// matched = no drift (steady state). Written on ANY scan (manual too) — the inbox
// is the aggregate; duplicates across scans are what feeds rogue escalation.
export function diffToDriftRows(diff: DiffEntry[], pointId: string, scanRunId: string): DriftRow[] {
  const rows: DriftRow[] = []
  for (const e of diff) {
    // A matched device = steady state, BUT if the machine named itself differently that is
    // drift: DHCP reshuffled the addresses or the machine
    // was swapped. The reason is not kept in a column — it is derived on read
    // (// ponytail: `drift_events.reason`, if a third kind of "changed" appears).
    if (e.status === 'matched') {
      if (e.hostnameChanged)
        rows.push({ point_id: pointId, device_id: e.deviceId, host_ip: e.obs.ip, change_type: 'changed', scan_run_id: scanRunId })
      continue
    }
    if (e.status === 'missing')
      rows.push({ point_id: pointId, device_id: e.device.id, host_ip: null, change_type: 'missing', scan_run_id: scanRunId })
    else
      rows.push({ point_id: pointId, device_id: e.deviceId, host_ip: e.obs.ip, change_type: e.status, scan_run_id: scanRunId })
  }
  return rows
}

// A rogue identity seen across ≥N DISTINCT scans escalates (distinct from a
// one-off rogue). Identity = host_ip.
// ponytail: identity = host_ip; a hostkey/cert-based identity survives DHCP churn
// better — add that key here if IP-only proves noisy.
export function computeEscalation(events: { host_ip: string | null, scan_run_id: string }[], n: number): Set<string> {
  const byHost = new Map<string, Set<string>>()
  for (const e of events) {
    if (!e.host_ip)
      continue
    if (!byHost.has(e.host_ip))
      byHost.set(e.host_ip, new Set())
    byHost.get(e.host_ip)!.add(e.scan_run_id)
  }
  const out = new Set<string>()
  for (const [host, runs] of byHost)
    if (runs.size >= n)
      out.add(host)
  return out
}

export interface InboxEventRow {
  point_id: string
  point_number: number
  change_type: ChangeType
  host_ip: string | null
  device_id: string | null
  scan_run_id: string
}

export interface InboxPoint {
  point_id: string
  point_number: number
  counts: Record<ChangeType, number> // DISTINCT entities, not event rows
  total: number
  escalated: string[] // rogue host_ips that crossed the escalation threshold
}

// Group unacked drift by point, count per change_type, flag escalated rogues.
// Counts are DISTINCT entities, not rows: drift_events keeps one row per entity per
// scan (needed by computeEscalation), so counting rows inflated the badge — a point
// showed «rogue 228» on a /24 (max 254 hosts) = a few dozen hosts × several scans.
// Dedup is display-only; the write path keeps its duplicates.
// Identity = host_ip, else device_id (missing rows carry no IP); neither → the row
// stands alone. ponytail: same IP-identity ceiling as computeEscalation — a
// hostkey/cert identity would survive DHCP churn, swap both together if it matters.
export function groupInbox(rows: InboxEventRow[], escalationN: number): InboxPoint[] {
  const byPoint = new Map<string, { number: number, keys: Record<ChangeType, Set<string>> }>()
  rows.forEach((r, i) => {
    let p = byPoint.get(r.point_id)
    if (!p) {
      p = { number: r.point_number, keys: { new: new Set(), changed: new Set(), missing: new Set(), rogue: new Set() } }
      byPoint.set(r.point_id, p)
    }
    p.keys[r.change_type].add(r.host_ip ?? r.device_id ?? `row:${i}`)
  })
  const out: InboxPoint[] = []
  for (const [point_id, p] of byPoint) {
    const counts = { new: p.keys.new.size, changed: p.keys.changed.size, missing: p.keys.missing.size, rogue: p.keys.rogue.size }
    out.push({
      point_id,
      point_number: p.number,
      counts,
      // «Ack (N)» = entities the operator clears, not rows.
      total: counts.new + counts.changed + counts.missing + counts.rogue,
      escalated: [...computeEscalation(rows.filter(r => r.point_id === point_id && r.change_type === 'rogue'), escalationN)],
    })
  }
  return out.sort((a, b) => a.point_number - b.point_number)
}

// Escalation threshold: rogue seen across ≥N distinct scans. const, not config.
export const ROGUE_ESCALATION_N = 3

// The inbox — all points with unacknowledged drift, grouped + escalated flags.
export async function driftInbox(client: SupabaseClient): Promise<InboxPoint[]> {
  return groupInbox(await unackedDriftEvents(client), ROGUE_ESCALATION_N)
}
