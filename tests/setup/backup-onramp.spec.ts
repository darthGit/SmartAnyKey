// First-run finish block: the backup is ready and scheduled (migration 0018),
// but `enabled=false` on purpose — and without this screen an install where the
// toggle was never clicked does not back up, and nothing says so.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (p: string) => {
  const full = join(process.cwd(), p)
  if (!existsSync(full))
    throw new Error(`${p} does not exist`)
  return readFileSync(full, 'utf8')
}

describe('backup on-ramp routes (AC-8)', () => {
  it.each(['server/api/setup/backup.get.ts', 'server/api/setup/backup.post.ts'])(
    'admin_only: %s',
    (route) => {
      // A dump = all client data (ADR-018 amendment #4), so the gate is mandatory
      // here — unlike status/admin, which is exactly why those have no auth.
      expect(src(route)).toMatch(/requireRole\([\s\S]*?['"]admin['"]/)
    },
  )

  it('enable_refuses_when_the_builtin_row_is_missing', () => {
    // A silent "success" on an install older than 0018 = a green toggle with no
    // backup, exactly the lie this screen was meant to remove.
    const s = src('server/services/setup-backup.ts')
    expect(s).toMatch(/statusCode:\s*404/)
    expect(s).toMatch(/migration 0018/)
  })

  it('does_not_pretend_to_write_backup_host_dir', () => {
    // Docker reads BACKUP_HOST_DIR at container start from docker/.env on the
    // host — the app cannot change it. A field pretending otherwise would promise
    // the client something that will not happen.
    const s = src('server/services/setup-backup.ts')
    expect(s).not.toMatch(/update\([^)]*BACKUP_HOST_DIR/)
    expect(s, 'the limit must be named in code, not silent').toMatch(/BACKUP_HOST_DIR/)
  })

  it('install_script_persists_backup_host_dir', () => {
    // Set where host things are set — next to the image coordinates.
    expect(src('docker/install.sh')).toMatch(/BACKUP_HOST_DIR=\$\{BACKUP_HOST_DIR:-\}/)
  })

  it('setup_page_shows_both_states', () => {
    const s = src('app/pages/setup.vue')
    expect(s).toMatch(/data-testid="backup-off"/)
    expect(s).toMatch(/data-testid="backup-on"/)
    expect(s).toMatch(/data-action="backup-enable"/)
  })
})

// Found by a live run 2026-09-18: the backup step did not appear at all, because
// `$fetch` to the gated route went without `Authorization: Bearer`. In this
// project that is no detail but a documented convention: the cookie path of
// `requireUser` returns raw JWT claims, and `requireRole` gives 403.
describe('setup page talks to gated routes correctly', () => {
  it('sends_bearer_to_the_backup_routes', () => {
    const s = src('app/pages/setup.vue')
    const calls = s.match(/\$fetch[\s\S]{0,220}?\/api\/setup\/backup[\s\S]{0,220}?\)/g) ?? []
    expect(calls.length, 'expected both backup-route calls').toBe(2)
    for (const c of calls)
      expect(c, 'a call without Authorization gets 403').toMatch(/authHeaders\(\)|Authorization/)
  })
})
