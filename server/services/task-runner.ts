// Task executor. A task is an entity without a device: it is routed to a runner
// by `runtime`, gets its environment from its own deps and secrets via
// `credential_sets` (ADR-009 amendment — resolve-by-id).
//
// Here — the pure parts (validation, env assembly, masking, routing).
// Run orchestration (`runTask`) comes together with the tasks repository.
//
// Masking reuses `maskSecrets` from command-runner (same contract, zero
// duplication) and covers three channels: stdout, stderr and `task_run.log` — the
// log is also written to the DB, so an unmasked secret is just as visible to the
// operator there (list every channel of observation).
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { resolveBuiltin, runBuiltinScript } from './task-builtins'
import { maskSecrets } from './command-runner'
import { resolveSetById } from './credentials'
import { nextAttemptDelayMs } from './task-scheduler'
import type { TaskRow } from '../repositories/tasks'
import { hasRunningRun } from '../repositories/tasks'
import { saveArtifacts } from '../repositories/task-artifacts'
import { appendLog, finish, insertRunning, insertSkipped, setPhase } from '../repositories/task-runs'

/**
 * Deployment runner registry: `runtime` → URL of the service that can run it
 * (amended 2026-08-13). The list is installation data (`NUXT_TASK_RUNNERS`),
 * not a constant in code: `python313` or **`ansible`** = a line in config + an
 * image with its own `recipes.json`, zero changes here (deployment-specific).
 *
 * Today several runtimes may point at one URL (one image carries
 * python+node); tomorrow — at different ones. The code does not see the difference.
 */
export type RunnerRegistry = Record<string, string>

/**
 * Parses `NUXT_TASK_RUNNERS`. Empty = no runner configured.
 *
 * Accepts both a string and an object: Nuxt passes env values through `destr`, so
 * a JSON string in `.env` arrives in `runtimeConfig` **already parsed as an object**
 * (found by a live run 2026-08-13 — unit tests passed only a string and did not
 * catch it). A string stays a valid input: tests and direct calls.
 */
export function parseRunnerRegistry(raw: string | Record<string, unknown> | undefined | null): RunnerRegistry {
  if (raw === null || raw === undefined)
    return {}
  if (typeof raw === 'string' && !raw.trim())
    return {}
  let parsed: unknown
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    }
    catch {
      throw new Error('NUXT_TASK_RUNNERS: invalid JSON (expected {"runtime":"url"})')
    }
  }
  else {
    parsed = raw
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('NUXT_TASK_RUNNERS: expected an object {"runtime":"url"}')

  const out: RunnerRegistry = {}
  for (const [runtime, url] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof url !== 'string' || !url)
      throw new Error(`NUXT_TASK_RUNNERS: empty URL for runtime "${runtime}"`)
    out[runtime] = url
  }
  return out
}

const jsonRecord = z.record(z.string(), z.unknown())

// Task fields without defaults — one declaration for two schemas (create and patch).
// Defaults live only in create: `.partial()` does NOT cancel `.default()` (verified
// on zod 4), so a patch built from defaulted fields would add `deps:''`/`env:{}`
// to every PATCH and wipe them on the `enabled` toggle.
const taskFields = {
  name: z.string().min(1).max(120),
  runtime: z.string().min(1).max(60),
  entrypoint: z.string().min(1).max(200),
  files: z.record(z.string(), z.string()),
  deps: z.string(),
  deps_lock: z.string(),
  env: jsonRecord,
  cred_refs: z.array(z.object({ set_id: z.string().uuid(), env: z.string().min(1) })),
  timeout_s: z.number().int().positive().max(86_400),
  retries: z.number().int().min(0).max(10),
  backoff_s: z.number().int().min(0).max(3600),
  overlap_policy: z.enum(['skip', 'queue']),
  min_role: z.enum(['operator', 'admin']),
  enabled: z.boolean(),
  // Result sink (tier Full). Empty string = do not notify, hence not
  // `.url()` on the whole field, but a check of a non-empty value only.
  sink_url: z.string().max(500).refine(v => v === '' || /^https?:\/\//.test(v), {
    message: 'sink_url: expected an http(s) URL or empty',
  }),
  sink_on: z.enum(['failed', 'always']),
}

const baseTaskSchema = z.object({
  ...taskFields,
  // Optional on create — "a task without dependencies" is a normal case.
  deps: taskFields.deps.default(''),
  deps_lock: taskFields.deps_lock.default(''),
  env: taskFields.env.default({}),
  cred_refs: taskFields.cred_refs.default([]),
  sink_url: taskFields.sink_url.default(''),
  sink_on: taskFields.sink_on.default('failed'),
})

