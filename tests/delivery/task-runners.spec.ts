// Wider than the backup. Measured 2026-09-21 in a clean room with three arms:
// **an empty `NUXT_TASK_RUNNERS` disables the whole Nitro scheduler** — no
// trigger is claimed, `task_run` is empty, the log is silent; with a non-empty
// one (same image, same DB) — `[tasks:tick] dispatched 1` and a dump file. So
// "empty = an install that does not use tasks" costs the client not only tasks
// but also the backup and `discovery:rescan` (ADR-015).
//
// Hence the template default = what our executor image actually ships. The
// source of truth for the runtime list is `executor/recipes.json`, not this file:
// otherwise a runtime added to the image silently stays unregistered.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const KEY = 'NUXT_TASK_RUNNERS='
const line = readFileSync('docker/.env.example', 'utf8')
  .split('\n').find(l => l.startsWith(KEY))
const value = line?.slice(KEY.length).trim() ?? ''

describe('task runner registry ships non-empty (AC-8)', () => {
  it('env_template_ships_a_registry', () => {
    expect(line, 'docker/.env.example has no NUXT_TASK_RUNNERS').toBeDefined()
    expect(value, 'an empty registry disables the scheduler entirely').not.toBe('')
    expect(() => JSON.parse(value)).not.toThrow()
  })

  it('registry_covers_every_runtime_the_executor_image_ships', () => {
    const recipes = JSON.parse(readFileSync('executor/recipes.json', 'utf8'))
    const shipped = Object.keys(recipes).filter(k => !k.startsWith('_')).sort()
    expect(Object.keys(JSON.parse(value)).sort()).toEqual(shipped)
  })

  it('every_url_targets_run_task_not_legacy_run', () => {
    // Legacy `/run` returns `runner 400: bad interpreter` — a separate endpoint
    // for device local commands (ADR-016), not for tasks.
    for (const [runtime, url] of Object.entries(JSON.parse(value) as Record<string, string>))
      expect(url, runtime).toMatch(/\/run-task$/)
  })
})
