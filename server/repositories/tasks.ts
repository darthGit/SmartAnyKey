// Repository: data access for `tasks` and `task_triggers`. Only this layer
// touches the DB (3-Tier).
//
// A trigger is a separate entity, because one task = cron + webhook at once.
// The raw webhook token exists exactly once — at creation; only its sha256 goes
// to the DB (like a password, not like an identifier).
import { createHash, randomBytes } from 'node:crypto'
import { createError } from 'h3'
import type { SupabaseClient } from '@supabase/supabase-js'
import { nextRunAt } from '../utils/cron'

export const TASK_COLS = 'id,name,builtin,runtime,entrypoint,files,deps,deps_lock,env,cred_refs,'
  + 'timeout_s,retries,backoff_s,overlap_policy,min_role,enabled,sink_url,sink_on,created_at,updated_at'
const TRIGGER_COLS = 'id,task_id,kind,cron,next_run_at,misfire_policy,sync,enabled,created_at'

export interface TaskRow {
  id: string
  name: string
  /**
   * Built-in action key (ADR-018 amendment #4): set → the BFF itself runs it
   * (`services/task-builtins`), `runtime`/`entrypoint`/`files` play no part.
   * The row is born in a migration; the API never sets it.
   */
  builtin: string | null
  runtime: string
  entrypoint: string
  files: Record<string, string>
  deps: string
  deps_lock: string
  env: Record<string, unknown>
  cred_refs: { set_id: string, env: string }[]
  timeout_s: number
  retries: number
  backoff_s: number
  overlap_policy: 'skip' | 'queue'
  min_role: 'operator' | 'admin'
  enabled: boolean
  /** Result receiver (tier Full): empty = do not notify. */
  sink_url: string
  sink_on: 'failed' | 'always'
}

export interface TriggerRow {
  id: string
  task_id: string
  kind: 'cron' | 'webhook'
  cron: string | null
  next_run_at: string | null
  misfire_policy: 'run' | 'skip'
  sync: boolean
  enabled: boolean
}

export interface NewTrigger {
  task_id: string
  kind: 'cron' | 'webhook'
  cron?: string | null
  /** Optional: if unset for cron — computed from the expression relative to `now`. */
  next_run_at?: string | null
  misfire_policy?: 'run' | 'skip'
  sync?: boolean
  enabled?: boolean
}

const dbFail = (msg: string): never => {
  throw createError({ statusCode: 502, statusMessage: `DB: ${msg}` })
}

export const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex')

// --- definitions --------------------------------------------------------------

export async function listTasks(sr: SupabaseClient): Promise<TaskRow[]> {
  const { data, error } = await sr.from('tasks').select(TASK_COLS).order('name')
  if (error) dbFail(error.message)
  return (data ?? []) as TaskRow[]
}

export async function getTask(sr: SupabaseClient, id: string): Promise<TaskRow | null> {
  const { data, error } = await sr.from('tasks').select(TASK_COLS).eq('id', id).maybeSingle()
  if (error) dbFail(error.message)
  return (data ?? null) as TaskRow | null
}

export async function createTask(sr: SupabaseClient, input: Record<string, unknown>): Promise<TaskRow> {
  const { data, error } = await sr.from('tasks').insert(input).select(TASK_COLS).single()
  if (error) {
    if (error.code === '23505')
      throw createError({ statusCode: 409, statusMessage: 'task name already exists' })
    // Schema CHECKs (entrypoint outside files, empty files) — that is a 400, not a 500.
    if (error.code === '23514')
      throw createError({ statusCode: 400, statusMessage: `task shape rejected: ${error.message}` })
    dbFail(error.message)
  }
  return data as TaskRow
}

export async function updateTask(sr: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<TaskRow> {
  const { data, error } = await sr.from('tasks')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id).select(TASK_COLS).single()
  if (error) {
    if (error.code === '23514')
      throw createError({ statusCode: 400, statusMessage: `task shape rejected: ${error.message}` })
    dbFail(error.message)
  }
  return data as TaskRow
}

export async function removeTask(sr: SupabaseClient, id: string): Promise<void> {
  const { error } = await sr.from('tasks').delete().eq('id', id)
  if (error) dbFail(error.message)
}

// --- triggers -----------------------------------------------------------------

/**
 * Creates a trigger. For `cron` validates the expression HERE (an invalid one is
 * not saved) and materialises `next_run_at`. For `webhook` generates a token and
 * returns it raw ONLY once — after that only the hash remains.
 */
