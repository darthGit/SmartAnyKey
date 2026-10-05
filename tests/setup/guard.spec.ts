// RED. Source scan of the `/setup` routes — same pattern as
// tests/points/guard.spec.ts: the controller's decision is checked in code,
// because there is nothing here to raise an H3Event with.
//
// `/setup` is the ONLY product route without authentication (ADR-021), and that
// is why it needs a guard test: adding requireUser here by accident = making the
// first install impossible, and removing the "zero admins" gate by accident =
// leaving an open admin creator on a live install.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (p: string) => {
  const full = join(process.cwd(), p)
  if (!existsSync(full))
    throw new Error(`${p} does not exist — decomposition step 4 not done yet`)
  return readFileSync(full, 'utf8')
}

const ROUTES = [
  'server/api/setup/status.get.ts',
  'server/api/setup/admin.post.ts',
]

describe('setup routes (ADR-021)', () => {
  it.each(ROUTES)('setup_routes_are_unauthenticated_by_design: %s', (route) => {
    const s = src(route)
    // The gate is DB state, not a session. requireUser/requireRole here = a regression:
    // on a fresh install there is nobody to authenticate.
    expect(s, `${route}: requireUser makes the first install impossible`).not.toMatch(/requireUser\s*\(/)
    expect(s, `${route}: requireRole makes the first install impossible`).not.toMatch(/requireRole\s*\(/)
  })

  it('first_admin_write_is_conditional_not_read_then_write', () => {
    // The conditional write lives in the DB, not in the service (3-Tier: the repository
    // is the only layer touching data). The test keeps the shape from degrading back
    // into select-then-insert; the race itself is proven by a live run.
    const sql = src('supabase/migrations/0019_first_admin_claim.sql')
    expect(sql, 'the write must be conditional: insert … where not exists')
      .toMatch(/where\s+not\s+exists/i)
    // ⚠ `not exists` by itself does NOT hold the race: under READ COMMITTED two
    // transactions both see "zero admins" and both insert (user_id differs,
    // PK does not object). A serializer is mandatory.
    expect(sql, 'serialization missing — a conditional insert under READ COMMITTED is not atomic')
      .toMatch(/pg_advisory_xact_lock|serializable/i)
    expect(src('server/repositories/setup.ts'), 'the claim result must be read by row count')
      .toMatch(/=== 1|rowCount|row_count/)
  })

  it('setup_gate_reads_admin_count_from_profiles', () => {
    const s = src('server/api/setup/status.get.ts')
    expect(s).toMatch(/profiles/)
    expect(s).toMatch(/admin/)
  })
})

// Found by a live run 2026-09-18: without this line `/setup` is unreachable
// at all — `@nuxtjs/supabase` sends any unauthenticated path to /login, and
// `first-run.global.ts` sends it back while there are zero admins. A loop.
describe('setup route is reachable without a session', () => {
  it('is_excluded_from_the_supabase_login_redirect', () => {
    const cfg = src('nuxt.config.ts')
    const block = cfg.match(/redirectOptions:\s*\{([\s\S]*?)\}/)?.[1] ?? ''
    expect(block, 'exclude missing — /setup will fall into a redirect loop')
      .toMatch(/exclude:\s*\[[^\]]*['"]\/setup['"]/)
  })
})
