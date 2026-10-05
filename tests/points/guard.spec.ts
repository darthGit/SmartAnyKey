// RED. Route RBAC gates — a source scan (same pattern as
// tests/board/note-route.spec.ts:27-31 and tests/board/runbooks-route.spec.ts):
// requireRole needs an H3Event, so we check the controller's decision instead of
// raising HTTP.
// ADR-013: managing a point = admin; contacts = operator (the operator records
// a number during a call); lookup = ≥viewer (a session alone has no profile).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const gate = (p: string, role: string) =>
  new RegExp(`requireRole\\([\\s\\S]*?['"]${role}['"]`).test(src(p))

const ADMIN_ROUTES = [
  'server/api/admin/points/index.post.ts',
  'server/api/admin/points/[id].patch.ts',
  'server/api/admin/points/[id].delete.ts',
  'server/api/admin/points/[id]/blast-radius.get.ts',
]

const OPERATOR_ROUTES = [
  'server/api/points/[pointId]/contacts.post.ts',
  'server/api/points/[pointId]/contacts/[contactId].patch.ts',
  'server/api/points/[pointId]/contacts/[contactId].delete.ts',
]

describe('point admin routes gate (ADR-013)', () => {
  it.each(ADMIN_ROUTES)('%s calls requireRole(..., "admin")', (route) => {
    expect(gate(route, 'admin')).toBe(true)
  })
})

describe('contact routes gate (AC-7)', () => {
  it.each(OPERATOR_ROUTES)('%s calls requireRole(..., "operator")', (route) => {
    expect(gate(route, 'operator')).toBe(true)
  })

  it('contact_routes_require_operator: none is admin-only — the operator must be able to write', () => {
    for (const route of OPERATOR_ROUTES)
      expect(gate(route, 'admin'), route).toBe(false)
  })
})

describe('lookup route gate (AC-9)', () => {
  it('requires_viewer: a session without a profile gets nothing', () => {
    expect(gate('server/api/points/lookup.get.ts', 'viewer')).toBe(true)
  })
})
