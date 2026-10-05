// Task scheduler. Same pattern as ADR-015 (point rescan): the tick picks due
// triggers, bumps the time BEFORE the run and runs them serially. Pure decisions
// live here; DB work and the run itself are below, in `dispatchDueTriggers`
// (added together with the repository).
//
// Decisions are pulled into functions because this is the core of the feature and
// must be testable without a DB: `planNextRun` holds all misfire semantics, and
// this is where a backlog burst after BFF downtime is (or is not) born.
import type { SupabaseClient } from '@supabase/supabase-js'
import { nextRunAt } from '../utils/cron'
import { claimTrigger, dueTriggers, getTask } from '../repositories/tasks'
import type { RunnersConfig } from './task-runner'
import { runTask } from './task-runner'

/**
 * How far a tick may lag and still count as "normal". The tick runs once a
 * minute, so a delay within a minute is not a misfire, just regular work.
 */
const GRACE_MS = 60_000

export interface PlanInput {
  /** `task_triggers.next_run_at` — the materialised due marker. */
  storedNextRunAt: Date
  now: Date
  misfirePolicy: 'run' | 'skip'
}

export interface RunPlan {
  runNow: boolean
  /** The run is executed late (the panel shows "started N late"). */
  late: boolean
  lateByMs: number
  /** Where to move `next_run_at`. Always from `now`, not from the missed slot. */
  nextRunAt: Date
}

export function planNextRun(expr: string, input: PlanInput): RunPlan {
  const { storedNextRunAt, now, misfirePolicy } = input

  // Parse first — an invalid expression must throw whether or not the slot is
  // due (a trigger with such an expression should never have been saved).
  const nextFromNow = nextRunAt(expr, now)

  const overdueMs = now.getTime() - storedNextRunAt.getTime()
  if (overdueMs < 0) {
    // Slot is in the future — not our turn, the time does not move.
    return { runNow: false, late: false, lateByMs: 0, nextRunAt: storedNextRunAt }
  }

  const late = overdueMs > GRACE_MS

  return {
    // The misfire policy applies only to a missed slot; a slot that has just
    // come due always runs.
    runNow: late ? misfirePolicy === 'run' : true,
    late,
    lateByMs: overdueMs,
    // Key point: from `now`. Counting from the missed slot, `*/5` after a
    // 4-hour downtime would fire 48 runs in a row.
    nextRunAt: nextFromNow,
  }
}

/**
 * What to do if the previous run of this task has not finished yet.
 * `skip` must be visible in the log — hence a decision, not a silent `return`.
 */
export function decideOverlap(policy: 'skip' | 'queue', hasRunning: boolean): 'run' | 'skip' | 'queue' {
  if (!hasRunning)
    return 'run'
  return policy === 'skip' ? 'skip' : 'queue'
}

/**
 * Delay before a retry: exponential backoff from the base `backoff_s`.
 * `backoff_s = 0` → no wait (the developer turned it off).
 */
export function nextAttemptDelayMs(attempt: number, backoffS: number): number {
  if (backoffS <= 0)
    return 0
  const n = Math.max(1, attempt)
  return backoffS * 1000 * 2 ** (n - 1)
}

// --- tick dispatcher -----------------------------------------------------------

/**
 * Scheduler tick: picks due triggers and runs them serially (same pattern as
 * the point rescan — ADR-015: no burst). `next_run_at` is bumped BEFORE the
 * run via a claim, so the next tick will not re-pick a trigger in flight, and a
 * second BFF replica will not run it twice.
 */
export async function dispatchDueTriggers(
  client: SupabaseClient,
  opts: { now: Date, keyHex: string, runners: RunnersConfig },
): Promise<number> {
  const due = await dueTriggers(client, opts.now)
  let dispatched = 0

  for (const trigger of due) {
    if (!trigger.cron || !trigger.next_run_at)
      continue

    let plan: RunPlan
    try {
      plan = planNextRun(trigger.cron, {
        storedNextRunAt: new Date(trigger.next_run_at),
        now: opts.now,
        misfirePolicy: trigger.misfire_policy,
      })
    }
    catch (ex: unknown) {
      // An invalid expression in the DB (e.g. a manual edit) must not kill the whole tick.
      console.warn(`[tasks:tick] trigger ${trigger.id}: ${ex instanceof Error ? ex.message : ex}`)
      continue
    }

    // Claim = moving the time. Failed → another replica already took it.
    if (!await claimTrigger(client, trigger, plan.nextRunAt))
      continue

    // misfire_policy='skip' only moves the time — there is no run.
    if (!plan.runNow)
      continue

    const task = await getTask(client, trigger.task_id)
    if (!task || !task.enabled)
      continue

    // An empty runtime registry is a valid install state (no domain defaults),
    // and then a runner task has nothing to run on. But a builtin one (ADR-018
    // amendment 4) needs no runner: the BFF runs it itself. A guard that did not
    // tell these two apart silently disabled backup on every standard install.
    if (!task.builtin && !Object.keys(opts.runners.registry).length)
      continue

    await runTask(client, {
      task,
      actor: 'scheduler',
      keyHex: opts.keyHex,
      runners: opts.runners,
      late: plan.late,
      lateByMs: plan.lateByMs,
    })
    dispatched++
  }

  return dispatched
}
