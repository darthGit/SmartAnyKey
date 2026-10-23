// Integration — one running discovery scan per point, held by the database, and a Stop
// that really ends the run. Scans here are fakes that wait on the abort signal, so no nmap
// runs; killing the real process is covered in tests/discovery/scanner.spec.ts.
// Precondition: stack up, migrations applied.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { insertRunning } from '../../server/repositories/task-runs'
import { dispatchDueScans, runAndFinish, startPointScan, stopPointScan } from '../../server/services/discovery-scan'

const service = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const POINT_NUMBER = 90091
const ACTOR = '__scan_guard_test__'

let point: { id: string, number: number, subnet: string }

const running = async () => (await service.from('task_run').select('id,status,error,finished_at')
  .eq('kind', 'discovery-scan').eq('ref_id', point.id).eq('status', 'running')).data ?? []

// A scan that only ends when it is stopped (or after 10 s, so a broken test cannot hang).
const waitForStop = (_c: unknown, _p: string, _r: string, _o: unknown, signal?: AbortSignal) =>
  new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error('fake scan was never stopped')), 10_000)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
  })

async function closeRunning() {
  await service.from('task_run').update({ status: 'failed', error: 'test cleanup', finished_at: new Date().toISOString() })
    .eq('kind', 'discovery-scan').eq('ref_id', point.id).eq('status', 'running')
}

beforeAll(async () => {
  await service.from('points').delete().eq('number', POINT_NUMBER)
  const { data } = await service.from('points').insert({
    number: POINT_NUMBER, address: 'scan-guard-test', subnet: '198.51.100.0/24',
  }).select('id,number,subnet').single()
  point = data as typeof point
})

afterAll(async () => {
  await closeRunning()
  await service.from('task_run').delete().eq('actor', ACTOR)
  await service.from('task_run').delete().eq('ref_id', point.id)
  await service.from('points').delete().eq('id', point.id)
})

describe('one running discovery scan per point', () => {
  it('a second start while the first runs returns the same run and starts nothing', async () => {
    const started: string[] = []
    const run = (_c: unknown, runId: string) => { started.push(runId) }
    const a = await startPointScan(service, point, ACTOR, {}, run)
    const b = await startPointScan(service, point, ACTOR, {}, run)
    expect(b.executionId).toBe(a.executionId)
    expect(started).toEqual([a.executionId])
    expect(await running()).toHaveLength(1)
    await closeRunning()
  })

  it('two simultaneous inserts: the database keeps one, both callers get its id', async () => {
    const row = { kind: 'discovery-scan', actor: ACTOR, deviceId: null, refId: point.id, label: 'race', input: {} }
    const [a, b] = await Promise.all([insertRunning(service, row), insertRunning(service, row)])
    expect(b.id).toBe(a.id)
    expect(await running()).toHaveLength(1)
    await closeRunning()
  })

  it('the scheduled tick skips a point whose scan is running', async () => {
    await startPointScan(service, point, ACTOR, {}, () => {})
    await service.from('points').update({ scan_cadence_minutes: 60, next_scan_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', point.id)
    const ran: string[] = []
    await dispatchDueScans(service, new Date(), async (_c, _r, pid) => { ran.push(pid) })
    expect(ran).not.toContain(point.id)
    expect(await running()).toHaveLength(1)
    await service.from('points').update({ scan_cadence_minutes: null, next_scan_at: null }).eq('id', point.id)
    await closeRunning()
  })

  it('other kinds of runs on the same ref are not limited', async () => {
    const row = { kind: 'probe', actor: ACTOR, deviceId: null, refId: point.id, label: 'other', input: {} }
    const a = await insertRunning(service, row)
    const b = await insertRunning(service, row)
    expect(b.id).not.toBe(a.id)
  })
})

describe('stop', () => {
  it('ends the running scan as failed/stopped, and the point can be scanned again at once', async () => {
    const run = (c: typeof service, runId: string, pointId: string) => {
      void runAndFinish(c, runId, pointId, {}, waitForStop)
    }
    const { executionId } = await startPointScan(service, point, ACTOR, {}, run)
    expect(await stopPointScan(service, point.id)).toBe(true)
    await new Promise(r => setTimeout(r, 300))
    const { data } = await service.from('task_run').select('status,error,finished_at').eq('id', executionId).single()
    expect(data).toMatchObject({ status: 'failed', error: 'stopped' })
    expect(data?.finished_at).toBeTruthy()

    const again = await startPointScan(service, point, ACTOR, {}, () => {})
    expect(again.executionId).not.toBe(executionId)
    await closeRunning()
  })

  it('a running row this process does not own (orphan) is closed as stopped too', async () => {
    const orphan = await insertRunning(service, { kind: 'discovery-scan', actor: ACTOR, deviceId: null, refId: point.id, label: 'orphan', input: {} })
    expect(await stopPointScan(service, point.id)).toBe(true)
    const { data } = await service.from('task_run').select('status,error').eq('id', orphan.id).single()
    expect(data).toMatchObject({ status: 'failed', error: 'stopped' })
  })

  it('nothing running → false, nothing changed', async () => {
    expect(await stopPointScan(service, point.id)).toBe(false)
  })

  it('the stop route is admin-only and answers 404 when nothing runs', () => {
    const src = readFileSync(join(process.cwd(), 'server/api/discovery/[pointId]/stop.post.ts'), 'utf8')
    expect(src).toMatch(/requireRole\([\s\S]*?['"]admin['"]/)
    expect(src).toMatch(/statusCode: 404/)
  })
})
