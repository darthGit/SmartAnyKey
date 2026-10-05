// Tier-B probe integration — the persistence tail (service logic = unit
// tests/discovery/tier-b.spec.ts). Live run against testbox: a deterministic
// echo probe (stable by construction — output does not change between runs) over
// real SSH → hash → fingerprint written to devices + task_run(kind='probe') +
// credential_access_log. Precondition: stack up, migrations 0010 applied,
// device «Testbox SSH» with an ssh credential.
import { afterAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { getDeviceForConnection, readProbeHash, writeProbeFingerprint } from '../../server/repositories/devices'
import { finish, insertRunning } from '../../server/repositories/task-runs'
import { fingerprintHash, runProbe } from '../../server/services/probe'

const service = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const KEY = process.env.NUXT_CRED_ENCRYPTION_KEY!
const ACTOR = '__tier_b_test__'

// The testbox address depends on where the process that opens SSH runs: the BFF
// itself speaks ssh (ssh2 in-process), so in the container it is `testbox`, from the host
// `127.0.0.1:2222`. The test runs on the host, so it takes the host address, not the
// device field: otherwise it fails whenever the row is set up for in-compose
// (measured 2026-09-17, when the device was switched to `testbox`).
// Credentials still resolve as usual — by device id, not by address.
const SSH_HOST = process.env.TEST_SSH_HOST ?? '127.0.0.1'

const probeCmd = {
  id: '00000000-0000-0000-0000-000000000000',
  label: 'tier-b fixture',
  body: 'echo tier-b-fixture',
  interpreter: 'raw',
  timeout_s: 15,
  purpose: 'probe' as const,
  stable: true,
}

async function testboxId() {
  const { data } = await service.from('devices').select('id').eq('label', 'Testbox SSH').single()
  return data!.id as string
}

afterAll(async () => {
  const id = await testboxId()
  await service.from('devices').update({ probe_fp_hash: null, probe_fp_raw: null, probe_fp_at: null }).eq('id', id)
  await service.from('task_run').delete().eq('actor', ACTOR)
  await service.from('credential_access_log').delete().eq('actor', ACTOR)
})

describe('Tier-B probe persistence (AC-3/AC-5 live)', () => {
  it('AC-3/AC-5: probe over real SSH → fingerprint on devices + task_run(kind=probe) + audit log', async () => {
    const deviceId = await testboxId()
    const device = await getDeviceForConnection(service, deviceId)
    expect(device!.actions).toContain('ssh') // gate precondition

    const run = await insertRunning(service, {
      kind: 'probe', actor: ACTOR, deviceId, refId: null, label: probeCmd.label,
      input: { body: probeCmd.body, interpreter: probeCmd.interpreter },
    })

    const previousHash = await readProbeHash(service, deviceId)
    const r = await runProbe(service, {
      device: { id: device!.id, host: SSH_HOST, actions: device!.actions },
      command: probeCmd, actor: ACTOR, keyHex: KEY, previousHash,
    })
    if (r.fingerprint)
      await writeProbeFingerprint(service, deviceId, r.fingerprint)
    await finish(service, run.id, {
      status: r.status === 'failed' ? 'failed' : 'done',
      result: r.fingerprint ? { hash: r.fingerprint.hash } : {},
      error: r.error ?? null,
    })

    // Probe succeeded, stable (echo is reproducible), fingerprint computed.
    expect(r.status).toBe('done')
    expect(r.stable).toBe(true)
    expect(r.fingerprint!.hash).toBe(fingerprintHash(r.fingerprint!.raw))
    expect(r.fingerprint!.raw).toContain('tier-b-fixture')

    // Persist: devices row carries the fingerprint.
    const { data: dev } = await service.from('devices')
      .select('probe_fp_hash, probe_fp_raw, probe_fp_at').eq('id', deviceId).single()
    expect(dev!.probe_fp_hash).toBe(r.fingerprint!.hash)
    expect(dev!.probe_fp_raw).toContain('tier-b-fixture')
    expect(dev!.probe_fp_at).toBeTruthy()

    // Persist: task_run(kind='probe') finalized + credential_access_log resolve row.
    const { data: tr } = await service.from('task_run').select('kind, status').eq('id', run.id).single()
    expect(tr!.kind).toBe('probe')
    expect(tr!.status).toBe('done')
    const { data: logs } = await service.from('credential_access_log')
      .select('action').eq('actor', ACTOR).eq('device_id', deviceId)
    expect(logs!.length).toBeGreaterThanOrEqual(1)
    expect(logs![0].action).toBe('resolve')
  })
})