const knownRuntime = (runtimes: string[]) => ({
  message: `runtime: no such runner (configured: ${runtimes.join(', ') || 'none'})`,
  path: ['runtime'] as const,
})

/**
 * Task definition schema. `runtimes` — the list of configured runtimes
 * (registry keys): a task with a runtime this installation lacks is not
 * saved, but the list itself is not hardcoded.
 */
export function makeTaskSchema(runtimes: string[]) {
  return baseTaskSchema
    // Mirrors the CHECKs of migration 0015: a task without files or with an entrypoint
    // outside them cannot run. Validated at the BFF boundary so the client gets 400,
    // not 500 from Postgres.
    .refine(t => Object.keys(t.files).length > 0, {
      message: 'files: a task must have at least one file',
      path: ['files'],
    })
    .refine(t => t.entrypoint in t.files, {
      message: 'entrypoint: must be among files',
      path: ['entrypoint'],
    })
    .refine(t => runtimes.includes(t.runtime), knownRuntime(runtimes))
}

/**
 * Definition patch: any subset of fields and no extra key in the output
 * (otherwise the `enabled` toggle would rewrite the task body).
 * The "entrypoint among files" invariant is checked only when the patch has both
 * halves; a partial change is caught by the CHECK in 0015 → `updateTask` maps 23514 to 400.
 * `makeTaskSchema(...).partial()` is impossible here: zod 4 forbids `.partial()`
 * on an object with refinements (failed with 500 on every edit).
 */
export function makeTaskPatchSchema(runtimes: string[]) {
  return z.object(taskFields).partial()
    .refine(t => t.files === undefined || Object.keys(t.files).length > 0, {
      message: 'files: a task must have at least one file',
      path: ['files'],
    })
    .refine(t => t.entrypoint === undefined || t.files === undefined || t.entrypoint in t.files, {
      message: 'entrypoint: must be among files',
      path: ['entrypoint'],
    })
    .refine(t => t.runtime === undefined || runtimes.includes(t.runtime), knownRuntime(runtimes))
}

export type TaskInput = z.infer<typeof baseTaskSchema>

/** Decrypted set from `credential_sets` (ADR-009): login+password+port. */
export interface ResolvedSet {
  username: string | null
  password: string | null
  port: number | null
}

export interface BuildEnvOpts {
  task: Pick<TaskInput, 'env'>
  /** env prefix from `cred_refs` → decrypted set. */
  secrets: Record<string, ResolvedSet>
  /**
   * A small webhook payload is duplicated into env.
   * `RUN_PAYLOAD_FILE` and `RUN_OUTPUT` are NOT set here: only the runner knows the
   * per-job dir and injects them itself — otherwise concurrent runs would share one
   * dir. The BFF passes the payload content as a separate request field, not a path.
   */
  payloadInline?: string
  /** Webhook call query parameters → `RUN_QUERY` (JSON). Empty — not injected. */
  query?: Record<string, string> | null
}

export function buildTaskEnv(opts: BuildEnvOpts): Record<string, string> {
  const env: Record<string, string> = {}

  // Non-secret task variables — verbatim.
  for (const [k, v] of Object.entries(opts.task.env ?? {}))
    env[k] = v === null || v === undefined ? '' : String(v)

  // A set expands to PREFIX_USER / PREFIX_PASSWORD / PREFIX_PORT;
  // empty fields are NOT injected (ADR-009 amendment 2026-07-21).
  for (const [prefix, set] of Object.entries(opts.secrets ?? {})) {
    if (set?.username)
      env[`${prefix}_USER`] = set.username
    if (set?.password)
      env[`${prefix}_PASSWORD`] = set.password
    if (set?.port !== null && set?.port !== undefined)
      env[`${prefix}_PORT`] = String(set.port)
  }

  if (opts.payloadInline !== undefined)
    env.RUN_PAYLOAD = opts.payloadInline

  // The call query goes as a separate variable, not mixed into the payload: for the sink
  // the body is our summary, and the query is the task author's metadata; mixing them
  // would spoil both. An empty query is not injected at all.
  if (opts.query && Object.keys(opts.query).length)
    env.RUN_QUERY = JSON.stringify(opts.query)

  // No DEVICE_* — a task is not bound to a device. This is not "forgot to
  // add" but the point: `device_commands.type_id not null` was the reason.
  return env
}

