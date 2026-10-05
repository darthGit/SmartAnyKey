// RED. Pure parts of the task executor: definition validation (zod at the
// boundary), env assembly and output masking.
// Module server/services/task-runner.ts does not exist yet → the suite fails.
//
// List every observation channel: this feature has more channels than
// custom-tasks — besides stdout/stderr there is `task_run.log` (a truncated
// tail that is written to the DB). Masking must cover all three, otherwise the
// operator sees the secret in the log instead of the output.
import { describe, expect, it } from 'vitest'
import { buildTaskEnv, makeTaskPatchSchema, makeTaskSchema, maskRun, parseRunnerRegistry, runnerUrl, shouldNotifySink, sinkPayload } from '../../server/services/task-runner'

// The runtime list is installation data (the `NUXT_TASK_RUNNERS` registry), not a
// constant in code (amended 2026-08-13). The test takes whatever list is "configured".
const RUNTIMES = ['python312', 'node22']
const taskSchema = makeTaskSchema(RUNTIMES)

const validTask = {
  name: 'Sync users',
  runtime: 'python312',
  entrypoint: 'main.py',
  files: { 'main.py': 'print(1)', 'lib.py': 'X = 1' },
  deps: 'openpyxl==3.1.5',
  env: { API_URL: 'https://example.invalid' },
  // A valid v4 (like `gen_random_uuid()`): version nibble 4, variant nibble 8-b.
  // A made-up "1111-…-1111" is rightly rejected by zod 4 — wrong variant bits.
  cred_refs: [{ set_id: '3f1c9a52-7b64-4e0a-9d3f-2b8c1d5e7a90', env: 'API' }],
  timeout_s: 600,
  retries: 2,
  backoff_s: 30,
  overlap_policy: 'skip',
  min_role: 'operator',
  enabled: true,
}

describe('taskSchema — runtimes (AC-5)', () => {
  it('accepts the runtimes configured in this installation', () => {
    for (const runtime of RUNTIMES)
      expect(taskSchema.safeParse({ ...validTask, runtime }).success, runtime).toBe(true)
  })

  it('unknown_runtime_rejected_by_schema: a runtime the installation lacks is not saved', () => {
    expect(taskSchema.safeParse({ ...validTask, runtime: 'ruby33' }).success).toBe(false)
    expect(taskSchema.safeParse({ ...validTask, runtime: '' }).success).toBe(false)
  })

  it('a new runner type (ansible) is valid without a code change — registry only', () => {
    // The seam option C was chosen for: another runner type/version = a line in
    // config + an image with its own recipes.json. No enum, no migration.
    const withAnsible = makeTaskSchema([...RUNTIMES, 'ansible'])
    const play = { ...validTask, runtime: 'ansible', entrypoint: 'site.yml', files: { 'site.yml': '- hosts: all' } }

    expect(withAnsible.safeParse(play).success).toBe(true)
    // …and the same task is invalid where no ansible runner is up.
    expect(taskSchema.safeParse(play).success).toBe(false)
  })
})

describe('taskSchema — definition integrity (AC-4)', () => {
  it('entrypoint must be among the files — otherwise the task cannot run', () => {
    expect(taskSchema.safeParse({ ...validTask, entrypoint: 'nope.py' }).success).toBe(false)
  })

  it('an empty file set is invalid', () => {
    expect(taskSchema.safeParse({ ...validTask, files: {} }).success).toBe(false)
  })

  it('timeout_s and retries within sane bounds', () => {
    expect(taskSchema.safeParse({ ...validTask, timeout_s: 0 }).success).toBe(false)
    expect(taskSchema.safeParse({ ...validTask, retries: -1 }).success).toBe(false)
  })

  it('overlap_policy and min_role — from the list only', () => {
    expect(taskSchema.safeParse({ ...validTask, overlap_policy: 'wait' }).success).toBe(false)
    expect(taskSchema.safeParse({ ...validTask, min_role: 'viewer' }).success).toBe(false)
  })
})

