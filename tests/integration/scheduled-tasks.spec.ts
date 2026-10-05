// RED. Harness as in
// tests/integration/custom-tasks.spec.ts: service-role client against the live DB,
// no HTTP to :3000 (the HTTP gate layer is covered by tests/tasks/guard.spec.ts —
// a source scan; panel rendering — a screenshot, verified by observation).
//
// Prerequisites: the stack is up, migration 0018 is applied, and for the runtime
// part the runner containers are up:
//   docker compose … up -d runner-python312 runner-node22
// Modules services/task-runner, services/task-scheduler, repositories/tasks,
// repositories/task-artifacts do not exist yet → the suite fails on import.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { encryptToBytea } from '../../server/services/credentials'
import { hasRole } from '../../server/utils/rbac'
import { createTask, createTrigger, dueTriggers, removeTask, updateTask } from '../../server/repositories/tasks'
import { listArtifacts, pruneArtifactsOlderThan } from '../../server/repositories/task-artifacts'
import { parseRunnerRegistry, runTask } from '../../server/services/task-runner'
import { dispatchDueTriggers } from '../../server/services/task-scheduler'
import { rerun, runHook } from '../../server/services/tasks'

const url = process.env.SUPABASE_URL!
const service = createClient(url, process.env.SUPABASE_SERVICE_KEY!)
const KEY = process.env.NUXT_CRED_ENCRYPTION_KEY!

// Runner topology = data (amended 2026-08-13). "Now" — one image
// (the extended `executor`) carries both runtimes, so both keys point at
// the same URL; the test does not know this detail — it only passes the registry.
const runners = {
  registry: parseRunnerRegistry(
    process.env.NUXT_TASK_RUNNERS
    // `/run-task` — the streaming task endpoint; `/run` stays the legacy contract
    // of device local commands, and we do NOT touch it.
    ?? '{"python312":"http://127.0.0.1:8090/run-task","node22":"http://127.0.0.1:8090/run-task"}',
  ),
  secret: process.env.NUXT_EXECUTOR_SECRET ?? process.env.EXECUTOR_SHARED_SECRET ?? '',
}

const PREFIX = '__sched_test__'
const cleanupTasks: string[] = []
const cleanupSets: string[] = []

let seq = 0
const baseTask = (over: Record<string, unknown> = {}) => ({
  name: `${PREFIX}${++seq}_${process.pid}`,
  runtime: 'python312',
  entrypoint: 'main.py',
  files: { 'main.py': 'print("hello")' },
  deps: '',
  env: {},
  cred_refs: [],
  timeout_s: 60,
  retries: 0,
  backoff_s: 0,
  overlap_policy: 'skip',
  min_role: 'operator',
  enabled: true,
  ...over,
})

const runOf = async (taskId: string) => {
  const { data } = await service.from('task_run')
    .select('id,status,phase,log,attempt,device_id,result,error,input')
    .eq('task_id', taskId).order('started_at', { ascending: false })
  return data ?? []
}

afterAll(async () => {
  try {
    for (const id of cleanupTasks) await removeTask(service, id)
    for (const id of cleanupSets) await service.from('credential_sets').delete().eq('id', id)
    await service.from('task_run').delete().like('label', `${PREFIX}%`)
  }
  catch { /* best-effort cleanup */ }
})

describe('scheduled-tasks: a task without a device (AC-1)', () => {
  it('runs_task_without_any_device', async () => {
    const task = await createTask(service, baseTask())
    cleanupTasks.push(task.id)

    const res = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })

    expect(res.status).toBe('done')
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('hello')

    const [row] = await runOf(task.id)
    expect(row).toBeDefined()
    expect(row!.device_id).toBeNull() // no fake device (the goal of the feature)
    expect(row!.status).toBe('done')
  }, 90_000)
})

