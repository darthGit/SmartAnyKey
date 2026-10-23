// Domain service: point-scan executor. Orchestrates scanner → matcher → reconcile
// → persist (3-Tier: nmap in the scanner repo, DB in the discovered repo). runDetached
// style: the controller inserts task_run(running), calls this, returns 202; here we
// execute and finalise the row. The scan writes nothing to devices — only
// discovered_hosts (proposals); the ONLY exception is the hostname triple of an observed
// fact, which never touches label/type_id/host.
import type { SupabaseClient } from '@supabase/supabase-js'
import { scanSubnet } from '../repositories/scanner'
import { getAllRecentHosts, getKnownDevices, getPoint, getSignatures, listHosts, replaceHosts, updateDeviceHostname, type HostRow, type PointRow } from '../repositories/discovered'
import { hostnameUpdates, matchType, reconcile, resolvePorts, type MatchedObs, type ScanMode } from './discovery'
import type { Observation } from '../repositories/scanner'
import { finish, insertRunning, runningFor, setPhase } from '../repositories/task-runs'
import { bumpNextScan, duePoints, insertDriftEvents } from '../repositories/drift'
import { diffToDriftRows } from './drift'
import { typeActions } from './device-types'

export interface ScanSummary {
  new: number
  matched: number
  changed: number
  missing: number
  rogue: number
  total: number
}

// Port-scope choice. Default combined = the current behaviour
// (curated ⊇), so calls without opts stay backward-compatible.
export interface ScanOpts {
  mode?: ScanMode
  customPorts?: string
}

export async function runScan(client: SupabaseClient, pointId: string, scanRunId: string, opts: ScanOpts = {}, signal?: AbortSignal): Promise<ScanSummary> {
  const point = await getPoint(client, pointId)
  if (!point)
    throw new Error('point-not-found')

  // Ports derive from the mode: signatures only match, their port must be
  // added to -p explicitly. resolvePorts throws on an invalid custom / empty
  // signatures → lands in finish(failed) with a clear message.
  const signatures = await getSignatures(client)
  const ports = resolvePorts(opts.mode ?? 'combined', signatures, opts.customPorts)

  // Kept simple: unprivileged (-sT, no -O). OS guessing is enabled by granting
  // CAP_NET_RAW + privileged:true — an env toggle, when needed.
  // Progress for the drawer/teach poll: task_run.phase = `stage|nmap task|percent` (nmap reports
  // every 2 s). A failed write must not fail the scan — progress is cosmetic.
  const observations = await scanSubnet(point.subnet, { ports, signal }, (stage, p) => {
    setPhase(client, scanRunId, `${stage}|${p.task}|${Math.round(p.percent)}`).catch(() => {})
  })
  const devices = await getKnownDevices(client, pointId)

  const matched: MatchedObs[] = observations.map(obs => ({ obs, match: matchType(obs, signatures) }))
  const diff = reconcile(matched, devices)

  const rows: HostRow[] = []
  const summary: ScanSummary = { new: 0, matched: 0, changed: 0, missing: 0, rogue: 0, total: 0 }
  for (const e of diff) {
    summary[e.status]++
    if (e.status === 'missing')
      continue
    summary.total++
    rows.push({
      point_id: pointId,
      scan_run_id: scanRunId,
      ip: e.obs.ip,
      hostname: e.obs.hostname ?? null,
      nse_hostname: e.obs.nseHostname ?? null,
      open_ports: e.obs.ports,
      ssh_hostkey: e.obs.sshHostkey ?? null,
      tls_cert_sha256: e.obs.tlsCertSha256 ?? null,
      tls_cert_cn: e.obs.tlsCertCn ?? null,
      os_guess: e.obs.osGuess ?? null,
      proposed_type_id: e.match?.proposedTypeId ?? null,
      confidence: e.match?.confidence ?? null,
      matched_signal: e.match?.matchedOn ?? null,
      reconcile_status: e.status,
      matched_device_id: e.deviceId,
    })
  }
  await replaceHosts(client, pointId, rows)
  // The scan's only write to `devices` — the hostname triple of matched devices
  // (a deliberate exception). `label`/`type_id`/`host`
  // stay with the human-confirmed writers.
  for (const u of hostnameUpdates(diff, devices, new Date().toISOString()))
    await updateDeviceHostname(client, u.deviceId, u.fact)
  // Log drift for every non-matched entry (manual scans too — the inbox is
  // the aggregate; repeats across scans feed rogue escalation).
  await insertDriftEvents(client, diffToDriftRows(diff, pointId, scanRunId))
  return summary
}

