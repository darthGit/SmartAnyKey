// Domain service: Tier-B internal probe.
// A probe is a client-authored device_command with purpose='probe', run over the
// SSH substrate (ADR-011 → command-runner.runCommand). Its stdout is hashed into
// the device's internal fingerprint (hash + last-raw). Domain-agnostic: what to
// read lives in the client's command body, NOT here (pilot data validates the
// engine). This service returns a result object and does NOT write the DB itself
// (3-Tier) — persistence + task_run live in the route.
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { writeProbeFingerprint } from '../repositories/devices'
import { finish } from '../repositories/task-runs'
import { type RunnableCommand, runCommand } from './command-runner'

// Fingerprint = deterministic digest of the (stable) probe output. Raw output is
// compared verbatim — volatile bytes (timestamps, counters) surface as instability.
export function fingerprintHash(stdout: string): string {
  return createHash('sha256').update(stdout).digest('hex')
}

export function isStable(a: string, b: string): boolean {
  return a === b
}

// Drift = the fresh hash differs from what we last stored. No prior hash (first
// probe of this device) → not drift, just the baseline.
export function detectDrift(previousHash: string | null | undefined, freshHash: string): boolean {
  return previousHash != null && previousHash !== freshHash
}

export interface ProbeCommand extends RunnableCommand {
  purpose: 'action' | 'probe'
  stable: boolean
}

export interface RunProbeOpts {
  device: { id: string, host: string, actions: string[] }
  command: ProbeCommand
  actor: string
  keyHex: string
  previousHash?: string | null // last stored fingerprint hash, for drift
}

export interface ProbeResult {
  status: 'done' | 'failed' | 'skipped'
  gate?: 'no-ssh' | 'no-cred'
  fingerprint?: { hash: string, raw: string }
  stable?: boolean
  drift?: boolean
  error?: string | null
}

// Gate: probe runs only for a purpose='probe' command, on a device
// that exposes SSH, and only if the SSH cred resolves (checked inside runCommand).
export async function runProbe(client: SupabaseClient, opts: RunProbeOpts): Promise<ProbeResult> {
  const { device, command, actor, keyHex } = opts

  if (command.purpose !== 'probe')
    throw createError({ statusCode: 400, statusMessage: 'not a probe command' })

  // Windows without SSH (or any device without the ssh action) → skip Tier-B,
  // Tier-A identity untouched. No cred touched, nothing run.
  if (!device.actions.includes('ssh'))
    return { status: 'skipped', gate: 'no-ssh' }

  const run = () => runCommand(client, { device, command, actor, keyHex })

  const r1 = await run()
  if (r1.status === 'failed')
    return { status: 'failed', gate: r1.error === 'auth' ? 'no-cred' : undefined, error: r1.error }

  // A stable-marked probe is run twice; identical output → fingerprint,
  // differing → not stored, flagged 'unstable'. (No host at save
  // time, so run-twice-diff happens here at execution.)
  if (command.stable) {
    const r2 = await run()
    if (r2.status === 'failed')
      return { status: 'failed', gate: r2.error === 'auth' ? 'no-cred' : undefined, error: r2.error }
    if (!isStable(r1.stdout, r2.stdout))
      return { status: 'done', stable: false, error: 'unstable' }
  }

  const raw = r1.stdout
  const hash = fingerprintHash(raw)
  return {
    status: 'done',
    fingerprint: { hash, raw },
    ...(command.stable ? { stable: true } : {}),
    drift: detectDrift(opts.previousHash, hash),
    error: null,
  }
}

// Detached runner (mirrors command-runner.runDetached, ADR-011): the controller
// inserts a running task_run and returns 202; here we run the probe, persist the
// fingerprint on success and finalize the task_run (audit). Not
// unit-tested — same as runDetached; the persistence tail is verified manually.
// ponytail: in-process; a crash leaves the row 'running' → reapStale on boot.
export function runProbeDetached(client: SupabaseClient, runId: string, opts: RunProbeOpts): void {
  runProbe(client, opts)
    .then(async (r) => {
      if (r.fingerprint)
        await writeProbeFingerprint(client, opts.device.id, r.fingerprint)
      await finish(client, runId, {
        status: r.status === 'failed' ? 'failed' : 'done',
        result: r.fingerprint
          ? { hash: r.fingerprint.hash, drift: r.drift ?? false, stable: r.stable ?? false }
          : { stable: r.stable ?? false },
        error: r.error ?? null,
      })
    })
    .catch(() => finish(client, runId, { status: 'failed', result: null, error: 'error' }).catch(() => {}))
}
