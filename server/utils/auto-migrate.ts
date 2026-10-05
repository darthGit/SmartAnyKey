// Auto-migrations on application start.
//
// Install step 4, which the client used to do by hand (`compose run --rm app node
// scripts/db-migrate.mjs`), goes away: the application applies the schema at start.
// Safe by construction, not by convention — there is exactly one `app` replica
// (ADR-015: the scheduler lives in its process, a second one would double every cron),
// so there are never two migrating processes.
//
// ponytail: a subprocess instead of in-process. `db-migrate.mjs` is already idempotent
// (the `public.schema_migrations` journal by name, `--single-transaction` per file)
// and already ships in the image together with psql 17 (ADR-020) — rewriting its logic
// in JS would create a second owner of migration order. Ceiling: one
// spawn per start (~tens of ms). Move in-process if migrations ever need to
// be applied without psql in the image.
import { spawnSync } from 'node:child_process'

export interface MigratorResult { status: number | null, stdout: string, stderr: string }
export type Migrator = () => MigratorResult

const defaultMigrator: Migrator = () => {
  const r = spawnSync('node', ['scripts/db-migrate.mjs'], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** File name from the migrator log — it prints `applying <file>` BEFORE psql. */
function failedFile(stdout: string): string | null {
  const applying = [...stdout.matchAll(/^applying\s+(\S+)/gm)]
  return applying.length ? applying[applying.length - 1][1] : null
}

/**
 * Run migrations; a non-zero code = throw. Throwing is mandatory: silently working
 * on half a schema is the main risk, and an app that did not start is
 * diagnosed in a second, one that started on half the tables is not.
 */
export function runMigrations(migrator: Migrator = defaultMigrator): void {
  const r = migrator()
  if (r.stdout.trim())
    console.log(`[auto-migrate] ${r.stdout.trim()}`)
  if (r.status === 0)
    return

  const file = failedFile(r.stdout)
  throw new Error(
    `[auto-migrate] migrations were not applied (exit code ${r.status})`
    + `${file ? ` — failed: ${file}` : ''}\n${r.stderr.trim()}`,
  )
}

/**
 * In dev, migrations stay an explicit step (`pnpm dev:seed`): there the DB is brought up
 * and torn down by hand, and a plugin failing on missing PG* variables would take
 * `pnpm dev` down with it. The image sets NODE_ENV=production (`Dockerfile`), so
 * a client install migrates itself — exactly where it is required.
 */
export function shouldRun(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SAK_SKIP_AUTO_MIGRATE === '1')
    return false
  return env.NODE_ENV === 'production'
}
