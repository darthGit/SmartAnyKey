// RED. Pure units of the drift layer:
// diff→drift_events mapping, rogue-over-time escalation, inbox
// grouping, serialized due-point dispatch. DB round-trips live
// in tests/integration/drift.spec.ts. Written before production code — must fail.
import { describe, expect, it } from 'vitest'
import { computeEscalation, diffToDriftRows, groupInbox } from '../../server/services/drift'
import { dispatchDueScans } from '../../server/services/discovery-scan'
import type { DiffEntry } from '../../server/services/discovery'

const P = 'point-1'
const R = 'run-9'
const match = { proposedTypeId: 't', confidence: 70, conflict: false, partial: false, capture: null }
const obs = (ip: string) => ({ ip, ports: [] })

describe('diffToDriftRows (AC-2 — scan yielding changes → drift row per change)', () => {
  const diff: DiffEntry[] = [
    { status: 'new', obs: obs('10.0.6.50'), match, deviceId: null },
    { status: 'matched', obs: obs('10.0.6.6'), match, deviceId: 'd1' }, // no drift
    { status: 'changed', obs: obs('10.0.6.7'), match, deviceId: 'd2' },
    { status: 'rogue', obs: obs('10.0.6.77'), match: null, deviceId: null },
    { status: 'missing', device: { id: 'd3', host: '10.0.6.8', label: 'x', type_id: 't' } },
  ]
  const rows = diffToDriftRows(diff, P, R)

  it('emits one row per non-matched entry (matched produces nothing)', () => {
    expect(rows).toHaveLength(4)
    expect(rows.every(r => r.point_id === P && r.scan_run_id === R)).toBe(true)
  })
  it('new → host_ip set, device_id null', () => {
    expect(rows.find(r => r.change_type === 'new')).toMatchObject({ host_ip: '10.0.6.50', device_id: null })
  })
  it('changed → carries the matched device_id', () => {
    expect(rows.find(r => r.change_type === 'changed')).toMatchObject({ host_ip: '10.0.6.7', device_id: 'd2' })
  })
  it('rogue → host_ip set, device_id null', () => {
    expect(rows.find(r => r.change_type === 'rogue')).toMatchObject({ host_ip: '10.0.6.77', device_id: null })
  })
  it('missing → device_id set, host_ip null', () => {
    expect(rows.find(r => r.change_type === 'missing')).toMatchObject({ host_ip: null, device_id: 'd3' })
  })
})

// RED: the device stays matched (same IP and type), but the machine
// reports a different name → that is drift, visible in the inbox.
describe('diffToDriftRows — hostname change of a matched device (AC-6)', () => {
  it('matched + hostnameChanged → a changed row with device_id and host_ip', () => {
    const diff: DiffEntry[] = [
      { status: 'matched', obs: obs('10.0.6.6'), match, deviceId: 'd1', hostnameChanged: true },
    ]
    expect(diffToDriftRows(diff, P, R)).toEqual([
      { point_id: P, device_id: 'd1', host_ip: '10.0.6.6', change_type: 'changed', scan_run_id: R },
    ])
  })

  it('matched without a name change stays without a row (steady state)', () => {
    const diff: DiffEntry[] = [{ status: 'matched', obs: obs('10.0.6.6'), match, deviceId: 'd1' }]
    expect(diffToDriftRows(diff, P, R)).toEqual([])
  })

  it('first observation of a name (was null) is NOT drift', () => {
    const diff: DiffEntry[] = [
      { status: 'matched', obs: obs('10.0.6.6'), match, deviceId: 'd1', hostnameChanged: false },
    ]
    expect(diffToDriftRows(diff, P, R)).toEqual([])
  })
})

describe('computeEscalation (AC-4 — rogue seen ≥N distinct scans → escalated)', () => {
  it('same host_ip across ≥N distinct scan_run_ids → escalated', () => {
    const ev = [
      { host_ip: '10.0.6.77', scan_run_id: 's1' },
      { host_ip: '10.0.6.77', scan_run_id: 's2' },
      { host_ip: '10.0.6.77', scan_run_id: 's3' },
      { host_ip: '10.0.6.99', scan_run_id: 's1' },
    ]
    expect(computeEscalation(ev, 3)).toEqual(new Set(['10.0.6.77']))
  })
  it('repeats within the SAME scan do not count (distinct scans only)', () => {
    const ev = [
      { host_ip: '10.0.6.77', scan_run_id: 's1' },
      { host_ip: '10.0.6.77', scan_run_id: 's1' },
      { host_ip: '10.0.6.77', scan_run_id: 's1' },
    ]
    expect(computeEscalation(ev, 3)).toEqual(new Set())
  })
})