describe('taskPatchSchema — editing a subset (the enabled toggle)', () => {
  const patchSchema = makeTaskPatchSchema(RUNTIMES)

  it('patch_enabled_only_touches_enabled: no foreign keys in the output', () => {
    // The main trap: `.partial()` does not cancel `.default()`, so a patch built from
    // default fields would add `deps:''`/`env:{}`/`cred_refs:[]` — and the `enabled`
    // toggle would wipe the task's dependencies and variables.
    const out = patchSchema.parse({ enabled: false })
    expect(Object.keys(out)).toEqual(['enabled'])
  })

  it('a partial change of one field is valid without the rest of the definition', () => {
    expect(patchSchema.safeParse({ timeout_s: 120 }).success).toBe(true)
    expect(patchSchema.safeParse({ name: 'Renamed' }).success).toBe(true)
  })

  it('an unknown runtime is rejected in a patch too', () => {
    expect(patchSchema.safeParse({ runtime: 'ruby33' }).success).toBe(false)
    expect(patchSchema.safeParse({ runtime: 'node22' }).success).toBe(true)
  })

  it('entrypoint+files together — the invariant holds; separately it is left to the 0015 CHECK', () => {
    expect(patchSchema.safeParse({ entrypoint: 'nope.py', files: { 'main.py': 'x' } }).success).toBe(false)
    expect(patchSchema.safeParse({ entrypoint: 'nope.py' }).success).toBe(true)
    expect(patchSchema.safeParse({ files: {} }).success).toBe(false)
  })
})

describe('buildTaskEnv (AC-1, AC-12, AC-14)', () => {
  const secrets = { API: { username: 'api', password: 'super-secret-key', port: 8443 } }

  it('AC-1: a task without a device — no DEVICE_* variables', () => {
    const env = buildTaskEnv({ task: validTask, secrets: {} })
    expect(Object.keys(env).some(k => k.startsWith('DEVICE_'))).toBe(false)
  })

  it('non-secret task env passes through verbatim', () => {
    const env = buildTaskEnv({ task: validTask, secrets: {} })
    expect(env.API_URL).toBe('https://example.invalid')
  })

  it('a set expands into PREFIX_USER / PREFIX_PASSWORD / PREFIX_PORT (ADR-009 amendment)', () => {
    const env = buildTaskEnv({ task: validTask, secrets })
    expect(env.API_USER).toBe('api')
    expect(env.API_PASSWORD).toBe('super-secret-key')
    expect(env.API_PORT).toBe('8443')
  })

  it('empty set fields are not injected (ADR-009 amendment)', () => {
    const env = buildTaskEnv({
      task: validTask,
      secrets: { API: { username: 'api', password: 'p', port: null } },
    })
    expect('API_PORT' in env).toBe(false)
  })

  it('AC-14: a small payload is duplicated into env as RUN_PAYLOAD', () => {
    const env = buildTaskEnv({ task: validTask, secrets: {}, payloadInline: '{"user":"ok"}' })
    expect(env.RUN_PAYLOAD).toBe('{"user":"ok"}')
  })

  it('a large payload — no env duplicate (only the runner file remains)', () => {
    const env = buildTaskEnv({ task: validTask, secrets: {} })
    expect('RUN_PAYLOAD' in env).toBe(false)
  })

  it('query_of_the_call_arrives_as_RUN_QUERY: caller data kept apart from the body', () => {
    // The origin case: one shared notifier and different chats for different
    // tasks. The sink body is our summary, the chat is the task author's metadata,
    // so the channels must differ (otherwise we would mutate someone else's payload).
    const env = buildTaskEnv({
      task: validTask,
      secrets: {},
      payloadInline: '{"status":"failed"}',
      query: { chat: '-1001234567890', severity: 'high' },
    })
    expect(JSON.parse(env.RUN_QUERY!)).toEqual({ chat: '-1001234567890', severity: 'high' })
    expect(env.RUN_PAYLOAD).toBe('{"status":"failed"}') // the body is untouched
  })

  it('an empty query injects no variable at all', () => {
    expect('RUN_QUERY' in buildTaskEnv({ task: validTask, secrets: {} })).toBe(false)
    expect('RUN_QUERY' in buildTaskEnv({ task: validTask, secrets: {}, query: {} })).toBe(false)
  })

  it('the BFF does not invent per-job dir paths — the runner injects them', () => {
    // Contract (verified live 2026-08-13): `RUN_OUTPUT`/`RUN_PAYLOAD_FILE` are
    // set by the harness, because only it knows the job's directory. If the BFF
    // set them, parallel runs would share one directory.
    const env = buildTaskEnv({ task: validTask, secrets, payloadInline: '{}' })
    expect('RUN_OUTPUT' in env).toBe(false)
    expect('RUN_PAYLOAD_FILE' in env).toBe(false)
  })
})