// GET diff: observations of the last scan + Missing (devices without a host).
export async function latestDiff(client: SupabaseClient, pointId: string) {
  const hosts = await listHosts(client, pointId)
  const devices = await getKnownDevices(client, pointId)
  const matchedIds = new Set(hosts.map(h => h.matched_device_id).filter(Boolean))
  const missing = devices.filter(d => !matchedIds.has(d.id)).map(d => ({ id: d.id, label: d.label, host: d.host }))
  return { hosts, missing }
}

// Type-rule preview: how many recently scanned hosts would have been proposed by
// this type (against all rules — because the best coverage wins). Answers
// "will my rule fire at all / is it too broad".
export async function previewType(client: SupabaseClient, typeId: string) {
  const [rows, signatures] = await Promise.all([getAllRecentHosts(client), getSignatures(client)])
  let wins = 0
  let full = 0
  for (const r of rows) {
    const obs: Observation = {
      ip: r.ip,
      hostname: r.hostname ?? undefined,
      nseHostname: r.nse_hostname ?? undefined,
      ports: (r.open_ports as Observation['ports']) ?? [],
      sshHostkey: r.ssh_hostkey ?? undefined,
      tlsCertSha256: r.tls_cert_sha256 ?? undefined,
      tlsCertCn: r.tls_cert_cn ?? undefined,
      osGuess: r.os_guess ?? undefined,
    }
    const m = matchType(obs, signatures)
    if (m?.proposedTypeId === typeId) {
      wins++
      if (m.confidence === 100)
        full++
    }
  }
  return { hosts: rows.length, wins, full, partial: wins - full }
}

export interface ConfirmInput {
  ip: string
  typeId: string
  label: string
  defaultAction?: 'vnc' | 'rdp' | 'ssh' | 'web' | null
  actions?: string[]
  bindings?: { action: 'vnc' | 'rdp' | 'ssh', credSetId: string }[]
}

// The single writer into devices. New → a device only via an explicit confirm (type +
// optional cred binding). Binds the observed host to the new device (identity).
export async function confirmDevice(client: SupabaseClient, pointId: string, input: ConfirmInput): Promise<{ id: string }> {
  let actions = input.actions
  if (!actions?.length) {
    const { data: t } = await client.from('device_types').select('default_action,actions').eq('id', input.typeId).maybeSingle()
    actions = t ? typeActions(t as { default_action: string, actions: string[] }) : []
  }
  const { data, error } = await client.from('devices').insert({
    point_id: pointId, type_id: input.typeId, label: input.label, host: input.ip,
    actions, default_action: input.defaultAction ?? null,
  }).select('id').single()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  const deviceId = (data as { id: string }).id

  if (input.bindings?.length) {
    const { error: bErr } = await client.from('credential_bindings').insert(
      input.bindings.map(b => ({ level: 'device', target_id: deviceId, action: b.action, cred_set_id: b.credSetId })))
    if (bErr)
      throw createError({ statusCode: 502, statusMessage: `DB: ${bErr.message}` })
  }
  await client.from('discovered_hosts')
    .update({ matched_device_id: deviceId, reconcile_status: 'matched' })
    .eq('point_id', pointId).eq('ip', input.ip)
  return { id: deviceId }
}