export interface RunChannels {
  stdout: string
  stderr: string
  log: string
}

/**
 * Masks secrets in all three channels the actor sees/stores.
 * Login and port are not masked — they are not secret (ADR-009 amendment).
 */
export function maskRun(channels: RunChannels, secrets: string[]): RunChannels {
  return {
    stdout: maskSecrets(channels.stdout, secrets),
    stderr: maskSecrets(channels.stderr, secrets),
    log: maskSecrets(channels.log, secrets),
  }
}

/**
 * Routing to a runner by runtime — a registry lookup, not a `switch`.
 * Unknown runtime → an error listing the configured ones, not a silent fallback to
 * the first runner (otherwise the task would run on something other than asked).
 */
export function runnerUrl(runtime: string, registry: RunnerRegistry): string {
  const url = registry[runtime]
  if (!url) {
    const known = Object.keys(registry).join(', ') || 'none'
    throw new Error(`task-runner: runtime "${runtime}" is not configured (available: ${known})`)
  }
  return url
}

// --- task run ------------------------------------------------------------------

/** Runner NDJSON stream event (`POST /run-task`). */
interface RunnerEvent {
  type: 'phase' | 'log' | 'end'
  phase?: string
  stream?: 'stdout' | 'stderr'
  data?: string
  exit?: number | null
  timedOut?: boolean
  envKey?: string | null
  preparedEnv?: boolean
  durationMs?: number
  stdout?: string
  stderr?: string
  artifacts?: { path: string, size: number, contentType?: string, b64: string }[]
  skippedArtifacts?: { path: string, size: number, reason: string }[]
  error?: string
}

export interface RunnersConfig {
  registry: RunnerRegistry
  secret: string
}

export interface RunTaskOpts {
  task: TaskRow
  actor: string
  keyHex: string
  runners: RunnersConfig
  /** Forced environment reinstall with unchanged `deps`. */
  rebuildEnv?: boolean
  /** Webhook payload (raw string) — the runner writes it to a file. */
  payload?: string | null
  /**
   * Webhook call query parameters → to the task as `RUN_QUERY` (JSON string).
   * This is the channel for caller data that is not in the body: one shared notifier
   * learns "which chat to write to" from `?chat=-100…` in its own URL instead of
   * keeping a task→chat mapping in its own code. The payload body is NOT
   * mutated — it belongs to whoever sent it.
   */
  query?: Record<string, string> | null
  /** Webhook idempotency key. */
  idempotencyKey?: string | null
  /** Run started late after downtime — visible in the panel. */
  late?: boolean
  lateByMs?: number
  /**
   * Called right after the run row is saved. Needed by the async webhook:
   * `202` may be returned only after persist, not "on receipt" — and without
   * duplicating row creation outside runTask.
   */
  onStarted?: (runId: string) => void
}

export interface RunTaskResult {
  runId: string
  status: 'done' | 'failed' | 'skipped'
  /**
   * Structured result the task wrote to `$RUN_DATA_FILE`
   * (`null` if it did not). This is the sender's channel: here task A puts
   * fields for task B — separate from our summary, which it does not control.
   */
  data?: Record<string, unknown> | null
  exitCode: number | null
  stdout: string
  stderr: string
  error: string | null
  phases: { phase: string }[]
  envKey: string | null
  attempt: number
  artifacts: { path: string, size: number }[]
}

/** A small payload is duplicated into env; a larger one — file only. */
const PAYLOAD_INLINE_MAX = 4096
/**
 * How often to flush the log tail to the DB during a run. ponytail: 1s is a
 * compromise between "the log grows live" and Postgres traffic; one UPDATE per
 * line would bring the DB down on a chatty task.
 */
const LOG_FLUSH_MS = 1000
/** The result sink must not hold up the run — a short ceiling on the POST. */
const SINK_TIMEOUT_MS = 10_000

/** Decrypts `cred_refs` into an env prefix → set map (ADR-009 amendment). */
async function resolveTaskSecrets(
  client: SupabaseClient,
  task: TaskRow,
  actor: string,
  keyHex: string,
): Promise<Record<string, ResolvedSet>> {
  const out: Record<string, ResolvedSet> = {}
  for (const ref of task.cred_refs ?? []) {
    // deviceId=null: the task is not about a device, but access audit stays (ADR-009).
    const set = await resolveSetById(client, ref.set_id, keyHex, { actor, deviceId: null })
    if (set)
      out[ref.env] = set
  }
  return out
}