describe('maskRun (AC-12) — all three observation channels', () => {
  const secrets = ['super-secret-key']

  it('masks_secret_in_stdout_stderr_and_log', () => {
    const masked = maskRun({
      stdout: 'key=super-secret-key ok\n',
      stderr: 'traceback: auth super-secret-key failed\n',
      log: 'preparing env\nkey=super-secret-key\n',
    }, secrets)

    for (const [channel, text] of Object.entries(masked)) {
      expect(text, channel).not.toContain('super-secret-key')
      expect(text, channel).toContain('[REDACTED]')
    }
  })

  it('does not mask login and port — they are not secret (ADR-009 amendment)', () => {
    const masked = maskRun({ stdout: 'user=api port=8443\n', stderr: '', log: '' }, secrets)
    expect(masked.stdout).toContain('api')
    expect(masked.stdout).toContain('8443')
  })

  it('an empty secret list does not break the output', () => {
    const masked = maskRun({ stdout: 'plain\n', stderr: '', log: 'x' }, [])
    expect(masked.stdout).toBe('plain\n')
  })
})

describe('shouldNotifySink / sinkPayload (tier Full — result receiver)', () => {
  const withSink = (over: Record<string, unknown> = {}) =>
    ({ sink_url: 'https://hook.invalid/x', sink_on: 'failed' as const, ...over })

  it('empty sink_url — no notification at all', () => {
    expect(shouldNotifySink({ sink_url: '', sink_on: 'always' }, 'failed')).toBe(false)
  })

  it('sink_on=failed: failures only, success is silent', () => {
    expect(shouldNotifySink(withSink(), 'failed')).toBe(true)
    expect(shouldNotifySink(withSink(), 'done')).toBe(false)
  })

  it('sink_on=always: both success and failure', () => {
    expect(shouldNotifySink(withSink({ sink_on: 'always' }), 'done')).toBe(true)
    expect(shouldNotifySink(withSink({ sink_on: 'always' }), 'failed')).toBe(true)
  })

  it('skipped NEVER notifies — an overlap is not a task result', () => {
    expect(shouldNotifySink(withSink({ sink_on: 'always' }), 'skipped')).toBe(false)
  })

  const failedRun = (over: Record<string, unknown> = {}) => ({
    runId: 'run-1',
    status: 'failed' as const,
    exitCode: 1,
    stdout: 'секретний вивід',
    stderr: 'Traceback:\n  KeyError: user_id\n',
    error: 'exit',
    phases: [],
    envKey: null,
    attempt: 3,
    artifacts: [{ path: 'run-1/out.xlsx', size: 10 }],
    ...over,
  })

  it('the body is a summary without full stdout (the receiver is often a third-party service)', () => {
    const body = sinkPayload({ id: 'task-1', name: 'Sync users' }, failedRun(), '')
    expect(JSON.stringify(body)).not.toContain('секретний вивід')
    expect(body.attempt).toBe(3)
    expect(body.artifacts).toEqual(['run-1/out.xlsx'])
  })

  it('sink_payload_carries_task_data: sender fields under their own key', () => {
    // Developer's case: task A computed something to pass on to task B.
    // Its fields live in `data` and cannot overwrite ours (`status`, `exitCode`).
    const body = sinkPayload(
      { id: 'task-1', name: 'Sync users' },
      failedRun({ data: { usersSynced: 42, status: 'ЦЕ_НЕ_ПЕРЕТРЕ_НАШ_СТАТУС' } }),
      '',
    )
    expect(body.data).toEqual({ usersSynced: 42, status: 'ЦЕ_НЕ_ПЕРЕТРЕ_НАШ_СТАТУС' })
    expect(body.status).toBe('failed')
  })

  it('the task wrote nothing — data exists but is null (stable shape for the receiver)', () => {
    expect(sinkPayload({ id: 't', name: 'n' }, failedRun(), '').data).toBeNull()
  })

  it('stderrTail gives the cause of failure, not just "failed"', () => {
    const body = sinkPayload({ id: 't', name: 'n' }, failedRun(), '')
    expect(body.stderrTail).toContain('KeyError: user_id')
  })

  it('runUrl is added ONLY when the app address is configured (deployment-specific, belongs in config)', () => {
    expect('runUrl' in sinkPayload({ id: 't', name: 'n' }, failedRun(), '')).toBe(false)
    const body = sinkPayload({ id: 't', name: 'n' }, failedRun(), 'https://sak.example/')
    expect(body.runUrl).toBe('https://sak.example/admin/tasks?run=run-1')
  })
})

