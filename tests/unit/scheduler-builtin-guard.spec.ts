// Defect found by a live run on 2026-09-18: the backup toggle green, the trigger
// alive — and not a single run. `tasks:tick` returned early when
// `NUXT_TASK_RUNNERS` is empty, and it is empty on every standard install
// ("empty = an install that does not use tasks", docker/.env.example). A builtin
// task (ADR-018 amendment 4) needs no runner — the BFF runs the backup itself,
// because pg_dump exists only in the app image.
//
// This is exactly what the check guards against: the proof is a file written,
// not a green toggle.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tick = readFileSync('server/tasks/tasks/tick.ts', 'utf8')
const sched = readFileSync('server/services/task-scheduler.ts', 'utf8')

describe('scheduler does not silently disable builtin tasks (AC-8)', () => {
  it('tick_has_no_early_return_on_empty_runner_registry', () => {
    // This very line disabled the backup: it did not know whether the task was builtin.
    expect(tick).not.toMatch(/if\s*\(!Object\.keys\(runners\.registry\)\.length\)\s*\n?\s*return/)
  })

  it('guard_lives_where_the_task_is_known_and_spares_builtins', () => {
    expect(sched, 'the guard must let built-in tasks through')
      .toMatch(/!task\.builtin\s*&&\s*!Object\.keys\(opts\.runners\.registry\)\.length/)
  })

  it('guard_comes_after_the_task_row_is_loaded', () => {
    const iTask = sched.indexOf('const task = await getTask(')
    const iGuard = sched.indexOf('!task.builtin &&')
    expect(iTask).toBeGreaterThan(-1)
    expect(iGuard, 'a guard without the loaded task again cannot tell the cases apart').toBeGreaterThan(iTask)
  })
})