/** One HTTP run on a runner, parsing the NDJSON stream. */
async function callRunner(
  url: string,
  secret: string,
  body: Record<string, unknown>,
  onEvent: (e: RunnerEvent) => void,
): Promise<RunnerEvent> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-executor-secret': secret },
    body: JSON.stringify(body),
  })
  if (!resp.ok || !resp.body)
    throw new Error(`runner ${resp.status}: ${await resp.text().catch(() => '')}`)

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let final: RunnerEvent | null = null

  const handle = (line: string) => {
    if (!line.trim())
      return
    let event: RunnerEvent
    try {
      event = JSON.parse(line) as RunnerEvent
    }
    catch {
      return // a broken stream line must not fail the run
    }
    if (event.type === 'end')
      final = event
    onEvent(event)
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      break
    buffer += decoder.decode(value, { stream: true })
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      handle(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
    }
  }
  handle(buffer)

  if (!final)
    throw new Error('runner: the stream ended without a final event')
  return final
}

/** One attempt: a `task_run` row + runner call + finalisation. */
async function runAttempt(
  client: SupabaseClient,
  opts: RunTaskOpts,
  attempt: number,
  secrets: Record<string, ResolvedSet>,
  secretValues: string[],
): Promise<RunTaskResult> {
  const { task } = opts
  // A built-in action (ADR-018 amendment #4) does not go to a runner, so the registry
  // is not consulted at all: an empty `NUXT_TASK_RUNNERS` must not break the backup.
  const url = task.builtin ? '' : runnerUrl(task.runtime, opts.runners.registry)

  const run = await insertRunning(client, {
    kind: 'task',
    actor: opts.actor,
    deviceId: null, // a task runs without a device
    refId: null,
    label: task.name,
    // Snapshot without secrets and without env values: what ran — yes,
    // with which values — no.
    input: {
      runtime: task.runtime,
      entrypoint: task.entrypoint,
      files: Object.keys(task.files ?? {}),
      deps: task.deps,
      payload: opts.payload ?? null,
      // Query snapshot: a re-run must go with the same `?chat=…`, otherwise
      // "repeat" would send the message to the wrong place.
      query: opts.query ?? null,
      late: opts.late ?? false,
      lateByMs: opts.lateByMs ?? 0,
    },
    taskId: task.id,
    attempt,
    idempotencyKey: opts.idempotencyKey ?? null,
  })
  opts.onStarted?.(run.id)

  const phases: { phase: string }[] = []
  let pending = ''
  let lastFlush = 0
  // Log writes go as a chain, not in parallel: `appendLog` is a
  // read-modify-write, so two concurrent writes lose each other. On a runner
  // this hid behind a slow stream; on a built-in action (all in milliseconds)
  // the final flush overwrote the first line — measured 2026-09-17 on backup:
  // `log` kept the tail without the line "✓ <file> (0.3 MB…)".
  let chain: Promise<void> = Promise.resolve()
  const flush = (force = false): Promise<void> => {
    if (!pending)
      return chain
    if (!force && Date.now() - lastFlush < LOG_FLUSH_MS)
      return chain
    const chunk = maskSecrets(pending, secretValues)
    pending = ''
    lastFlush = Date.now()
    chain = chain
      .then(() => appendLog(client, run.id, chunk))
      // The log is a convenience, not the run contract: a failed tail write must not
      // fail the task, but must not vanish silently either.
      .catch(e => console.warn(`[task-runner] log flush: ${e instanceof Error ? e.message : e}`))
    return chain
  }

  const payloadInline = opts.payload && opts.payload.length <= PAYLOAD_INLINE_MAX ? opts.payload : undefined
  const env = buildTaskEnv({ task, secrets, payloadInline, query: opts.query })

  const onEvent = (event: RunnerEvent) => {
    if (event.type === 'phase' && event.phase) {
      phases.push({ phase: event.phase })
      void setPhase(client, run.id, event.phase)
    }
    else if (event.type === 'log' && event.data) {
      pending += event.data
      void flush()
    }
  }

  const job = {
    runtime: task.runtime,
    files: task.files,
    entrypoint: task.entrypoint,
    deps: task.deps,
    depsLock: task.deps_lock,
    env,
    payload: opts.payload ?? undefined,
    timeoutMs: task.timeout_s * 1000,
    rebuildEnv: !!opts.rebuildEnv,
  }

  let final: RunnerEvent
  try {
    // A built-in action returns a final event of the same shape, so everything below
    // (masking, log tail, artifacts, retries, sink) does not know the difference.
    final = task.builtin
      ? await runBuiltinScript(resolveBuiltin(task.builtin).script, { env, timeoutMs: job.timeoutMs, onEvent })
      : await callRunner(url, opts.runners.secret, job, onEvent)
  }
  catch (ex: unknown) {
    const reason = ex instanceof Error ? ex.message : String(ex)
    await finish(client, run.id, { status: 'failed', result: null, error: 'runner' })
    return {
      runId: run.id,
      status: 'failed',
      exitCode: null,
      stdout: '',
      stderr: reason,
      error: 'runner',
      phases,
      envKey: null,
      attempt,
      artifacts: [],
    }
  }

  // Masking before return and before write — all three channels.
  const masked = maskRun({
    stdout: final.stdout ?? '',
    stderr: final.stderr ?? '',
    log: pending,
  }, secretValues)
  pending = masked.log
  await flush(true)

  const artifacts = await saveArtifacts(client, run.id, (final.artifacts ?? []).map(a => ({
    path: a.path,
    size: a.size,
    contentType: a.contentType ?? null,
    body: Buffer.from(a.b64, 'base64'),
  })))

  // A broken/oversized result file does not fail the run, but must be visible —
  // otherwise "why are my fields missing in the next task" has no answer.
  if (final.dataError)
    await appendLog(client, run.id, `\n[runner] ${final.dataError}\n`)

  const timedOut = !!final.timedOut
  const failed = !!final.error || timedOut || final.exit !== 0
  const errorCode = final.error ? 'runner' : timedOut ? 'timeout' : failed ? 'exit' : null

  await finish(client, run.id, {
    status: failed ? 'failed' : 'done',
    result: {
      stdout: masked.stdout.slice(-4000),
      stderr: masked.stderr.slice(-4000),
      exitCode: final.exit ?? null,
      durationMs: final.durationMs ?? 0,
      envKey: final.envKey ?? null,
      preparedEnv: !!final.preparedEnv,
      late: opts.late ?? false,
      lateByMs: opts.lateByMs ?? 0,
      artifacts: artifacts.map(a => ({ path: a.path, size: a.size })),
      skippedArtifacts: final.skippedArtifacts ?? [],
      attempt,
      // Fields from the task itself (`$RUN_DATA_FILE`) — under their own key, so they
      // never overwrite ours (`status`, `exitCode`, …).
      data: (final.data as Record<string, unknown> | undefined) ?? null,
    },
    error: errorCode,
  })

  return {
    runId: run.id,
    status: failed ? 'failed' : 'done',
    exitCode: final.exit ?? null,
    stdout: masked.stdout,
    stderr: final.error ? `${masked.stderr}\n${final.error}` : masked.stderr,
    error: errorCode,
    phases,
    envKey: final.envKey ?? null,
    attempt,
    artifacts: artifacts.map(a => ({ path: a.path, size: a.size })),
    data: (final.data as Record<string, unknown> | undefined) ?? null,
  }
}

