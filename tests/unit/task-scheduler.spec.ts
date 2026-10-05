// RED. Pure scheduler decisions — no DB and no HTTP (3-tier: a service does
// not touch the client directly, so the decisions live in functions that can
// be checked on their own).
// Module server/services/task-scheduler.ts does not exist yet → the suite fails.
//
// `planNextRun` — one function for all misfire semantics («BFF downtime ≠ a
// lost run, but not a burst either»): decides whether to run an overdue slot,
// whether it is "late", and when the next one is. Key property: the next time
// counts from `now`, so a 4-hour downtime gives ONE run,
// not 48 in a row.
import { describe, expect, it } from 'vitest'
import { decideOverlap, nextAttemptDelayMs, planNextRun } from '../../server/services/task-scheduler'

const at = (iso: string) => new Date(iso)
const EVERY_5 = '*/5 * * * *'

describe('planNextRun — due / not due', () => {
  it('slot in the future → do not run, do not move the time', () => {
    const now = at('2026-08-13T10:02:00')
    const plan = planNextRun(EVERY_5, { storedNextRunAt: at('2026-08-13T10:05:00'), now, misfirePolicy: 'run' })
    expect(plan.runNow).toBe(false)
    expect(plan.nextRunAt).toEqual(at('2026-08-13T10:05:00'))
  })

  it('slot just arrived → run, do not mark as late', () => {
    const now = at('2026-08-13T10:05:01')
    const plan = planNextRun(EVERY_5, { storedNextRunAt: at('2026-08-13T10:05:00'), now, misfirePolicy: 'run' })
    expect(plan.runNow).toBe(true)
    expect(plan.late).toBe(false)
    expect(plan.nextRunAt).toEqual(at('2026-08-13T10:10:00'))
  })
})

describe('planNextRun — misfire after downtime (AC-17)', () => {
  const storedNextRunAt = at('2026-08-13T06:00:00') // overdue by 4 hours
  const now = at('2026-08-13T10:02:00')

  it('misfire_run_executes_once_marked_late', () => {
    const plan = planNextRun(EVERY_5, { storedNextRunAt, now, misfirePolicy: 'run' })
    expect(plan.runNow).toBe(true)
    expect(plan.late).toBe(true)
    expect(plan.lateByMs).toBe(4 * 60 * 60 * 1000 + 2 * 60 * 1000)
  })

  it('misfire_run_next_is_from_now_not_missed_slot: zero backlog burst', () => {
    const plan = planNextRun(EVERY_5, { storedNextRunAt, now, misfirePolicy: 'run' })
    // From `now` → 10:05. Counting from the missed slot would give 06:05, and the next
    // 48 ticks would work off all missed slots in a row (the known trap).
    expect(plan.nextRunAt).toEqual(at('2026-08-13T10:05:00'))
    expect(plan.nextRunAt.getTime()).toBeGreaterThan(now.getTime())
  })

  it('misfire_skip_only_shifts_time: the overdue slot is NOT run at all', () => {
    const plan = planNextRun(EVERY_5, { storedNextRunAt, now, misfirePolicy: 'skip' })
    expect(plan.runNow).toBe(false)
    expect(plan.nextRunAt).toEqual(at('2026-08-13T10:05:00'))
  })

  it('both policies give the same next time — the difference is only in this run', () => {
    const run = planNextRun(EVERY_5, { storedNextRunAt, now, misfirePolicy: 'run' })
    const skip = planNextRun(EVERY_5, { storedNextRunAt, now, misfirePolicy: 'skip' })
    expect(run.nextRunAt).toEqual(skip.nextRunAt)
    expect(run.runNow).not.toBe(skip.runNow)
  })

  it('an invalid expression throws (a trigger with such an expression could not have been saved — AC-6)', () => {
    expect(() => planNextRun('* * *', { storedNextRunAt, now, misfirePolicy: 'run' })).toThrow()
  })
})

describe('decideOverlap (AC-7)', () => {
  it('overlap_skip_when_run_in_flight', () => {
    expect(decideOverlap('skip', true)).toBe('skip')
  })

  it('skip with no unfinished run — a normal start', () => {
    expect(decideOverlap('skip', false)).toBe('run')
  })

  it('queue with an unfinished run — into the queue, nothing lost', () => {
    expect(decideOverlap('queue', true)).toBe('queue')
  })

  it('queue with no unfinished run — right away', () => {
    expect(decideOverlap('queue', false)).toBe('run')
  })
})

describe('nextAttemptDelayMs (AC-8)', () => {
  it('first retry — exactly backoff', () => {
    expect(nextAttemptDelayMs(1, 30)).toBe(30_000)
  })

  it('backoff grows (exponentially), not linear-zero', () => {
    const d1 = nextAttemptDelayMs(1, 30)
    const d2 = nextAttemptDelayMs(2, 30)
    const d3 = nextAttemptDelayMs(3, 30)
    expect(d2).toBeGreaterThan(d1)
    expect(d3).toBeGreaterThan(d2)
    expect(d2).toBe(60_000)
    expect(d3).toBe(120_000)
  })

  it('backoff 0 → no delay (the developer turned waiting off)', () => {
    expect(nextAttemptDelayMs(1, 0)).toBe(0)
    expect(nextAttemptDelayMs(3, 0)).toBe(0)
  })
})