describe('scheduled-tasks: environments and cache (AC-2, AC-3)', () => {
  it('first_run_prepares_env_second_run_skips_cached', async () => {
    const task = await createTask(service, baseTask({
      deps: 'openpyxl==3.1.5',
      files: { 'main.py': 'import openpyxl; print("openpyxl", openpyxl.__version__)' },
      timeout_s: 300,
    }))
    cleanupTasks.push(task.id)

    // `rebuildEnv` on the first run makes the test independent of volume state:
    // the cache survives restarts and earlier runs, so "first" ≠ "cold".
    const first = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners, rebuildEnv: true })
    expect(first.status).toBe('done')
    expect(first.stdout).toContain('openpyxl') // the package import does not fail
    expect(first.phases.map(p => p.phase)).toContain('preparing_env')

    const second = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })
    expect(second.status).toBe('done')
    expect(second.phases.map(p => p.phase)).not.toContain('preparing_env') // cache
  }, 180_000)

  it('deps_change_creates_new_env', async () => {
    // The marker comment makes deps unique for every suite run: the cache
    // lives on a volume, so without it the "new environment" would already be
    // ready from an earlier test run. pip ignores comments — same behaviour.
    const marker = `# ${PREFIX}${Date.now()}`
    const task = await createTask(service, baseTask({
      deps: `six==1.16.0\n${marker}`,
      files: { 'main.py': 'import six; print(six.__version__)' },
      timeout_s: 300,
    }))
    cleanupTasks.push(task.id)

    const a = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })
    const changed = await updateTask(service, task.id, { deps: `six==1.17.0\n${marker}` })
    const b = await runTask(service, { task: changed, actor: `${PREFIX}actor`, keyHex: KEY, runners })

    expect(a.status).toBe('done')
    expect(b.status).toBe('done')
    expect(a.envKey).not.toBe(b.envKey) // a new environment for new deps
    expect(b.phases.map(p => p.phase)).toContain('preparing_env')

    // "The old one stays": going back to the previous deps does not prepare the environment again.
    const back = await runTask(service, {
      task: await updateTask(service, task.id, { deps: `six==1.16.0\n${marker}` }),
      actor: `${PREFIX}actor`,
      keyHex: KEY,
      runners,
    })
    expect(back.envKey).toBe(a.envKey)
    expect(back.phases.map(p => p.phase)).not.toContain('preparing_env')
  }, 120_000)

  it('rebuild_env_forces_reinstall with unchanged deps', async () => {
    const task = await createTask(service, baseTask({ deps: 'six==1.16.0', timeout_s: 300 }))
    cleanupTasks.push(task.id)

    const warm = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })
    const forced = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners, rebuildEnv: true })

    expect(forced.envKey).toBe(warm.envKey) // the same key…
    expect(forced.phases.map(p => p.phase)).toContain('preparing_env') // …but a reinstall
  }, 180_000)
})

describe('scheduled-tasks: multiple files and runtimes (AC-4, AC-5)', () => {
  it('multifile_task_runs_entrypoint_and_imports_sibling', async () => {
    const task = await createTask(service, baseTask({
      entrypoint: 'main.py',
      files: { 'main.py': 'from helper import greet\nprint(greet())', 'helper.py': 'def greet():\n    return "from-sibling"' },
    }))
    cleanupTasks.push(task.id)

    const res = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })
    expect(res.status).toBe('done')
    expect(res.stdout).toContain('from-sibling')
  }, 90_000)

  it('two_runtimes_route_to_own_runner', async () => {
    const py = await createTask(service, baseTask({ runtime: 'python312', entrypoint: 'main.py', files: { 'main.py': 'import sys; print(sys.version_info[0], sys.version_info[1])' } }))
    const node = await createTask(service, baseTask({ runtime: 'node22', entrypoint: 'main.js', files: { 'main.js': 'console.log(process.versions.node)' } }))
    cleanupTasks.push(py.id, node.id)

    const pyRes = await runTask(service, { task: py, actor: `${PREFIX}actor`, keyHex: KEY, runners })
    const nodeRes = await runTask(service, { task: node, actor: `${PREFIX}actor`, keyHex: KEY, runners })

    expect(pyRes.stdout).toContain('3 12')
    expect(nodeRes.stdout).toMatch(/^22\./m)
  }, 90_000)
})

describe('scheduled-tasks: schedule (AC-6)', () => {
  it('disabled_trigger_not_dispatched', async () => {
    const task = await createTask(service, baseTask())
    cleanupTasks.push(task.id)
    const past = new Date(Date.now() - 60_000)
    await createTrigger(service, { task_id: task.id, kind: 'cron', cron: '*/5 * * * *', next_run_at: past.toISOString(), enabled: false })

    const due = await dueTriggers(service, new Date())
    expect(due.some(t => t.task_id === task.id)).toBe(false)

    await dispatchDueTriggers(service, { now: new Date(), keyHex: KEY, runners })
    expect(await runOf(task.id)).toHaveLength(0)
  }, 90_000)

  it('an invalid cron is not saved (gate on write)', async () => {
    const task = await createTask(service, baseTask())
    cleanupTasks.push(task.id)
    await expect(createTrigger(service, { task_id: task.id, kind: 'cron', cron: '* * *', next_run_at: new Date().toISOString(), enabled: true }))
      .rejects.toThrow()
  }, 60_000)
})

