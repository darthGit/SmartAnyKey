// Repository: task_run — a generic execution+audit row (seam for Phase 2).
// BFF-only (RLS: a client sees only its own via the select policy). insertRunning
// creates the row before the detached start (controller returns 202), finish finalises.
import { createError } from 'h3'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface NewRun {
  kind: string
  actor: string
  deviceId: string | null
  refId: string | null
  label: string
  input: Record<string, unknown> | null
  // --- scheduled tasks (0015): a task instead of a device --------------------
  /** Task run (`tasks.id`); stays null for a device's SSH/local commands. */
  taskId?: string | null
  /** Attempt number: retries are separate rows, visible in run details. */
  attempt?: number
  /** Webhook idempotency key: a repeat does not create a second run. */
  idempotencyKey?: string | null
}

// One running discovery scan per point is held by a partial unique index (migration 0022).
export const ONE_RUNNING_KINDS = new Set(['discovery-scan'])

/** The running run of `kind` for `refId`, if any. */
export async function runningFor(client: SupabaseClient, kind: string, refId: string): Promise<{ id: string } | null> {
  const { data, error } = await client.from('task_run').select('id')
    .eq('kind', kind).eq('ref_id', refId).eq('status', 'running').maybeSingle()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return (data as { id: string }) ?? null
}

/** `existing: true` — the row was not created: a run of a one-at-a-time kind was already going. */
export async function insertRunning(client: SupabaseClient, run: NewRun): Promise<{ id: string, existing?: true }> {
  const { data, error } = await client.from('task_run').insert({
    kind: run.kind,
    actor: run.actor,
    device_id: run.deviceId,
    ref_id: run.refId,
    label: run.label,
    input: run.input,
    status: 'running',
    task_id: run.taskId ?? null,
    attempt: run.attempt ?? 1,
    idempotency_key: run.idempotencyKey ?? null,
  }).select('id').single()
  if (error) {
    // A race on the same idempotency key is not a caller error:
    // return the already created run.
    if (error.code === '23505' && run.idempotencyKey) {
      const existing = await runByIdempotencyKey(client, run.taskId ?? '', run.idempotencyKey)
      if (existing)
        return existing
    }
    if (error.code === '23505' && run.refId && ONE_RUNNING_KINDS.has(run.kind)) {
      const current = await runningFor(client, run.kind, run.refId)
      if (current)
        return { id: current.id, existing: true }
    }
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  }
  return data as { id: string }
}

/** Run by idempotency key (a repeat does not create a second row). */
export async function runByIdempotencyKey(
  client: SupabaseClient,
  taskId: string,
  key: string,
): Promise<{ id: string } | null> {
  const { data, error } = await client.from('task_run')
    .select('id').eq('task_id', taskId).eq('idempotency_key', key).maybeSingle()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return (data ?? null) as { id: string } | null
}

/** Run phase (`preparing_env` / `running`) — separate from status. */
export async function setPhase(client: SupabaseClient, id: string, phase: string): Promise<void> {
  const { error } = await client.from('task_run').update({ phase }).eq('id', id)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
}

/**
 * Log tail that grows during the run (the client sees progress via Realtime).
 * We keep only the tail: the full log goes to artifacts.
 * Kept simple: read-modify-write without locking — there is one writer (this run).
 */
export async function appendLog(
  client: SupabaseClient,
  id: string,
  chunk: string,
  maxChars = 64_000,
): Promise<void> {
  const { data, error: readErr } = await client.from('task_run').select('log').eq('id', id).single()
  if (readErr)
    throw createError({ statusCode: 502, statusMessage: `DB: ${readErr.message}` })
  const merged = ((data?.log as string | null) ?? '') + chunk
  const tail = merged.length > maxChars ? merged.slice(merged.length - maxChars) : merged
  const { error } = await client.from('task_run').update({ log: tail }).eq('id', id)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
}

/** A run skipped by `overlap_policy` — a visible row, not silence. */
export async function insertSkipped(
  client: SupabaseClient,
  run: NewRun & { reason: string },
): Promise<{ id: string }> {
  const { data, error } = await client.from('task_run').insert({
    kind: run.kind,
    actor: run.actor,
    device_id: run.deviceId,
    ref_id: run.refId,
    label: run.label,
    input: run.input,
    task_id: run.taskId ?? null,
    attempt: run.attempt ?? 1,
    idempotency_key: run.idempotencyKey ?? null,
    status: 'skipped',
    error: run.reason,
    finished_at: new Date().toISOString(),
  }).select('id').single()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return data as { id: string }
}

export async function finish(
  client: SupabaseClient,
  id: string,
  patch: { status: 'done' | 'failed', result: Record<string, unknown> | null, error: string | null },
): Promise<void> {
  const { error } = await client.from('task_run').update({
    status: patch.status,
    result: patch.result,
    error: patch.error,
    finished_at: new Date().toISOString(),
  }).eq('id', id)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
}

// stale-reaper: a BFF restart leaves detached tasks in 'running' forever.
// On boot mark stale ones as failed/stale (ceiling: in-process queue).
export async function reapStale(client: SupabaseClient, olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString()
  const { data, error } = await client.from('task_run')
    .update({ status: 'failed', error: 'stale', finished_at: new Date().toISOString() })
    .eq('status', 'running').lt('started_at', cutoff).select('id')
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return (data ?? []).length
}

/** Run journal. `actor` set → only their rows. */
export async function listRuns(
  client: SupabaseClient,
  opts: { taskId?: string, status?: string, actor?: string, limit?: number, offset?: number },
): Promise<Record<string, unknown>[]> {
  const from = opts.offset ?? 0
  const to = from + (opts.limit ?? 50) - 1
  let q = client.from('task_run')
    .select('id,task_id,kind,actor,label,status,phase,attempt,error,result,started_at,finished_at')
    // Filter by kind, not by `task_id is not null`: deleting a definition sets
    // `task_id = null` (FK on delete set null), and runs must stay in the
    // journal — audit outlives task deletion, the name is in the `label` snapshot.
    // A task_id filter would silently hide this history.
    .eq('kind', 'task')
    // Stable sort (started_at has duplicates in a burst) — otherwise pages
    // jump, as in devices (PostgREST row cap).
    .order('started_at', { ascending: false }).order('id')
    .range(from, to)
  if (opts.taskId)
    q = q.eq('task_id', opts.taskId)
  if (opts.status)
    q = q.eq('status', opts.status)
  if (opts.actor)
    q = q.eq('actor', opts.actor)
  const { data, error } = await q
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return (data ?? []) as Record<string, unknown>[]
}

/** One run (details). */
export async function getRun(
  client: SupabaseClient,
  id: string,
): Promise<{ id: string, task_id: string | null, actor: string, log: string | null } & Record<string, unknown> | null> {
  const { data, error } = await client.from('task_run')
    .select('id,task_id,kind,actor,label,status,phase,attempt,error,result,input,log,started_at,finished_at')
    .eq('id', id).maybeSingle()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return (data ?? null) as never
}