/**
 * Per-task queue for `overlap_policy='queue'`: runs of the same task go
 * one after another, not in parallel (otherwise "queue" would just be a name for
 * "parallel"). ponytail: in-process queue — there is one BFF (ADR-015);
 * a durable queue via Redis/DB = Revisit when horizontal scaling.
 */
const taskChains = new Map<string, Promise<unknown>>()

function enqueue<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prev = taskChains.get(taskId) ?? Promise.resolve()
  // `fn` on both branches: a failure of the previous run must not block the queue.
  const next = prev.then(fn, fn)
  taskChains.set(taskId, next.catch(() => undefined))
  return next
}

/**
 * Runs a task: overlap gate → resolve creds → runner → phases/log/artifacts →
 * retries with backoff. Returns the result of the last attempt.
 */
export async function runTask(client: SupabaseClient, opts: RunTaskOpts): Promise<RunTaskResult> {
  const { task } = opts

  // An overlap is visible in the journal, not a silent exit.
  if (await hasRunningRun(client, task.id)) {
    if (task.overlap_policy === 'skip') {
      const run = await insertSkipped(client, {
        kind: 'task',
        actor: opts.actor,
        deviceId: null,
        refId: null,
        label: task.name,
        input: { runtime: task.runtime, entrypoint: task.entrypoint },
        taskId: task.id,
        reason: 'overlap',
        idempotencyKey: opts.idempotencyKey ?? null,
      })
      return {
        runId: run.id,
        status: 'skipped',
        exitCode: null,
        stdout: '',
        stderr: '',
        error: 'overlap',
        phases: [],
        envKey: null,
        attempt: 1,
        artifacts: [],
      }
    }
    // 'queue': wait our turn instead of a parallel run.
    return enqueue(task.id, () => runAttempts(client, opts))
  }

  return runAttempts(client, opts)
}