describe('groupInbox (AC-3 — points with unacked drift, grouped + escalated flag)', () => {
  // One rogue host seen in 3 scans + one host seen twice: 5 event rows, 2 hosts.
  const rows = [
    { point_id: 'p1', point_number: 11, change_type: 'new' as const, host_ip: '10.0.6.1', device_id: null, scan_run_id: 's1' },
    { point_id: 'p1', point_number: 11, change_type: 'new' as const, host_ip: '10.0.6.1', device_id: null, scan_run_id: 's2' },
    { point_id: 'p1', point_number: 11, change_type: 'rogue' as const, host_ip: '10.0.6.77', device_id: null, scan_run_id: 's1' },
    { point_id: 'p1', point_number: 11, change_type: 'rogue' as const, host_ip: '10.0.6.77', device_id: null, scan_run_id: 's2' },
    { point_id: 'p1', point_number: 11, change_type: 'rogue' as const, host_ip: '10.0.6.77', device_id: null, scan_run_id: 's3' },
    { point_id: 'p2', point_number: 22, change_type: 'missing' as const, host_ip: null, device_id: 'd3', scan_run_id: 's9' },
    { point_id: 'p2', point_number: 22, change_type: 'missing' as const, host_ip: null, device_id: 'd3', scan_run_id: 's10' },
  ]
  const inbox = groupInbox(rows, 3)

  it('counts DISTINCT hosts per change_type, not event rows', () => {
    const p1 = inbox.find(p => p.point_id === 'p1')!
    expect(p1.point_number).toBe(11)
    expect(p1.counts).toMatchObject({ new: 1, rogue: 1 }) // not 2 / 3 (one host each)
    expect(p1.total).toBe(2)
  })
  it('missing rows (no host_ip) dedupe by device_id', () => {
    const p2 = inbox.find(p => p.point_id === 'p2')!
    expect(p2.counts.missing).toBe(1) // same device across 2 scans
    expect(p2.total).toBe(1)
  })
  it('marks the rogue host escalated once it hits N distinct scans', () => {
    expect(inbox.find(p => p.point_id === 'p1')!.escalated).toContain('10.0.6.77')
    expect(inbox.find(p => p.point_id === 'p2')!.escalated).toEqual([])
  })
})

describe('dispatchDueScans (AC-1 auto-trigger, AC-5 serialized — no burst)', () => {
  // Minimal fake: 2 due points; records dispatch lifecycle to assert sequencing.
  function fakeClient(due: { id: string, number: number, subnet: string, scan_cadence_minutes: number }[]) {
    const inserted: string[] = []
    const bumped: string[] = []
    const client = {
      from(table: string) {
        return {
          // duePoints()
          select: () => ({
            not: () => ({ lte: () => Promise.resolve({ data: due, error: null }) }),
          }),
          // insertRunning()
          insert: (row: Record<string, unknown>) => {
            if (table === 'task_run')
              inserted.push(String(row.ref_id))
            return { select: () => ({ single: () => Promise.resolve({ data: { id: `run-${row.ref_id}` }, error: null }) }) }
          },
          // bumpNextScan()
          update: () => ({ eq: () => { bumped.push('x'); return Promise.resolve({ error: null }) } }),
        }
      },
    }
    return { client, inserted, bumped }
  }

  it('inserts a discovery-scan run for every due point and runs them sequentially', async () => {
    const due = [
      { id: 'a', number: 1, subnet: '10.0.1.0/24', scan_cadence_minutes: 60 },
      { id: 'b', number: 2, subnet: '10.0.2.0/24', scan_cadence_minutes: 60 },
    ]
    const { client, inserted, bumped } = fakeClient(due)
    const order: string[] = []
    const runOne = async (_c: unknown, _runId: string, pointId: string) => {
      order.push(`start:${pointId}`)
      await Promise.resolve()
      order.push(`end:${pointId}`)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await dispatchDueScans(client as any, new Date('2026-07-20T00:00:00Z'), runOne)

    expect(n).toBe(2)
    expect(inserted).toEqual(['a', 'b'])       // a run per due point
    expect(bumped).toHaveLength(2)             // next_scan_at advanced
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']) // serialized: not start:a,start:b (burst)
  })
})