describe('scheduled-tasks: overlap, retries, timeout (AC-7, AC-8, AC-9)', () => {
  it('skip_is_recorded_not_silent', async () => {
    const task = await createTask(service, baseTask({ overlap_policy: 'skip', files: { 'main.py': 'import time; time.sleep(10)' }, timeout_s: 60 }))
    cleanupTasks.push(task.id)

    // An unfinished run "in flight".
    const inFlight = runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })
    await new Promise(r => setTimeout(r, 1500))
    const second = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })

    expect(second.status).toBe('skipped')
    const rows = await runOf(task.id)
    expect(rows.some(r => r.status === 'skipped')).toBe(true) // visible in the log, not silent
    await inFlight
  }, 90_000)

  it('failing_task_retries_and_records_attempt', async () => {
    const task = await createTask(service, baseTask({ retries: 2, backoff_s: 0, files: { 'main.py': 'import sys; sys.exit(7)' } }))
    cleanupTasks.push(task.id)

    await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })
    const rows = await runOf(task.id)
    expect(Math.max(...rows.map(r => r.attempt ?? 0))).toBe(3) // the first + 2 retries
  }, 90_000)

  it('timeout_marks_failed_with_reason', async () => {
    const task = await createTask(service, baseTask({ timeout_s: 2, files: { 'main.py': 'import time; time.sleep(30)' } }))
    cleanupTasks.push(task.id)

    const res = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })
    expect(res.status).toBe('failed')
    expect(res.error).toBe('timeout')

    const [row] = await runOf(task.id)
    expect(row!.status).toBe('failed') // does not hang in running
  }, 60_000)
})

describe('scheduled-tasks: artifacts (AC-11)', () => {
  it('output_file_downloadable', async () => {
    const task = await createTask(service, baseTask({
      files: { 'main.py': 'import os\nopen(os.path.join(os.environ["RUN_OUTPUT"], "report.txt"), "w").write("payload-body")' },
    }))
    cleanupTasks.push(task.id)

    const res = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })
    expect(res.status).toBe('done')

    const arts = await listArtifacts(service, res.runId)
    expect(arts.map(a => a.path.split('/').pop())).toContain('report.txt')

    const dl = await service.storage.from('task-artifacts').download(arts[0]!.path)
    expect(await dl.data!.text()).toContain('payload-body')
  }, 60_000)

  it('retention_prunes_artifact', async () => {
    const task = await createTask(service, baseTask({
      files: { 'main.py': 'import os\nopen(os.path.join(os.environ["RUN_OUTPUT"], "old.txt"), "w").write("x")' },
    }))
    cleanupTasks.push(task.id)
    const res = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })

    await pruneArtifactsOlderThan(service, 0) // retention 0 days = delete everything
    expect(await listArtifacts(service, res.runId)).toHaveLength(0)
  }, 60_000)
})

describe('scheduled-tasks: the secret is masked in the stored run (AC-12)', () => {
  it('injected_secret_redacted_in_task_run', async () => {
    const { data: set } = await service.from('credential_sets')
      .insert({ name: `${PREFIX}set`, username: 'api', password_enc: encryptToBytea('super-secret-xyz', KEY), port: null })
      .select('id').single()
    cleanupSets.push(set!.id)

    const task = await createTask(service, baseTask({
      cred_refs: [{ set_id: set!.id, env: 'API' }],
      files: { 'main.py': 'import os; print("key=" + os.environ["API_PASSWORD"])' },
    }))
    cleanupTasks.push(task.id)

    const res = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })
    expect(res.stdout).not.toContain('super-secret-xyz')
    expect(res.stdout).toContain('[REDACTED]')

    // Channels #2 and #3: what is stored in the DB (result + log) is also secret-free.
    const [row] = await runOf(task.id)
    expect(JSON.stringify(row!.result)).not.toContain('super-secret-xyz')
    expect(row!.log ?? '').not.toContain('super-secret-xyz')
  }, 60_000)
})