export async function createTrigger(
  sr: SupabaseClient,
  input: NewTrigger,
): Promise<TriggerRow & { token?: string }> {
  const row: Record<string, unknown> = {
    task_id: input.task_id,
    kind: input.kind,
    misfire_policy: input.misfire_policy ?? 'run',
    sync: input.sync ?? false,
    enabled: input.enabled ?? true,
  }

  let token: string | undefined

  if (input.kind === 'cron') {
    const expr = (input.cron ?? '').trim()
    // Throws on an invalid expression — the gate is on write, not on a run attempt.
    const computed = nextRunAt(expr, new Date())
    row.cron = expr
    row.next_run_at = input.next_run_at ?? computed.toISOString()
  }
  else {
    token = randomBytes(32).toString('base64url')
    row.token_hash = hashToken(token)
  }

  const { data, error } = await sr.from('task_triggers').insert(row).select(TRIGGER_COLS).single()
  if (error) {
    if (error.code === '23514')
      throw createError({ statusCode: 400, statusMessage: `trigger shape rejected: ${error.message}` })
    dbFail(error.message)
  }
  return { ...(data as TriggerRow), token }
}

export async function listTriggers(sr: SupabaseClient, taskId: string): Promise<TriggerRow[]> {
  // Deterministic order: without `order` PostgREST returns rows in an order that
  // changes after every UPDATE — the toggles in the panel "jumped" places
  // (the same bug class as unstable list sorting).
  const { data, error } = await sr.from('task_triggers')
    .select(TRIGGER_COLS).eq('task_id', taskId)
    .order('kind').order('created_at')
  if (error) dbFail(error.message)
  return (data ?? []) as TriggerRow[]
}

export async function updateTrigger(sr: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<TriggerRow> {
  const next = { ...patch }
  if (typeof next.cron === 'string') {
    const computed = nextRunAt(next.cron.trim(), new Date())
    next.cron = next.cron.trim()
    next.next_run_at ??= computed.toISOString()
  }
  const { data, error } = await sr.from('task_triggers').update(next).eq('id', id).select(TRIGGER_COLS).single()
  if (error) dbFail(error.message)
  return data as TriggerRow
}

export async function removeTrigger(sr: SupabaseClient, id: string): Promise<void> {
  const { error } = await sr.from('task_triggers').delete().eq('id', id)
  if (error) dbFail(error.message)
}

/** Trigger by webhook token (looked up by hash — the raw one is not in the DB). */
export async function triggerByToken(sr: SupabaseClient, rawToken: string): Promise<TriggerRow | null> {
  const { data, error } = await sr.from('task_triggers')
    .select(TRIGGER_COLS).eq('token_hash', hashToken(rawToken)).eq('kind', 'webhook').maybeSingle()
  if (error) dbFail(error.message)
  return (data ?? null) as TriggerRow | null
}

// --- scheduler ----------------------------------------------------------------

/** Due cron triggers (enabled, time has come). Pattern of ADR-015 (`next_scan_at`). */
export async function dueTriggers(sr: SupabaseClient, now: Date): Promise<TriggerRow[]> {
  const { data, error } = await sr.from('task_triggers')
    .select(TRIGGER_COLS)
    .eq('kind', 'cron').eq('enabled', true)
    .not('next_run_at', 'is', null)
    .lte('next_run_at', now.toISOString())
    .order('next_run_at')
  if (error) dbFail(error.message)
  return (data ?? []) as TriggerRow[]
}

/**
 * Claim a trigger before a run: conditional `update … where next_run_at = <read value>`.
 * Two BFF replicas read the same row, but ONLY one moves the time — the other
 * gets 0 rows and skips (ADR-015 "Revisit when: horizontal scale").
 * The time is bumped before the run, so a tick does not re-pick an in-flight trigger.
 */
export async function claimTrigger(
  sr: SupabaseClient,
  trigger: Pick<TriggerRow, 'id' | 'next_run_at'>,
  nextRun: Date,
): Promise<boolean> {
  const q = sr.from('task_triggers')
    .update({ next_run_at: nextRun.toISOString() })
    .eq('id', trigger.id)
  const { data, error } = await (trigger.next_run_at
    ? q.eq('next_run_at', trigger.next_run_at)
    : q.is('next_run_at', null)).select('id')
  if (error) dbFail(error.message)
  return (data ?? []).length === 1
}

/** Whether the task has an unfinished run (for `overlap_policy`). */
export async function hasRunningRun(sr: SupabaseClient, taskId: string): Promise<boolean> {
  const { data, error } = await sr.from('task_run')
    .select('id').eq('task_id', taskId).eq('status', 'running').limit(1)
  if (error) dbFail(error.message)
  return (data ?? []).length > 0
}
