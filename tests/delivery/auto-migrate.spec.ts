// RED. Migrations move from the customer's hands
// into app startup (ADR-015: exactly one `app` replica, so a race between
// two migrating processes is impossible by construction).
//
// The plugin does NOT rewrite `scripts/db-migrate.mjs` — it is already idempotent (journal
// public.schema_migrations by file name) and already ships in the image with psql
// 17 (ADR-020). The plugin runs it, so what is tested is exactly what the plugin
// decides: fail loudly or skip.
import { describe, expect, it } from 'vitest'
import { runMigrations, shouldRun } from '../../server/utils/auto-migrate'
// @ts-expect-error — an untyped .mjs script; we import only the pure function
import { pendingMigrations } from '../../scripts/db-migrate.mjs'

type Runner = () => { status: number, stdout: string, stderr: string }

const ok: Runner = () => ({ status: 0, stdout: 'applied 0 migration(s)\n', stderr: '' })
const broken: Runner = () => ({
  status: 1,
  stdout: 'applying 0019_broken.sql\n',
  stderr: 'psql:<stdin>:3: ERROR:  syntax error at or near "creat"\n',
})

describe('auto-migrate plugin (AC-4)', () => {
  it('does_not_throw_when_migrator_exits_zero', () => {
    expect(() => runMigrations(ok)).not.toThrow()
  })

  it('throws_with_filename_when_migrator_fails', () => {
    let err: Error | undefined
    try {
      runMigrations(broken)
    }
    catch (e) {
      err = e as Error
    }
    // Silently running on half a schema is the main risk. Startup must fail.
    expect(err, 'a non-zero code must stop app startup').toBeInstanceOf(Error)
    // Without the file name the message diagnoses nothing.
    expect(err!.message, 'the message must name the broken migration').toContain('0019_broken.sql')
  })
})

describe('auto-migrate gate', () => {
  it('runs_in_the_image_not_in_dev', () => {
    // The image sets NODE_ENV=production; `pnpm dev` does not. In dev, migrations
    // stay an explicit step (`pnpm dev:seed`), otherwise the plugin would take
    // down the dev server on every machine without PG* variables.
    expect(shouldRun({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true)
    expect(shouldRun({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false)
    expect(shouldRun({} as NodeJS.ProcessEnv)).toBe(false)
  })

  it('has_an_escape_hatch_for_a_broken_install', () => {
    // An install that does not start because of a migration must have a way to come up and
    // show its logs — otherwise "fail loudly" becomes "fail dead".
    expect(shouldRun({ NODE_ENV: 'production', SAK_SKIP_AUTO_MIGRATE: '1' } as NodeJS.ProcessEnv)).toBe(false)
  })
})

describe('db-migrate journal (AC-4)', () => {
  const FILES = ['0001_init.sql', '0002_points.sql', '0003_devices.sql']

  it('pending_is_empty_when_journal_is_complete', () => {
    expect(pendingMigrations(new Set(FILES), FILES)).toEqual([])
  })

  it('pending_is_everything_on_an_empty_journal', () => {
    expect(pendingMigrations(new Set<string>(), FILES)).toEqual(FILES)
  })

  it('pending_keeps_filename_order', () => {
    // Order = sort by name (0009 references auth.users, created
    // earlier) — reordering them breaks a fresh install.
    expect(pendingMigrations(new Set(['0002_points.sql']), FILES))
      .toEqual(['0001_init.sql', '0003_devices.sql'])
  })
})