// Scans running in this process, by run id, so Stop can kill their nmap.
// Kept simple: in-process registry — fine while there is one BFF; a second instance could not
// stop the first one's scan (stopPointScan then closes the row, nmap runs to its timeout).
const activeScans = new Map<string, AbortController>()

type Scan = (client: SupabaseClient, pointId: string, runId: string, opts: ScanOpts, signal?: AbortSignal) => Promise<ScanSummary>

// Run the scan and finalise task_run. A stopped scan ends failed/stopped.
export async function runAndFinish(client: SupabaseClient, runId: string, pointId: string, opts: ScanOpts = {}, scan: Scan = runScan): Promise<void> {
  const stop = new AbortController()
  activeScans.set(runId, stop)
  try {
    const summary = await scan(client, pointId, runId, opts, stop.signal)
    await finish(client, runId, { status: 'done', result: summary, error: null })
  }
  catch (err: unknown) {
    await finish(client, runId, {
      status: 'failed', result: null,
      error: stop.signal.aborted ? 'stopped' : err instanceof Error ? err.message.slice(0, 200) : 'error',
    }).catch(() => {})
  }
  finally {
    activeScans.delete(runId)
  }
}

// Detached run (on-demand scan route): fire-and-forget, the client polls the row.
export function runScanDetached(client: SupabaseClient, runId: string, pointId: string, opts: ScanOpts = {}): void {
  void runAndFinish(client, runId, pointId, opts)
}

/** Start a scan of the point, or return the one already running there (it is not restarted). */
export async function startPointScan(
  client: SupabaseClient,
  point: PointRow,
  actor: string,
  opts: ScanOpts = {},
  run: (client: SupabaseClient, runId: string, pointId: string, opts: ScanOpts) => void = runScanDetached,
): Promise<{ executionId: string, started: boolean }> {
  const r = await insertRunning(client, {
    kind: 'discovery-scan',
    actor,
    deviceId: null,
    refId: point.id,
    label: `Discover #${point.number}`,
    input: { subnet: point.subnet, mode: opts.mode ?? 'combined', customPorts: opts.customPorts ?? null },
  })
  if (r.existing)
    return { executionId: r.id, started: false }
  run(client, r.id, point.id, opts)
  return { executionId: r.id, started: true }
}

/** Stop the point's running scan; false when nothing runs there. */
export async function stopPointScan(client: SupabaseClient, pointId: string): Promise<boolean> {
  const current = await runningFor(client, 'discovery-scan', pointId)
  if (!current)
    return false
  const scan = activeScans.get(current.id)
  if (scan)
    scan.abort() // runAndFinish closes the row once nmap is gone
  else // not ours (lost after a restart, or another instance): close the row so the point frees up
    await finish(client, current.id, { status: 'failed', result: null, error: 'stopped' })
  return true
}

// Scheduled tick. Select due points, dispatch SERIALLY (await each full
// scan before the next) — genuine staggering, not a simultaneous burst. next_scan_at
// is bumped before the run so the next tick never re-picks an in-flight point.
// Kept simple: one tick runs the whole due cohort sequentially; a huge simultaneous
// cohort makes one tick long — add a per-tick cap / concurrency window if that bites.
export async function dispatchDueScans(
  client: SupabaseClient,
  now: Date = new Date(),
  runOne: (c: SupabaseClient, runId: string, pointId: string) => Promise<void> = runAndFinish,
): Promise<number> {
  const due = await duePoints(client, now)
  for (const p of due) {
    const run = await insertRunning(client, {
      kind: 'discovery-scan', actor: 'scheduler', deviceId: null, refId: p.id,
      label: `Rescan #${p.number}`, input: { subnet: p.subnet, scheduled: true },
    })
    await bumpNextScan(client, p.id, p.scan_cadence_minutes, now)
    // A scan of this point is already going (manual or a previous tick): it is this cycle's scan.
    if (!run.existing)
      await runOne(client, run.id, p.id)
  }
  return due.length
}
