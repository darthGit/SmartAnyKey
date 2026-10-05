// Built-in backup task against a live DB (ADR-018 amendment 4).
// Preconditions: the stack is up, 0018 is applied, pg_dump is on PATH.
//
// The runner registry is passed empty on purpose: a built-in action must not
// depend on `NUXT_TASK_RUNNERS` — a fresh install without any runner
// must be able to back up.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { getTask, listTriggers } from '../../server/repositories/tasks'
import { runTask } from '../../server/services/task-runner'

const service = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const KEY = process.env.NUXT_CRED_ENCRYPTION_KEY!
const runners = { registry: {}, secret: '' }
const ACTOR = '__builtin_test__'
const NAME_RE = /^sak-\d{8}-\d{6}\.sql\.gz$/

let taskId = ''
let dir = ''
const savedDir = process.env.BACKUP_DIR

beforeAll(async () => {
  const { data } = await service.from('tasks').select('id').eq('builtin', 'backup').single()
  taskId = data!.id
  dir = mkdtempSync(join(tmpdir(), 'sak-backup-'))
})

afterAll(async () => {
  await service.from('task_run').delete().eq('actor', ACTOR)
  rmSync(dir, { recursive: true, force: true })
  if (savedDir === undefined)
    delete process.env.BACKUP_DIR
  else
    process.env.BACKUP_DIR = savedDir
})

describe('AC-24: ready-made backup recipe in the scheduler', () => {
  it('seeded_backup_task_is_ready_and_off: the row exists, disabled, admin-only, with a nightly cron', async () => {
    const task = await getTask(service, taskId)
    expect(task!.builtin).toBe('backup')
    // Disabled on purpose: we must not enable writing to the install's disk on the customer's behalf.
    expect(task!.enabled).toBe(false)
    expect(task!.min_role).toBe('admin')

    const triggers = await listTriggers(service, taskId)
    const cron = triggers.filter(t => t.kind === 'cron')
    expect(cron).toHaveLength(1)
    expect(cron[0]!.cron).toBe('0 3 * * *')
    // The trigger is enabled while the task is disabled — so the admin clicks one toggle,
    // not two. Safe by construction: the tick moves the time but does not run
    // a disabled task (`dispatchDueTriggers` checks `task.enabled`).
    expect(cron[0]!.enabled).toBe(true)
    // An overdue slot after enabling must be shifted, not fire a burst.
    expect(cron[0]!.misfire_policy).toBe('skip')
  })
})

describe('AC-18: backup run', () => {
  it('run_creates_a_dump_and_a_visible_run: a file on disk + a run row in the panel', async () => {
    process.env.BACKUP_DIR = dir
    const task = await getTask(service, taskId)

    const res = await runTask(service, { task: task!, actor: ACTOR, keyHex: KEY, runners })

    expect(res.status).toBe('done')
    expect(res.exitCode).toBe(0)
    const made = readdirSync(dir).filter(n => NAME_RE.test(n))
    expect(made).toHaveLength(1)
    expect(res.stdout).toContain(made[0]!)

    // "Visible in the panel" = a task_run row bound to the task (the panel reads it).
    const { data: rows } = await service.from('task_run')
      .select('status,task_id,device_id,label,log').eq('actor', ACTOR).eq('task_id', taskId)
    expect(rows).toHaveLength(1)
    expect(rows![0]!.status).toBe('done')
    expect(rows![0]!.device_id).toBeNull()
    expect(rows![0]!.log ?? '').toContain('MB')
  })

  it('unavailable_dir_fails_with_the_reason: unavailable BACKUP_DIR → a FAILED run, not silence', async () => {
    // A directory cannot live under a file: mkdir throws ENOTDIR — that is the "unavailable
    // destination" without depending on root permissions in the test.
    const made = readdirSync(dir).filter(n => NAME_RE.test(n))
    process.env.BACKUP_DIR = join(dir, made[0]!, 'nested')
    const task = await getTask(service, taskId)

    const res = await runTask(service, { task: task!, actor: ACTOR, keyHex: KEY, runners })

    expect(res.status).toBe('failed')
    expect(res.exitCode).not.toBe(0)
    // The reason, not just "failed": the text shows both the script prefix and the path.
    expect(`${res.stderr}`).toContain('backup:')
    expect(existsSync(process.env.BACKUP_DIR)).toBe(false)
  })
})