/**
 * Whether to send to the sink (tier Full). Notify on the final state — after all
 * retries, otherwise "failed and recovered on the second attempt" would wake someone nightly.
 * `skipped` is not notified: an overlap is not a task result.
 */
export function shouldNotifySink(
  task: Pick<TaskRow, 'sink_url' | 'sink_on'>,
  status: RunTaskResult['status'],
): boolean {
  if (!task.sink_url || status === 'skipped')
    return false
  return task.sink_on === 'always' || status === 'failed'
}

/** How much stderr tail goes into the summary: a "why it failed" line, not the whole log. */
const SINK_STDERR_TAIL = 500

/**
 * Notification body: a summary, without the full log and without env — the sink is
 * often a third-party service. Three channels the sink gets beyond the basic facts:
 * - `data` — what the task itself wrote to `$RUN_DATA_FILE` (the sender's channel:
 *   this is how task A passes its fields to task B);
 * - `stderrTail` — the stderr tail (already masked of secrets), so the message
 *   says "why", not just "failed";
 * - `runUrl` — a direct link to the run in the panel; only if the app address is
 *   configured (`NUXT_PUBLIC_APP_URL`) — deliberately no default in code (deployment-specific).
 */
export function sinkPayload(
  task: Pick<TaskRow, 'id' | 'name'>,
  result: RunTaskResult,
  appUrl = process.env.NUXT_PUBLIC_APP_URL ?? '',
): Record<string, unknown> {
  const tail = (result.stderr ?? '').slice(-SINK_STDERR_TAIL)
  const base = appUrl.replace(/\/+$/, '')
  return {
    task: { id: task.id, name: task.name },
    runId: result.runId,
    status: result.status,
    exitCode: result.exitCode,
    error: result.error,
    attempt: result.attempt,
    artifacts: result.artifacts.map(a => a.path),
    data: result.data ?? null,
    ...(tail ? { stderrTail: tail } : {}),
    ...(base ? { runUrl: `${base}/admin/tasks?run=${result.runId}` } : {}),
  }
}

/**
 * POSTs the summary to `sink_url`. A sink failure does NOT change the run status (the
 * task did its job), but does not vanish either — a line is appended to the run log,
 * because that is where the operator looks for "why didn't I get it".
 */
async function notifySink(
  client: SupabaseClient,
  task: TaskRow,
  result: RunTaskResult,
): Promise<void> {
  try {
    const resp = await fetch(task.sink_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sinkPayload(task, result)),
      signal: AbortSignal.timeout(SINK_TIMEOUT_MS),
    })
    await appendLog(client, result.runId, resp.ok
      ? `\n[sink] ${resp.status} ${task.sink_url}\n`
      : `\n[sink] FAILED ${resp.status} ${task.sink_url}\n`)
  }
  catch (ex: unknown) {
    await appendLog(client, result.runId, `\n[sink] FAILED ${(ex as Error).message}\n`)
  }
}

/** Attempt + retries with backoff. Returns the result of the last attempt. */
async function runAttempts(client: SupabaseClient, opts: RunTaskOpts): Promise<RunTaskResult> {
  const { task } = opts
  const secrets = await resolveTaskSecrets(client, task, opts.actor, opts.keyHex)
  // Mask only passwords: login and port are not secret (ADR-009 amendment).
  const secretValues = Object.values(secrets).map(s => s.password ?? '').filter(Boolean)

  let result = await runAttempt(client, opts, 1, secrets, secretValues)
  for (let attempt = 2; result.status === 'failed' && attempt <= task.retries + 1; attempt++) {
    const delay = nextAttemptDelayMs(attempt - 1, task.backoff_s)
    if (delay > 0)
      await new Promise(r => setTimeout(r, delay))
    result = await runAttempt(client, opts, attempt, secrets, secretValues)
  }

  if (shouldNotifySink(task, result.status))
    await notifySink(client, task, result)
  return result
}
