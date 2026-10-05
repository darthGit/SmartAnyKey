// Domain service: run a type's command on a device over SSH.
// runCommand — resolve('ssh') → wrap → execCommand → classification; does NOT write to
// the DB (persistence = controller/runDetached, 3-Tier). status='done' even on exit≠0
// (exit code = the result); 'failed' only for infra (action/auth/host/timeout).
import type { SupabaseClient } from '@supabase/supabase-js'
import { execCommand } from '../repositories/ssh'
import { resolveCredentials, resolveSetById } from './credentials'
import { finish } from '../repositories/task-runs'

// Delivering the body to the interpreter. base64-pipe: the body travels as data, not
// parsed by the shell — no quoting hell/injection from special characters. raw =
// the line as is (RouterOS CLI, sh one-liners).
export function wrap(interpreter: string, body: string): string {
  if (interpreter === 'raw')
    return body
  const bin = ({ bash: 'bash', python: 'python3', node: 'node' } as Record<string, string>)[interpreter] ?? 'sh'
  const b64 = Buffer.from(body).toString('base64')
  return `printf %s '${b64}' | base64 -d | ${bin}`
}

export interface RunnableCommand {
  id: string
  label: string
  body: string
  interpreter: string
  timeout_s: number
  // Phase 2: local-executor. target=ssh (default) — the existing SSH path; local —
  // the executor service. credRefs — sets injected into env as secrets.
  target?: 'ssh' | 'local'
  credRefs?: Array<{ set_id: string, env: string }>
}

export interface RunCommandOpts {
  device: { id: string, host: string, actions: string[], meta?: Record<string, unknown> | null }
  command: RunnableCommand
  actor: string
  keyHex: string
  // Phase 2: form values (params) + executor-service coordinates (the controller reads
  // URL+secret from runtimeConfig and passes them here, like keyHex).
  formValues?: Record<string, string>
  executor?: { url: string, secret: string }
}

export interface RunResult {
  status: 'done' | 'failed'
  exitCode: number | null
  stdout: string
  stderr: string
  error: string | null
  durationMs: number
}

const MAX_OUT = 4096 // output truncation in the audit (output may contain sensitive data)
const trunc = (s: string) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) : s)

export async function runCommand(client: SupabaseClient, opts: RunCommandOpts): Promise<RunResult> {
  const started = Date.now()
  const fail = (error: string): RunResult => ({
    status: 'failed', exitCode: null, stdout: '', stderr: '', error, durationMs: Date.now() - started,
  })

  if (!opts.device.actions.includes('ssh'))
    return fail('action')

  const cred = await resolveCredentials(client, opts.device.id, 'ssh', opts.keyHex, { actor: opts.actor })
  if (!cred)
    return fail('auth')

  // Variables (params/meta/creds) are injected into the environment on SSH targets too — but only
  // for structured interpreters (bash/python/node). `raw` stays
  // verbatim (RouterOS/CLI one-liners — `export` there would break the syntax).
  const structured = opts.command.interpreter !== 'raw'
  const { env, secretVals } = structured
    ? await resolveTaskEnv(client, opts)
    : { env: {} as Record<string, string>, secretVals: [] as string[] }
  const command = (structured ? exportEnv(env) : '') + wrap(opts.command.interpreter, opts.command.body)

  try {
    const { stdout, stderr, code } = await execCommand({
      host: opts.device.host,
      port: cred.port ?? 22,
      username: cred.username ?? '',
      password: cred.password ?? '',
      command,
      timeoutMs: opts.command.timeout_s * 1000,
    })
    return {
      status: 'done',
      exitCode: code,
      stdout: trunc(maskSecrets(stdout, secretVals)),
      stderr: trunc(maskSecrets(stderr, secretVals)),
      error: null,
      durationMs: Date.now() - started,
    }
  }
  catch (err) {
    const e = err as { timedOut?: boolean, level?: string }
    if (e?.timedOut)
      return fail('timeout')
    if (e?.level === 'client-authentication')
      return fail('auth')
    return fail('host')
  }
}

// --- Phase 2: local-executor -------------------------------------------------

// One interpolation, several sources: device columns (DEVICE_*) + free-form
// device.meta (keys verbatim) + resolved secrets + form values. The later
// spread wins: form/secrets over meta. Pure — tested without a DB.
export function buildEnv(input: {
  device: { id: string, host: string, meta?: Record<string, unknown> | null }
  secrets: Record<string, string>
  formValues?: Record<string, string>
}): Record<string, string> {
  const metaEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.device.meta ?? {}))
    metaEnv[k] = v == null ? '' : String(v)
  return {
    DEVICE_ID: input.device.id,
    DEVICE_HOST: input.device.host,
    ...metaEnv,
    ...input.secrets,
    ...(input.formValues ?? {}),
  }
}

