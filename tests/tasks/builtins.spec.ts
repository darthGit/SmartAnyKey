// ADR-018 amendment No. 4.
// A built-in action is run by the BFF itself: `pg_dump` is in the `app` image and
// not in the executor image. We test the execution step apart from the DB — what
// holds true without the stack: the built-in registry, success, failure with a
// reason, timeout.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BUILTINS, builtinPatchViolation, resolveBuiltin, runBuiltinScript } from '../../server/services/task-builtins'

const dir = mkdtempSync(join(tmpdir(), 'sak-builtin-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const script = (name: string, body: string) => {
  const p = join(dir, name)
  writeFileSync(p, body)
  return p
}

describe('built-in action registry', () => {
  it('backup_is_registered: backup is in the registry and points at an existing script', () => {
    expect(Object.keys(BUILTINS)).toContain('backup')
    expect(resolveBuiltin('backup').script).toMatch(/backup\.mjs$/)
  })

  it('unknown_builtin_names_the_known_ones: unknown key → an error listing the known ones', () => {
    // A DB row with a foreign `builtin` must not fail as undefined somewhere deeper.
    expect(() => resolveBuiltin('rm-rf')).toThrow(/rm-rf/)
    expect(() => resolveBuiltin('rm-rf')).toThrow(/backup/)
  })
})

describe('running a built-in action', () => {
  it('success_maps_to_exit_0_with_stdout: success → end event, exit 0, stdout collected', async () => {
    const p = script('ok.mjs', 'console.log("dump ready")\n')
    const phases: string[] = []
    const logs: string[] = []
    const end = await runBuiltinScript(p, {
      env: {},
      timeoutMs: 30_000,
      onEvent: (e) => {
        if (e.type === 'phase' && e.phase) phases.push(e.phase)
        if (e.type === 'log' && e.data) logs.push(e.data)
      },
    })
    expect(end.type).toBe('end')
    expect(end.exit).toBe(0)
    expect(end.stdout).toContain('dump ready')
    expect(phases).toContain('running')
    // The log must stream as events, not only sit in the final one: the panel shows
    // the tail during the run (ADR-018 — detail polling), so without these events
    // a long backup would look like "nothing is happening".
    expect(logs.join('')).toContain('dump ready')
  })

  it('failure_carries_the_reason: failure → exit≠0 AND the reason text, not a silent success', async () => {
    // An unavailable BACKUP_DIR must produce a failed run with a reason.
    // The backup script prints the reason to stderr and exits 1.
    const p = script('fail.mjs', 'console.error("backup: BACKUP_DIR is not set")\nprocess.exit(1)\n')
    const end = await runBuiltinScript(p, { env: {}, timeoutMs: 30_000 })
    expect(end.exit).toBe(1)
    expect(end.stderr).toContain('BACKUP_DIR')
  })

  it('env_reaches_the_script: the destination comes from the app process env', async () => {
    const p = script('env.mjs', 'console.log(process.env.BACKUP_DIR ?? "—")\n')
    const end = await runBuiltinScript(p, { env: { BACKUP_DIR: '/srv/backups' }, timeoutMs: 30_000 })
    expect(end.stdout).toContain('/srv/backups')
  })

  it('timeout_is_marked_not_hidden: the time ceiling kills the process and marks the run', async () => {
    const p = script('hang.mjs', 'setTimeout(() => {}, 60_000)\n')
    const end = await runBuiltinScript(p, { env: {}, timeoutMs: 700 })
    expect(end.timedOut).toBe(true)
    expect(end.exit).not.toBe(0)
  })
})

describe('a built-in row is protected from body edits', () => {
  const builtin = { builtin: 'backup' }
  const ordinary = { builtin: null }

  it('ordinary_task_is_untouched: a body patch is not restricted for an ordinary task', () => {
    expect(builtinPatchViolation(ordinary, { files: { 'main.py': '' }, runtime: 'python312' })).toBeNull()
  })

  it('toggles_and_schedule_stay_editable: toggle, env and time ceiling stay editable', () => {
    expect(builtinPatchViolation(builtin, { enabled: true })).toBeNull()
    expect(builtinPatchViolation(builtin, { env: { BACKUP_KEEP: '14' }, timeout_s: 1800 })).toBeNull()
  })

  it('body_fields_are_rejected_by_name: an attempt to rewrite the body → a rejection naming what exactly', () => {
    // A built-in action's body is our code, not data: replacing `files` would turn
    // "backup" into an arbitrary script under the same name and the same rights.
    expect(builtinPatchViolation(builtin, { files: { 'x.sh': 'rm -rf /' } })).toContain('files')
    expect(builtinPatchViolation(builtin, { runtime: 'bash' })).toContain('runtime')
    expect(builtinPatchViolation(builtin, { builtin: 'other' })).toContain('builtin')
  })
})