describe('scheduled-tasks: webhook trigger (AC-13, AC-14, AC-15)', () => {
  let taskId: string
  let token: string

  beforeAll(async () => {
    const task = await createTask(service, baseTask({
      // 'queue', not 'skip': skipping a webhook event = losing it. Runs
      // of the same task go one after another (see `enqueue` in task-runner).
      overlap_policy: 'queue',
      files: { 'main.py': 'import json, os\nprint(json.load(open(os.environ["RUN_PAYLOAD_FILE"]))["user"])' },
    }))
    taskId = task.id
    cleanupTasks.push(task.id)
    const trig = await createTrigger(service, { task_id: task.id, kind: 'webhook', sync: false, enabled: true })
    token = trig.token! // the raw token is issued ONLY once, at creation
  })

  it('hook_valid_token_runs + hook_bad_token_401', async () => {
    const { runHook } = await import('../../server/services/tasks')

    const ok = await runHook(service, { token, payload: { user: 'alice' }, keyHex: KEY, runners })
    expect(ok.status).toBe(202)
    expect(ok.runId).toBeTruthy()

    await expect(runHook(service, { token: 'not-a-real-token', payload: {}, keyHex: KEY, runners }))
      .rejects.toMatchObject({ statusCode: 401 })
  }, 60_000)

  it('hook_idempotency_key_no_second_run', async () => {
    const { runHook } = await import('../../server/services/tasks')
    const before = (await runOf(taskId)).length

    const a = await runHook(service, { token, payload: { user: 'bob' }, idempotencyKey: 'k-1', keyHex: KEY, runners })
    const b = await runHook(service, { token, payload: { user: 'bob' }, idempotencyKey: 'k-1', keyHex: KEY, runners })

    expect(b.runId).toBe(a.runId) // the same run, not a second one
    expect((await runOf(taskId)).length).toBe(before + 1)
  }, 60_000)

  it('payload_available_as_RUN_PAYLOAD_FILE + rerun_uses_same_payload', async () => {
    const { rerun, runHook } = await import('../../server/services/tasks')

    const hook = await runHook(service, { token, payload: { user: 'carol' }, sync: true, keyHex: KEY, runners })
    expect(hook.stdout).toContain('carol') // the payload reached the script as a file

    const again = await rerun(service, { runId: hook.runId, actor: `${PREFIX}actor`, keyHex: KEY, runners })
    expect(again.stdout).toContain('carol') // re-run on the same data
  }, 90_000)

  it('hook_rate_limit_returns_429', async () => {
    const { runHook } = await import('../../server/services/tasks')
    const codes: number[] = []
    for (let i = 0; i < 30; i++) {
      try {
        const r = await runHook(service, { token, payload: { user: `u${i}` }, keyHex: KEY, runners })
        codes.push(r.status)
      }
      catch (e: unknown) {
        codes.push((e as { statusCode: number }).statusCode)
      }
    }
    expect(codes).toContain(429) // a ceiling, not an unbounded queue
  }, 120_000)
})

describe('scheduled-tasks: misfire after downtime (AC-17)', () => {
  it('overdue_trigger_runs_exactly_once_marked_late', async () => {
    const task = await createTask(service, baseTask())
    cleanupTasks.push(task.id)
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000)
    await createTrigger(service, { task_id: task.id, kind: 'cron', cron: '*/5 * * * *', next_run_at: fourHoursAgo.toISOString(), misfire_policy: 'run', enabled: true })

    await dispatchDueTriggers(service, { now: new Date(), keyHex: KEY, runners })

    const rows = await runOf(task.id)
    expect(rows).toHaveLength(1) // exactly one, not 48 missed slots
    expect((rows[0]!.result as { late?: boolean } | null)?.late).toBe(true)

    const { data: trig } = await service.from('task_triggers').select('next_run_at').eq('task_id', task.id).single()
    expect(new Date(trig!.next_run_at).getTime()).toBeGreaterThan(Date.now()) // time — from now
  }, 90_000)

  it('misfire skip: an overdue slot only moves the time', async () => {
    const task = await createTask(service, baseTask())
    cleanupTasks.push(task.id)
    await createTrigger(service, { task_id: task.id, kind: 'cron', cron: '*/5 * * * *', next_run_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), misfire_policy: 'skip', enabled: true })

    await dispatchDueTriggers(service, { now: new Date(), keyHex: KEY, runners })

    expect(await runOf(task.id)).toHaveLength(0)
    const { data: trig } = await service.from('task_triggers').select('next_run_at').eq('task_id', task.id).single()
    expect(new Date(trig!.next_run_at).getTime()).toBeGreaterThan(Date.now())
  }, 60_000)
})