// Output is a separate leak channel: an admin task with `echo $KEY`
// would leak the injected secret to the operator. We mask verbatim occurrences before
// returning and writing to task_run. ponytail: literal mask; a transformed
// secret slips through — for sensitive commands the admin raises min_role.
export function maskSecrets(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) {
    if (!s)
      continue
    out = out.split(s).join('[REDACTED]')
  }
  return out
}

// Shared task-environment resolution for both targets (ssh + local). A set =
// login+password(+port): one cred ref → env variables with the `env` prefix
// (`PREFIX_USER`/`PREFIX_PASSWORD`/`PREFIX_PORT`). Plus device columns + meta +
// formValues (via buildEnv). secretVals — password(s) for output masking
// (login/port are not secret; output is a separate leak channel).
async function resolveTaskEnv(client: SupabaseClient, opts: RunCommandOpts): Promise<{ env: Record<string, string>, secretVals: string[] }> {
  const secrets: Record<string, string> = {}
  const secretVals: string[] = []
  for (const ref of opts.command.credRefs ?? []) {
    const set = await resolveSetById(client, ref.set_id, opts.keyHex, { actor: opts.actor, deviceId: opts.device.id })
    if (!set)
      continue
    if (set.username != null)
      secrets[`${ref.env}_USER`] = set.username
    secrets[`${ref.env}_PASSWORD`] = set.password
    if (set.port != null)
      secrets[`${ref.env}_PORT`] = String(set.port)
    secretVals.push(set.password)
  }
  return { env: buildEnv({ device: opts.device, secrets, formValues: opts.formValues }), secretVals }
}

// Env injection into the remote shell (SSH): valid shell identifiers → `export`
// before the body (values in single quotes, escaped). Invalid keys (e.g. a
// meta key with a space) are skipped — better no variable than a broken command.
function exportEnv(env: Record<string, string>): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const lines = Object.entries(env)
    .filter(([k]) => /^[A-Za-z_]\w*$/.test(k))
    .map(([k, v]) => `export ${k}=${q(v)}`)
  return lines.length ? `${lines.join('\n')}\n` : ''
}

// Sibling beyond ADR-011 seam #3: the same RunResult as runCommand, but the
// target is the isolated executor service (internal HTTP + shared secret), not SSH.
export async function runLocal(client: SupabaseClient, opts: RunCommandOpts): Promise<RunResult> {
  const started = Date.now()
  const fail = (error: string): RunResult => ({
    status: 'failed', exitCode: null, stdout: '', stderr: '', error, durationMs: Date.now() - started,
  })

  if (!opts.executor)
    return fail('executor')

  const { env, secretVals } = await resolveTaskEnv(client, opts)

  try {
    const resp = await fetch(opts.executor.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-executor-secret': opts.executor.secret },
      body: JSON.stringify({
        interpreter: opts.command.interpreter,
        body: opts.command.body,
        env,
        timeoutMs: opts.command.timeout_s * 1000,
      }),
    })
    if (!resp.ok)
      return fail('executor')
    const out = await resp.json() as { stdout?: string, stderr?: string, exit?: number | null, timedOut?: boolean }
    if (out.timedOut)
      return fail('timeout')
    return {
      status: 'done',
      exitCode: out.exit ?? null,
      stdout: trunc(maskSecrets(out.stdout ?? '', secretVals)),
      stderr: trunc(maskSecrets(out.stderr ?? '', secretVals)),
      error: null,
      durationMs: Date.now() - started,
    }
  }
  catch {
    return fail('executor')
  }
}

// Seam #2: detached run. The controller inserts a running row and calls this,
// returning 202 right away; here we execute and finalise the task_run row. Dispatch by
// target: local → executor service, otherwise SSH.
// ponytail: in-process, no Redis/BullMQ — that queue is Phase 3; a restart leaves orphans,
// reapStale cleans them up on boot.
export function runDetached(client: SupabaseClient, runId: string, opts: RunCommandOpts): void {
  const exec = opts.command.target === 'local' ? runLocal(client, opts) : runCommand(client, opts)
  exec
    .then(r => finish(client, runId, {
      status: r.status,
      result: { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, durationMs: r.durationMs },
      error: r.error,
    }))
    .catch(() => finish(client, runId, { status: 'failed', result: null, error: 'error' }).catch(() => {}))
}