describe('runnerUrl (AC-5) — routing by registry', () => {
  it('two_runtimes_route_to_own_runner: different URLs — different runners', () => {
    const registry = { python312: 'http://runner-py:8090/run', node22: 'http://runner-node:8090/run' }
    expect(runnerUrl('python312', registry)).toBe(registry.python312)
    expect(runnerUrl('node22', registry)).toBe(registry.node22)
  })

  it('several runtimes on one image — a valid topology (the current state)', () => {
    const oneImage = { python312: 'http://executor:8090/run', node22: 'http://executor:8090/run' }
    expect(runnerUrl('node22', oneImage)).toBe(oneImage.python312)
  })

  it('unknown runtime — an error with the list, not a silent fallback to the first runner', () => {
    const registry = { python312: 'http://executor:8090/run' }
    expect(() => runnerUrl('ruby33', registry)).toThrow(/ruby33/)
    expect(() => runnerUrl('ruby33', {})).toThrow(/none/)
  })
})

describe('parseRunnerRegistry — topology from config (no deployment defaults)', () => {
  it('empty config = no runner (no "python is always there" default)', () => {
    expect(parseRunnerRegistry('')).toEqual({})
    expect(parseRunnerRegistry(undefined)).toEqual({})
  })

  it('reads the runtime→URL map from a string', () => {
    expect(parseRunnerRegistry('{"python312":"http://executor:8090/run-task"}'))
      .toEqual({ python312: 'http://executor:8090/run-task' })
  })

  it('accepts an already parsed object — that is how runtimeConfig arrives', () => {
    // Nuxt runs env through `destr`, so a JSON string in `.env` reaches
    // `runtimeConfig.taskRunners` as an object. A unit test on the string alone missed
    // this path, and the route failed with `raw.trim is not a function` (live run 2026-08-13).
    expect(parseRunnerRegistry({ python312: 'http://executor:8090/run-task' }))
      .toEqual({ python312: 'http://executor:8090/run-task' })
  })

  it('an object with an empty URL is an error too', () => {
    expect(() => parseRunnerRegistry({ python312: '' })).toThrow()
  })

  it('broken JSON and empty URL — an error at startup, not a silent routing hole', () => {
    expect(() => parseRunnerRegistry('{oops')).toThrow()
    expect(() => parseRunnerRegistry('["python312"]')).toThrow()
    expect(() => parseRunnerRegistry('{"python312":""}')).toThrow()
  })
})
