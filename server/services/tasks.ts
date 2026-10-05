// Task domain service: webhook trigger and re-run.
// Controllers stay thin (3-tier) — all logic lives here.
//
// The webhook is the ONLY entry into the system not authenticated by a session (an
// external caller has no session), so authentication = the trigger token, and flood protection =
// rate limit (ADR-013: "internal network" does not count as authentication).
import { createError } from 'h3'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { RunTaskResult, RunnersConfig } from './task-runner'
import { runTask } from './task-runner'
import { getTask, triggerByToken } from '../repositories/tasks'
import { runByIdempotencyKey } from '../repositories/task-runs'
import { hitRate } from '../utils/rate-limit'

/** Payload size limit (the payload may contain personal data). */
export const PAYLOAD_MAX_BYTES = 1 << 20 // 1 MB

/** Webhook rate limit: sliding window per trigger (server/utils/rate-limit). */
const HOOK_WINDOW_MS = 60_000
const HOOK_MAX_PER_WINDOW = Number(process.env.NUXT_TASKS_HOOK_RATE_MAX ?? 20)

export function checkHookRate(triggerId: string, now = Date.now()): void {
  if (hitRate(`hook:${triggerId}`, HOOK_MAX_PER_WINDOW, HOOK_WINDOW_MS, now)) {
    throw createError({
      statusCode: 429,
      statusMessage: `rate limit: max ${HOOK_MAX_PER_WINDOW} hooks/min for this trigger`,
    })
  }
}

export interface HookOpts {
  token: string
  payload?: unknown
  keyHex: string
  runners: RunnersConfig
  idempotencyKey?: string | null
  /** Overrides `task_triggers.sync`. */
  sync?: boolean
  /**
   * Query of the call (without the service `sync`) → to the task as `RUN_QUERY`. This is
   * where the caller passes its own data: `?chat=-100…` in a sink URL makes one shared
   * notifier usable for any number of tasks and chats.
   */
  query?: Record<string, string> | null
}

export interface HookResult {
  status: number
  runId: string
  stdout?: string
  stderr?: string
  exitCode?: number | null
}

/**
 * Webhook entry. `async` returns `202` + the run id, but **only after the run
 * row is persisted** ("respond 2xx only after persisting", never "on receipt").
 */
export async function runHook(client: SupabaseClient, opts: HookOpts): Promise<HookResult> {
  const trigger = await triggerByToken(client, opts.token)
  // Unknown and disabled token get the same response: we do not hint which one.
  if (!trigger || !trigger.enabled)
    throw createError({ statusCode: 401, statusMessage: 'invalid token' })

  checkHookRate(trigger.id)

  const payloadRaw = opts.payload === undefined
    ? null
    : typeof opts.payload === 'string' ? opts.payload : JSON.stringify(opts.payload)
  if (payloadRaw && Buffer.byteLength(payloadRaw, 'utf8') > PAYLOAD_MAX_BYTES)
    throw createError({ statusCode: 413, statusMessage: 'payload too large' })

  const task = await getTask(client, trigger.task_id)
  if (!task)
    throw createError({ statusCode: 404, statusMessage: 'task not found' })
  if (!task.enabled)
    throw createError({ statusCode: 409, statusMessage: 'task disabled' })

  // A repeat with the same key does not create a second run.
  if (opts.idempotencyKey) {
    const existing = await runByIdempotencyKey(client, task.id, opts.idempotencyKey)
    if (existing)
      return { status: 202, runId: existing.id }
  }

  const sync = opts.sync ?? trigger.sync

  if (sync) {
    const result = await runTask(client, {
      task,
      actor: 'webhook',
      keyHex: opts.keyHex,
      runners: opts.runners,
      payload: payloadRaw,
      query: opts.query ?? null,
      idempotencyKey: opts.idempotencyKey ?? null,
    })
    return {
      status: 200,
      runId: result.runId,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }
  }

  // Async: wait for the row to be created, then the run continues in the background.
  let resolveStarted: (id: string) => void
  const started = new Promise<string>((resolve) => {
    resolveStarted = resolve
  })
  const running = runTask(client, {
    task,
    actor: 'webhook',
    keyHex: opts.keyHex,
    runners: opts.runners,
    payload: payloadRaw,
    query: opts.query ?? null,
    idempotencyKey: opts.idempotencyKey ?? null,
    onStarted: id => resolveStarted(id),
  })
  // The run may fail before the row is created (e.g. runtime not configured) —
  // then `started` never resolves, so we race it against the failure itself.
  running.catch(() => { /* the final state is already in task_run; not silenced here */ })
  const runId = await Promise.race([
    started,
    running.then(r => r.runId),
  ])

  return { status: 202, runId }
}

/**
 * Re-run on the same data: the payload comes from the snapshot
 * `task_run.input`, not from the current state of the external system.
 */
export async function rerun(
  client: SupabaseClient,
  opts: { runId: string, actor: string, keyHex: string, runners: RunnersConfig },
): Promise<RunTaskResult> {
  const { data, error } = await client.from('task_run')
    .select('task_id,input').eq('id', opts.runId).maybeSingle()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  if (!data?.task_id)
    throw createError({ statusCode: 404, statusMessage: 'run not found' })

  const task = await getTask(client, data.task_id as string)
  if (!task)
    throw createError({ statusCode: 409, statusMessage: 'task no longer exists' })

  const snapshot = data.input as { payload?: string | null, query?: Record<string, string> | null } | null

  return runTask(client, {
    task,
    actor: opts.actor,
    keyHex: opts.keyHex,
    runners: opts.runners,
    payload: snapshot?.payload ?? null,
    query: snapshot?.query ?? null,
  })
}
