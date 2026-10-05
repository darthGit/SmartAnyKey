// RED. Route RBAC gate via a source scan
// (same pattern as tests/points/guard.spec.ts): requireRole needs an H3Event.
// ADR-013: "Check name" is an action beyond access → operator; renaming
// (`label`) stays admin (developer decision 2026-08-14).
// ADR-014: the fixed `hostname` command is NOT a probe — it creates no device_commands
// and does not touch probe_fp_*.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROUTE = 'server/api/devices/[deviceId]/hostname.post.ts'
const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('hostname-check route gate (AC-8)', () => {
  it('viewer_403_operator_ok: route under requireRole(..., "operator")', () => {
    expect(/requireRole\([\s\S]*?['"]operator['"]/.test(src(ROUTE))).toBe(true)
  })

  it('NOT admin-only — an operator must be able to check the name', () => {
    expect(/requireRole\([\s\S]*?['"]admin['"]/.test(src(ROUTE))).toBe(false)
  })
})

describe('boundary with ADR-014 (the route is not a probe)', () => {
  it('does not write device_commands and does not touch probe_fp_*', () => {
    const s = src(ROUTE)
    expect(s).not.toMatch(/device_commands/)
    expect(s).not.toMatch(/probe_fp_/)
  })
})

describe('renaming stays admin-only (decision 2026-08-14)', () => {
  it('the only label writer is the admin devices patch route', () => {
    expect(/requireRole\([\s\S]*?['"]admin['"]/.test(src('server/api/admin/devices/[id].patch.ts'))).toBe(true)
  })
})