describe('scheduled-tasks: run visibility (AC-16)', () => {
  it('run_gate_uses_min_role: an admin task is refused to an operator', async () => {
    const adminTask = await createTask(service, baseTask({ min_role: 'admin' }))
    const opTask = await createTask(service, baseTask({ min_role: 'operator' }))
    cleanupTasks.push(adminTask.id, opTask.id)

    expect(hasRole('operator', opTask.min_role)).toBe(true)
    expect(hasRole('operator', adminTask.min_role)).toBe(false)
    expect(hasRole('admin', adminTask.min_role)).toBe(true)
  }, 60_000)

  it('operator_sees_own_admin_sees_all_runs: admin sees a scheduler run', async () => {
    // We check behaviour under a real JWT, not the policy text: pg_catalog
    // (pg_policies) is unreachable through PostgREST, and "read the row" is the criterion.
    // A scheduler run belongs to no user (actor='scheduler'), so
    // before 0015 nobody saw it — exactly what the reissued policy fixes.
    const task = await createTask(service, baseTask())
    cleanupTasks.push(task.id)
    const { data: inserted } = await service.from('task_run').insert({
      kind: 'task', task_id: task.id, actor: 'scheduler', label: `${PREFIX}sched`, status: 'done',
    }).select('id').single()

    // dev@ = admin (migration 0009 seed).
    const asAdmin = createClient(url, process.env.SUPABASE_KEY!)
    const { error: authErr } = await asAdmin.auth.signInWithPassword({
      email: 'dev@smartanykey.local',
      password: 'devpassword123',
    })
    expect(authErr).toBeNull()

    const { data: seen } = await asAdmin.from('task_run')
      .select('id,actor').eq('id', inserted!.id).maybeSingle()
    expect(seen?.actor).toBe('scheduler') // admin reads someone else's run

    // The mirror half (an actor sees only their own) is unchanged since 0005 and covered
    // by `tests/integration/rls.spec.ts`; the admin branch is what matters here.
    await asAdmin.auth.signOut()
  }, 60_000)
})

describe('scheduled-tasks: result receiver (tier Full — webhook-sink)', () => {
  /** A real HTTP receiver: the sink is checked with a live POST, not a fetch mock. */
  async function receiver(): Promise<{ url: string, hits: Record<string, unknown>[], close: () => Promise<void> }> {
    const { createServer } = await import('node:http')
    const hits: Record<string, unknown>[] = []
    const srv = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        hits.push(JSON.parse(body || '{}'))
        res.writeHead(204).end()
      })
    })
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as { port: number }).port
    return {
      url: `http://127.0.0.1:${port}/hook`,
      hits,
      close: () => new Promise<void>(r => srv.close(() => r())),
    }
  }

  it('sink_fires_on_failure_with_summary', async () => {
    const sink = await receiver()
    try {
      const task = await createTask(service, baseTask({
        files: { 'main.py': 'import sys\nsys.exit(3)' },
        sink_url: sink.url,
        sink_on: 'failed',
      }))
      cleanupTasks.push(task.id)

      const res = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })
      expect(res.status).toBe('failed')

      expect(sink.hits).toHaveLength(1)
      expect(sink.hits[0]).toMatchObject({ status: 'failed', exitCode: 3, runId: res.runId })
      // The receiver's failure/success is visible in the run log — where the operator looks.
      const [row] = await runOf(task.id)
      expect(row!.log as string).toContain('[sink] 204')
    }
    finally {
      await sink.close()
    }
  }, 120_000)

  it('sink_on_failed_stays_silent_on_success', async () => {
    const sink = await receiver()
    try {
      const task = await createTask(service, baseTask({ sink_url: sink.url, sink_on: 'failed' }))
      cleanupTasks.push(task.id)

      const res = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })
      expect(res.status).toBe('done')
      expect(sink.hits).toHaveLength(0) // success with sink_on=failed wakes nobody
    }
    finally {
      await sink.close()
    }
  }, 120_000)

  it('a dead receiver does NOT break the run — the task stays done, the failure is in the log', async () => {
    // A port where deliberately nobody listens: the sink is a side effect, not part
    // of the task's success (otherwise "Slack is down" = "backup not done").
    const task = await createTask(service, baseTask({
      sink_url: 'http://127.0.0.1:9/dead',
      sink_on: 'always',
    }))
    cleanupTasks.push(task.id)

    const res = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })
    expect(res.status).toBe('done')

    const [row] = await runOf(task.id)
    expect(row!.log as string).toContain('[sink] FAILED')
  }, 120_000)
})

