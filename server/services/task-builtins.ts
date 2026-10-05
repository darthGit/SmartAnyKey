// Built-in task actions (ADR-018 amendment 2026-09-17 #4).
//
// "Built-in" = executed by the BFF itself in its container, not by a runner. The reason
// was measured, not assumed: backup runs `pg_dump`, which the executor image does
// not have (`which pg_dump psql` → nothing), the postgres 17 client and the `BACKUP_DIR`
// volume live in the `app` image, and ADR-016 deliberately keeps the runner without DB credentials.
//
// The list of built-ins is knowledge about the product (there are exactly as many as we
// wrote), so it lives here, not in the installation config: unlike
// `NUXT_TASK_RUNNERS`, a client cannot add its own action here.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface BuiltinEvent {
  type: 'phase' | 'log' | 'end'
  phase?: string
  stream?: 'stdout' | 'stderr'
  data?: string
  exit?: number | null
  timedOut?: boolean
  durationMs?: number
  stdout?: string
  stderr?: string
}

export interface Builtin {
  /** Absolute path to the script; it is also the documented manual invocation. */
  script: string
}

/** Scripts sit alongside in the image (`WORKDIR /app`, `COPY scripts/`). */
const scriptPath = (name: string) => join(process.cwd(), 'scripts', name)

export const BUILTINS: Record<string, Builtin> = {
  // The same `scripts/backup.mjs` as the manual invocation from the README: rotation,
  // file names and the three-artifact reminder stay ONE piece of code,
  // already guarded by tests.
  backup: { script: scriptPath('backup.mjs') },
}

export function resolveBuiltin(name: string): Builtin {
  const found = BUILTINS[name]
  if (!found) {
    throw new Error(
      `task-builtins: built-in action "${name}" does not exist (available: ${Object.keys(BUILTINS).join(', ')})`,
    )
  }
  return found
}

export interface RunBuiltinOpts {
  /** Extra variables on top of the app process env (where `BACKUP_DIR` comes from). */
  env: Record<string, string>
  timeoutMs: number
  onEvent?: (e: BuiltinEvent) => void
}

/**
 * Runs the script as a subprocess. Returns a final event of the same shape as
 * `callRunner`, so everything around it (the `task_run` row, phases, log tail, masking,
 * retries, sink) works without a single branch.
 */
export async function runBuiltinScript(script: string, opts: RunBuiltinOpts): Promise<BuiltinEvent> {
  if (!existsSync(script))
    throw new Error(`task-builtins: script not found: ${script}`)

  const started = Date.now()
  opts.onEvent?.({ type: 'phase', phase: 'running' })

  return await new Promise<BuiltinEvent>((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      // SIGKILL, not SIGTERM: the script may hang in pg_dump, which ignores a soft
      // signal, and the task's time ceiling must be a ceiling, not a wish.
      child.kill('SIGKILL')
    }, opts.timeoutMs)

    child.stdout.on('data', (d) => {
      const s = String(d)
      stdout += s
      opts.onEvent?.({ type: 'log', stream: 'stdout', data: s })
    })
    child.stderr.on('data', (d) => {
      const s = String(d)
      stderr += s
      opts.onEvent?.({ type: 'log', stream: 'stderr', data: s })
    })

    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        type: 'end',
        // A process killed by timeout yields code=null — the run must be
        // failed, not "exit null", which below would read as success.
        exit: timedOut ? 124 : code,
        timedOut,
        durationMs: Date.now() - started,
        stdout,
        stderr: timedOut ? `${stderr}\ntask-builtins: exceeded the ${opts.timeoutMs} ms limit` : stderr,
      })
    })
  })
}

/**
 * Fields that in a built-in task belong to us, not the admin: swapping `files`
 * would turn "backup" into an arbitrary script under the same name and the same rights,
 * and changing `builtin` — into someone else's action. The toggle, schedule, `env`, ceilings
 * and sink stay available: these are installation settings.
 */
export const BUILTIN_LOCKED_FIELDS = ['builtin', 'runtime', 'entrypoint', 'files', 'deps', 'deps_lock'] as const

/** The rejection reason, or `null` if the patch is allowed. */
export function builtinPatchViolation(
  task: { builtin: string | null },
  patch: Record<string, unknown>,
): string | null {
  if (!task.builtin)
    return null
  const locked = BUILTIN_LOCKED_FIELDS.filter(f => f in patch)
  if (!locked.length)
    return null
  return `built-in task "${task.builtin}": fields ${locked.join(', ')} are set by the product, not by an admin`
}
