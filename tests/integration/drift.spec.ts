// Integration — live DB round-trips the unit specs can't cover: drift_events
// write/read + FK/check constraints, inbox aggregation + ack clear, scheduled
// dispatch creating a real task_run for a due point. Serialization is
// unit-tested (deterministic ordering).
// Precondition: stack up + migration 0011 applied.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { ackPoint, bumpNextScan, insertDriftEvents, setSchedule } from '../../server/repositories/drift'
import { dispatchDueScans } from '../../server/services/discovery-scan'
import { driftInbox } from '../../server/services/drift'

const service = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const POINT_NUMBER = 90011
const ROGUE_IP = '10.90.11.77'

let pointId: string
const runIds: string[] = []

async function mkRun() {
  const { data } = await service.from('task_run').insert({
    kind: 'discovery-scan', actor: '__drift_test__', status: 'done',
    ref_id: pointId, label: 'drift-test', input: {},
  }).select('id').single()
  const id = (data as { id: string }).id
  runIds.push(id)
  return id
}

beforeAll(async () => {
  await service.from('points').delete().eq('number', POINT_NUMBER)
  const { data } = await service.from('points').insert({
    number: POINT_NUMBER, address: 'drift-test', subnet: '10.90.11.0/24',
  }).select('id').single()
  pointId = (data as { id: string }).id
})

afterAll(async () => {
  // FK: drift_events cascade on point delete; task_run scan_run_id set null. Clean both.
  await service.from('drift_events').delete().eq('point_id', pointId)
  if (runIds.length)
    await service.from('task_run').delete().in('id', runIds)
  await service.from('task_run').delete().eq('actor', 'scheduler').eq('ref_id', pointId)
  await service.from('points').delete().eq('id', pointId)
})

describe('drift_events persistence (AC-2)', () => {
  it('writes a drift row and reads it back with the right change_type', async () => {
    const runId = await mkRun()
    await insertDriftEvents(service, [
      { point_id: pointId, device_id: null, host_ip: '10.90.11.5', change_type: 'new', scan_run_id: runId },
    ])
    const { data } = await service.from('drift_events')
      .select('change_type,host_ip').eq('point_id', pointId).eq('scan_run_id', runId)
    expect(data).toEqual([{ change_type: 'new', host_ip: '10.90.11.5' }])
  })
})

describe('inbox aggregation + ack (AC-3, AC-4)', () => {
  it('lists the point with unacked drift + escalated rogue; ack clears it', async () => {
    // rogue seen across 3 distinct scans → escalates.
    for (let i = 0; i < 3; i++) {
      const runId = await mkRun()
      await insertDriftEvents(service, [
        { point_id: pointId, device_id: null, host_ip: ROGUE_IP, change_type: 'rogue', scan_run_id: runId },
      ])
    }

    const inbox = await driftInbox(service)
    const mine = inbox.find(p => p.point_id === pointId)
    expect(mine).toBeTruthy()
    expect(mine!.counts.rogue).toBe(1) // 3 rows, ONE distinct host — counts are hosts, not events
    expect(mine!.escalated).toContain(ROGUE_IP)

    const cleared = await ackPoint(service, pointId, new Date())
    expect(cleared).toBeGreaterThanOrEqual(3)
    // second ack clears nothing (already acknowledged).
    expect(await ackPoint(service, pointId, new Date())).toBe(0)

    const after = await driftInbox(service)
    expect(after.find(p => p.point_id === pointId)).toBeUndefined()
  })
})

describe('setSchedule (AC-1 usability — enable/clear a point cadence)', () => {
  it('enabling sets cadence + a due next_scan_at; clearing nulls both', async () => {
    const now = new Date('2026-07-20T10:00:00Z')
    await setSchedule(service, pointId, 60, now)
    const { data: on } = await service.from('points').select('scan_cadence_minutes,next_scan_at').eq('id', pointId).single()
    expect((on as { scan_cadence_minutes: number }).scan_cadence_minutes).toBe(60)
    // next_scan_at = now → due on the next tick (immediate feedback).
    expect(new Date((on as { next_scan_at: string }).next_scan_at).toISOString()).toBe(now.toISOString())

    await setSchedule(service, pointId, null, now)
    const { data: off } = await service.from('points').select('scan_cadence_minutes,next_scan_at').eq('id', pointId).single()
    expect(off).toMatchObject({ scan_cadence_minutes: null, next_scan_at: null })
  })
})

describe('scheduled dispatch (AC-1)', () => {
  it('a due point auto-triggers a discovery-scan run (no manual call)', async () => {
    const now = new Date('2026-07-20T12:00:00Z')
    // make the point due: cadence set, next_scan_at in the past.
    await service.from('points')
      .update({ scan_cadence_minutes: 60, next_scan_at: new Date(now.getTime() - 60_000).toISOString() })
      .eq('id', pointId)

    // inject a no-op runner (real one would launch nmap); we assert the DB effects.
    const ran: string[] = []
    const n = await dispatchDueScans(service, now, async (_c, _r, pid) => { ran.push(pid) })

    expect(n).toBeGreaterThanOrEqual(1)
    expect(ran).toContain(pointId)

    // a scheduler run row now exists for the point (auto-triggered).
    const { data: runs } = await service.from('task_run')
      .select('id,kind,actor').eq('actor', 'scheduler').eq('ref_id', pointId)
    expect(runs!.length).toBeGreaterThanOrEqual(1)
    expect(runs![0]).toMatchObject({ kind: 'discovery-scan' })

    // next_scan_at advanced into the future (no re-pick next tick).
    const { data: pt } = await service.from('points').select('next_scan_at').eq('id', pointId).single()
    expect(new Date((pt as { next_scan_at: string }).next_scan_at).getTime()).toBeGreaterThan(now.getTime())

    // sanity: bumpNextScan math is +cadence from `from`.
    await bumpNextScan(service, pointId, 30, now)
    const { data: pt2 } = await service.from('points').select('next_scan_at').eq('id', pointId).single()
    expect(new Date((pt2 as { next_scan_at: string }).next_scan_at).toISOString())
      .toBe(new Date(now.getTime() + 30 * 60_000).toISOString())
  })
})