describe('scheduled-tasks: the call query as the caller data channel (RUN_QUERY)', () => {
  it('hook_query_reaches_task_and_survives_rerun', async () => {
    // Born from a developer question: one shared notifier, different chats for different
    // tasks — the task had no way to know which chat to write to. Now it is `?chat=…`
    // in the trigger's own URL, and the payload body stays the caller's body.
    const task = await createTask(service, baseTask({
      files: { 'main.py': 'import os, json\nq = json.loads(os.environ.get("RUN_QUERY", "{}"))\nprint("chat:", q.get("chat"))\nprint("payload:", open(os.environ["RUN_PAYLOAD_FILE"]).read())' },
    }))
    cleanupTasks.push(task.id)
    const trigger = await createTrigger(service, { task_id: task.id, kind: 'webhook', sync: true })

    const res = await runHook(service, {
      token: trigger.token!,
      payload: { status: 'failed', task: { name: 'upstream' } },
      keyHex: KEY,
      runners,
      query: { chat: '-1001234567890' },
      sync: true,
    })

    expect(res.stdout).toContain('chat: -1001234567890')
    expect(res.stdout).toContain('{"status":"failed"') // the body is verbatim, query does not mutate it
    expect(res.stdout).toContain('upstream')

    // A re-run must go to the same chat — otherwise "repeat" would send it elsewhere.
    const again = await rerun(service, { runId: res.runId, actor: `${PREFIX}actor`, keyHex: KEY, runners })
    expect(again.stdout).toContain('chat: -1001234567890')
  }, 120_000)
})

describe('scheduled-tasks: the SENDER data channel ($RUN_DATA_FILE → sink.data)', () => {
  it('task_data_reaches_next_task_through_sink', async () => {
    // A developer question: "the first task generates some data that must be passed
    // to the next one". Channel: the task writes JSON to $RUN_DATA_FILE → it lands in
    // task_run.result.data and in the sink body under the `data` key.
    const { createServer } = await import('node:http')
    const hits: Record<string, unknown>[] = []
    const srv = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => { hits.push(JSON.parse(body || '{}')); res.writeHead(204).end() })
    })
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as { port: number }).port

    try {
      const task = await createTask(service, baseTask({
        files: { 'main.py': 'import json, os\njson.dump({"usersSynced": 42, "batch": "b-7"}, open(os.environ["RUN_DATA_FILE"], "w"))\nprint("done")' },
        sink_url: `http://127.0.0.1:${port}/next`,
        sink_on: 'always',
      }))
      cleanupTasks.push(task.id)

      const res = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })
      expect(res.status).toBe('done')
      expect(res.data).toEqual({ usersSynced: 42, batch: 'b-7' })

      // The receiver (the next task) sees the sender's fields, not mixed with ours.
      expect(hits).toHaveLength(1)
      expect(hits[0]!.data).toEqual({ usersSynced: 42, batch: 'b-7' })
      expect(hits[0]!.status).toBe('done')

      // And the same thing is stored in the run — panel/log show the same fact.
      const [row] = await runOf(task.id)
      expect((row!.result as { data?: unknown }).data).toEqual({ usersSynced: 42, batch: 'b-7' })
    }
    finally {
      await new Promise<void>(r => srv.close(() => r()))
    }
  }, 120_000)

  it('broken JSON in the data file does not fail the run, but is visible in the log', async () => {
    const task = await createTask(service, baseTask({
      files: { 'main.py': 'import os\nopen(os.environ["RUN_DATA_FILE"], "w").write("{oops")\nprint("ok")' },
    }))
    cleanupTasks.push(task.id)

    const res = await runTask(service, { task, actor: `${PREFIX}actor`, keyHex: KEY, runners })
    expect(res.status).toBe('done') // the task finished — this is not its error
    expect(res.data).toBeNull()

    const [row] = await runOf(task.id)
    expect(row!.log as string).toContain('not valid JSON')
  }, 120_000)
})
