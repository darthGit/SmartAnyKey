// Domain service: read the name from the machine itself over
// SSH. Transport — the existing ADR-011 substrate (`runCommand` → per-action credential resolve
// → audit as is); zero new machinery.
//
// Boundary with ADR-014: this is NOT a probe. Probe = client-authored `device_commands` with
// `purpose='probe'` (the client knows what to read on its device). Here — a fixed
// `hostname`, present in every OS, so it adds no domain assumption (no domain defaults):
// it creates no `device_commands` row, is not hashed, does not touch `probe_fp_*`.
import type { SupabaseClient } from '@supabase/supabase-js'
import { runCommand, type RunnableCommand } from './command-runner'
import { updateDeviceHostname } from '../repositories/discovered'
import { pickHostname, type HostnameFact } from './discovery'

// `raw` — the string goes verbatim (no base64 wrapper), since it is one built-in binary;
// a bash/python wrap would add nothing here.
const HOSTNAME_CMD: RunnableCommand = {
  id: 'builtin-hostname',
  label: 'hostname',
  body: 'hostname',
  interpreter: 'raw',
  timeout_s: 15,
  target: 'ssh',
}

// Validation at the trust boundary: accept only what looks like a hostname —
// the first non-empty output line, an RFC-1123-like character set. Anything else
// (a banner, an error, several lines of garbage) → null, no fact written.
// ponytail: we take the first matching line; if an OS turns up that prints a banner
// before the name, we will have to take the last — we change it then.
const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/

export function parseHostnameOutput(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const v = line.trim().replace(/\.$/, '')
    if (v && HOSTNAME_RE.test(v))
      return v
  }
  return null
}

export interface CheckHostnameOpts {
  device: { id: string, host: string, actions: string[], meta?: Record<string, unknown> | null }
  current: HostnameFact | null
  actor: string
  keyHex: string
}

export type CheckHostnameResult =
  | { status: 'ok', fact: HostnameFact, applied: boolean }
  | { status: 'failed', error: string }

// The `ssh` rank is the highest, so the result always overwrites nse/ptr; the reverse
// overwrite will not happen — `pickHostname` will not let a weaker source through.
export async function checkHostname(client: SupabaseClient, opts: CheckHostnameOpts): Promise<CheckHostnameResult> {
  const res = await runCommand(client, {
    device: opts.device,
    command: HOSTNAME_CMD,
    actor: opts.actor,
    keyHex: opts.keyHex,
  })
  if (res.status === 'failed')
    return { status: 'failed', error: res.error ?? 'error' }

  const value = parseHostnameOutput(res.stdout)
  if (!value)
    return { status: 'failed', error: 'unreadable' }

  const fact: HostnameFact = { value, source: 'ssh', at: new Date().toISOString() }
  const winner = pickHostname(opts.current, fact)
  const applied = winner === fact
  if (applied)
    await updateDeviceHostname(client, opts.device.id, fact)
  return { status: 'ok', fact: winner ?? fact, applied }
}
