// RED (Tier-B internal probe).
// Probe = client-authored command with purpose='probe', run through the ssh
// substrate (ADR-011 runCommand), output hashed → device fingerprint. Domain-
// agnostic: hashing is generic over stdout, the "what to read" is the CLIENT's
// command body — fixtures use neutral strings, never a hardcoded machine-id.
//
// 3-Tier: the service returns a result object and
// does NOT write the DB itself; ssh repo + resolveCredentials are mocked,
// exactly as tests/unit/command-runner.spec.ts does.
//
// Module server/services/probe.ts does NOT exist yet → this suite fails (RED).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  detectDrift,
  fingerprintHash,
  isStable,
  runProbe,
} from '../../server/services/probe'

// runProbe reuses command-runner.runCommand for the SSH exec; mock it so the
// probe orchestration (gate → run(-twice) → hash → drift) is tested in isolation.
const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }))
vi.mock('../../server/services/command-runner', () => ({ runCommand }))

const client = {} as never
const keyHex = 'k'
const actor = 'tech@example.com'

// A neutral, stable-ish probe output — deliberately NOT domain-specific.
const OUT_A = 'id=abc123def456\n'
const OUT_B = 'id=zzz999\n'

const probeCmd = {
  id: 'cmd-probe-1',
  label: 'machine id',
  body: 'cat /etc/machine-id',
  interpreter: 'raw',
  timeout_s: 10,
  purpose: 'probe' as const,
  stable: true,
}

const sshDevice = { id: 'dev-1', host: '10.0.0.5', actions: ['ssh'] }
const winDevice = { id: 'dev-win', host: '10.0.0.9', actions: ['vnc', 'rdp'] } // no ssh

const doneRun = (stdout: string) => ({
  status: 'done' as const, exitCode: 0, stdout, stderr: '', error: null, durationMs: 5,
})

beforeEach(() => {
  runCommand.mockReset()
  runCommand.mockResolvedValue(doneRun(OUT_A))
})

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('fingerprintHash (AC-3)', () => {
  it('is a deterministic hex digest of the output', () => {
    const h = fingerprintHash(OUT_A)
    expect(h).toMatch(/^[0-9a-f]{64}$/) // sha256 hex
    expect(fingerprintHash(OUT_A)).toBe(h) // deterministic
    expect(fingerprintHash(OUT_B)).not.toBe(h) // different output → different hash
  })
})

describe('isStable / detectDrift (AC-2, AC-4)', () => {
  it('isStable: identical outputs → true, differing → false', () => {
    expect(isStable(OUT_A, OUT_A)).toBe(true)
    expect(isStable(OUT_A, OUT_B)).toBe(false)
  })

  it('detectDrift: hash change between runs → true, same → false', () => {
    const h = fingerprintHash(OUT_A)
    expect(detectDrift(h, fingerprintHash(OUT_A))).toBe(false)
    expect(detectDrift(h, fingerprintHash(OUT_B))).toBe(true)
  })
})

// ── Orchestration ───────────────────────────────────────────────────────────

describe('runProbe (AC-1 gate)', () => {
  it('AC-1: SSH device + resolvable cred + purpose=probe → runs, returns fingerprint', async () => {
    const res = await runProbe(client, { device: sshDevice, command: probeCmd, actor, keyHex })
    expect(runCommand).toHaveBeenCalled()
    expect(res.status).toBe('done')
    expect(res.fingerprint?.hash).toBe(fingerprintHash(OUT_A))
    expect(res.fingerprint?.raw).toBe(OUT_A)
  })

  it('AC-1: a non-probe command is rejected (purpose gate)', async () => {
    const action = { ...probeCmd, purpose: 'action' as const }
    await expect(runProbe(client, { device: sshDevice, command: action, actor, keyHex })).rejects.toThrow()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('AC-1: no resolvable cred → runCommand reports auth-fail → no fingerprint stored', async () => {
    runCommand.mockResolvedValue({ status: 'failed', exitCode: null, stdout: '', stderr: '', error: 'auth', durationMs: 1 })
    const res = await runProbe(client, { device: sshDevice, command: probeCmd, actor, keyHex })
    expect(res.status).toBe('failed')
    expect(res.fingerprint).toBeUndefined()
  })
})

describe('runProbe stability guard (AC-2)', () => {
  it('AC-2: stable command run twice, identical output → stored as fingerprint', async () => {
    runCommand.mockResolvedValueOnce(doneRun(OUT_A)).mockResolvedValueOnce(doneRun(OUT_A))
    const res = await runProbe(client, { device: sshDevice, command: probeCmd, actor, keyHex })
    expect(runCommand).toHaveBeenCalledTimes(2) // stable → run twice
    expect(res.stable).toBe(true)
    expect(res.fingerprint?.hash).toBe(fingerprintHash(OUT_A))
  })

  it('AC-2: stable command, differing output on the two runs → unstable, no fingerprint', async () => {
    runCommand.mockResolvedValueOnce(doneRun(OUT_A)).mockResolvedValueOnce(doneRun(OUT_B))
    const res = await runProbe(client, { device: sshDevice, command: probeCmd, actor, keyHex })
    expect(res.stable).toBe(false)
    expect(res.error).toBe('unstable')
    expect(res.fingerprint).toBeUndefined()
  })

  it('AC-2: non-stable command runs once (no run-twice-diff)', async () => {
    const res = await runProbe(client, { device: sshDevice, command: { ...probeCmd, stable: false }, actor, keyHex })
    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(res.fingerprint?.hash).toBe(fingerprintHash(OUT_A))
  })
})

describe('runProbe drift (AC-4)', () => {
  it('AC-4: fresh hash differs from previous stored hash → drift flagged', async () => {
    runCommand.mockResolvedValue(doneRun(OUT_B))
    const res = await runProbe(client, {
      device: sshDevice, command: { ...probeCmd, stable: false }, actor, keyHex,
      previousHash: fingerprintHash(OUT_A),
    })
    expect(res.drift).toBe(true)
  })

  it('AC-4: fresh hash equals previous → no drift', async () => {
    const res = await runProbe(client, {
      device: sshDevice, command: { ...probeCmd, stable: false }, actor, keyHex,
      previousHash: fingerprintHash(OUT_A),
    })
    expect(res.drift).toBe(false)
  })
})

describe('runProbe audit (AC-5)', () => {
  it('AC-5: probe exec goes through runCommand with the actor (→ task_run + credential_access_log)', async () => {
    await runProbe(client, { device: sshDevice, command: { ...probeCmd, stable: false }, actor, keyHex })
    // runCommand carries actor → resolveCredentials logs credential_access_log,
    // and the probe run is persisted as a task_run(kind='probe') by the caller.
    expect(runCommand).toHaveBeenCalledWith(client, expect.objectContaining({ actor }))
  })
})

describe('runProbe Windows-without-SSH (AC-6)', () => {
  it('AC-6: device without ssh action → skipped, runCommand not called, no fingerprint', async () => {
    const res = await runProbe(client, { device: winDevice, command: probeCmd, actor, keyHex })
    expect(res.status).toBe('skipped')
    expect(res.gate).toBe('no-ssh')
    expect(runCommand).not.toHaveBeenCalled()
    expect(res.fingerprint).toBeUndefined()
  })
})
