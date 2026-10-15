// RED. `docker/install.sh` is one command with four traps built in, each one
// measured by a live run on a clean machine. Without them the script looks
// working and fails only at the customer's, so the traps are held by a test,
// not by the memory of the next session.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PATH = 'docker/install.sh'
const full = join(process.cwd(), PATH)

function sh(): string {
  if (!existsSync(full))
    throw new Error(`${PATH} does not exist — decomposition step 1 not done yet`)
  return readFileSync(full, 'utf8')
}

describe('install.sh (AC-3)', () => {
  it('is_executable', () => {
    expect(existsSync(full), `${PATH} does not exist`).toBe(true)
    // Quickstart says `./install.sh` — without the x bit the README lies.
    expect(statSync(full).mode & 0o111, 'missing x bit').toBeGreaterThan(0)
  })

  it('embeds_the_four_measured_traps', () => {
    const s = sh()
    // 1. without --no-deps compose brings the stack up before the script → kong unhealthy
    expect(s, 'missing --no-deps').toContain('--no-deps')
    // 2. without -u the image runs as `node` and fails EACCES on a foreign directory
    expect(s, 'missing -u "$(id -u):$(id -g)"').toMatch(/-u\s+"\$\(id -u\):\$\(id -g\)"/)
    // 3. bootstrap.mjs reads docker/.env.example relative to CWD → a mount is needed
    expect(s, 'missing -v "$PWD:/work" -w /work').toMatch(/-v\s+"\$PWD:\/work"/)
    expect(s).toMatch(/-w\s+\/work/)
    // 4. image coordinates inline — on a non-default registry compose otherwise
    //    pulls the default ghcr.io and fails with `denied`
    expect(s, 'missing inline SAK_IMAGE/SAK_TAG on the bootstrap step').toMatch(/SAK_IMAGE/)
  })

  it('removes_services_a_release_dropped', () => {
    // Re-running the installer is the upgrade path: without --remove-orphans a dropped
    // service keeps running (ADR-023: the old pooler kept Postgres on 5432).
    expect(sh()).toMatch(/compose[^\n]*\bup\b[^\n]*--remove-orphans/)
  })

  it('fixes_backup_dir_ownership', () => {
    // Fifth trap, measured 2026-09-21 in a clean room: the image runs as
    // `node` (uid 1000), but the `/backups` mount point is created by docker —
    // both a managed volume (no such directory in the image) and a bind end up `root:root`.
    // Result: backup toggle is green, `pg_dump` gets EACCES, no file.
    // One `chown` from inside fixes both mount variants.
    const s = sh()
    expect(s, 'missing the /backups permissions step').toMatch(/chown\s+node:node\s+\/backups/)
    expect(s, 'chown must run as root (-u 0)').toMatch(/exec[^\n]*-u\s+0[^\n]*app/)
  })

  it('image_owns_the_dump_directory', () => {
    // Second of three doors: without install.sh (plain `compose up -d`) only the
    // image sets permissions. Measured 2026-09-21: a fresh managed volume comes up
    // `root:root`, because the image had no `/backups` directory.
    const df = readFileSync('Dockerfile', 'utf8')
    expect(df, 'Dockerfile does not create /backups').toMatch(/mkdir -p \/backups/)
    expect(df, '/backups must be owned by node').toMatch(/chown node:node \/backups/)
    // Order matters: after USER node the command would no longer run as root.
    expect(df.indexOf('chown node:node /backups')).toBeLessThan(df.indexOf('USER node'))
  })

  it('manual_path_in_docs_carries_the_same_step', () => {
    // docs/installation.md promises «the steps `install.sh` performs … the same
    // path, spelled out» — the third door: if the permissions step is missing
    // there, the documented manual path reproduces the defect.
    const doc = readFileSync('docs/installation.md', 'utf8')
    const manual = doc.slice(doc.indexOf('## Manual install'))
    expect(manual, 'manual path in docs/installation.md lacks the /backups permissions step')
      .toMatch(/chown node:node \/backups/)
  })

  it('runs_from_the_parent_of_the_docker_directory', () => {
    // bootstrap.mjs:76,157,164 reads `docker/.env.example` and writes `docker/.env`
    // relative to CWD. The script lives inside docker/, so it must go up one level.
    expect(sh(), 'missing cd to the parent directory — bootstrap relative paths will not resolve')
      .toMatch(/cd\s+"\$\(dirname\s+"?\$0"?\)\/\.\."/)
  })

  it('seeds_admin_only_when_both_rbac_vars_are_set', () => {
    const s = sh()
    // Empty RBAC_ADMIN_* (default from bootstrap.mjs:126-127) = the path via the /setup UI.
    // An unconditional seed-admin here would take the first-run screen from the customer.
    expect(s).toMatch(/RBAC_ADMIN_EMAIL/)
    expect(s).toMatch(/RBAC_ADMIN_PASSWORD/)
    expect(s, 'seed-admin must be conditional, not an unconditional step')
      .toMatch(/if\s+\[[\s\S]*RBAC_ADMIN_[\s\S]*seed-admin\.mjs/)
  })

  it('does_not_run_db_migrate_itself', () => {
    // Migrations belong to the Nitro plugin (step 3). A duplicate here = a second owner of the step.
    expect(sh(), 'db-migrate is no longer an install step — the app runs it on startup')
      .not.toMatch(/db-migrate\.mjs/)
  })
})

// Found by a live run 2026-09-18: `install.sh` honestly met its condition
// («both variables non-empty → seeder»), but the `.env.example` template shipped
// `RBAC_ADMIN_EMAIL=admin@example.com` / `RBAC_ADMIN_PASSWORD=change-me-now`,
// and `bootstrap.mjs` copies the template verbatim. Result: every standard install
// silently got an admin with a publicly known password, and `/setup` never showed
// up. The same problem that got the admin removed from migration 0009.
describe('.env.example ships no default admin (AC-2)', () => {
  it('rbac_admin_vars_are_empty_so_setup_screen_is_the_default_path', () => {
    const env = readFileSync(join(process.cwd(), 'docker/.env.example'), 'utf8')
    for (const key of ['RBAC_ADMIN_EMAIL', 'RBAC_ADMIN_PASSWORD']) {
      const line = env.split('\n').find(l => l.startsWith(`${key}=`))
      expect(line, `docker/.env.example has no ${key}`).toBeDefined()
      expect(line!.slice(key.length + 1).trim(),
        `non-empty ${key} in the template = an admin with a known password on EVERY install`).toBe('')
    }
  })
})
