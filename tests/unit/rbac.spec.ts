// RBAC gate logic (pure) + enforcement wiring (source scan).
// No-HTTP harness: the role ladder is tested as a function, "every action route
// is gated" by reading the source (a missed guard = a hole).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasRole, wouldOrphanAdmins } from '../../server/utils/rbac'

describe('rbac: role ladder (hasRole)', () => {
  it('hasRole_viewer_below_operator: viewer does not reach operator', () => {
    expect(hasRole('viewer', 'operator')).toBe(false)
    expect(hasRole('operator', 'operator')).toBe(true)
    expect(hasRole('admin', 'operator')).toBe(true)
  })

  it('hasRole_operator_below_admin: operator does not reach admin', () => {
    expect(hasRole('operator', 'admin')).toBe(false)
    expect(hasRole('admin', 'admin')).toBe(true)
  })

  it('no role → deny at any level', () => {
    expect(hasRole(null, 'viewer')).toBe(false)
    expect(hasRole(undefined, 'viewer')).toBe(false)
  })
})

describe('rbac: anti-lockout (wouldOrphanAdmins)', () => {
  it('wouldOrphanAdmins_blocks_last_admin_demotion: demoting the last admin → true (blocked)', () => {
    expect(wouldOrphanAdmins(['u1'], 'u1', 'operator')).toBe(true)
    expect(wouldOrphanAdmins(['u1'], 'u1', 'viewer')).toBe(true)
  })

  it('not the last admin / target not admin / stays admin → false', () => {
    expect(wouldOrphanAdmins(['u1', 'u2'], 'u1', 'operator')).toBe(false) // u2 still exists
    expect(wouldOrphanAdmins(['u1'], 'u1', 'admin')).toBe(false) // stays admin
    expect(wouldOrphanAdmins(['u1', 'u2'], 'u3', 'viewer')).toBe(false) // target is not admin
  })
})

// --- enforcement wiring: every action route calls requireRole at the expected level ---
const OPERATOR_ROUTES = [
  'server/api/remote-session.post.ts',
  'server/api/remote-session/[deviceId].get.ts',
  'server/api/commands/[deviceId]/exec.post.ts',
]
// ws routes authenticate via token+authorizeUpgrade (not an H3 event) → the gate
// is getRoleForUser+hasRole, not requireRole.
const OPERATOR_WS_ROUTES = [
  'server/routes/api/guac/[deviceId].ws.ts',
  'server/routes/api/terminal/[deviceId].ws.ts',
]
const ADMIN_ROUTES = [
  'server/api/credentials/index.get.ts',
  'server/api/credentials/index.post.ts',
  'server/api/credentials/[id].patch.ts',
  'server/api/credentials/[id].delete.ts',
  'server/api/credentials/assign.post.ts',
  'server/api/credentials/bindings.get.ts',
  'server/api/credentials/copy-password.post.ts',
  'server/api/admin/commands/index.post.ts',
  'server/api/admin/commands/[id].patch.ts',
  'server/api/admin/commands/[id].delete.ts',
  'server/api/admin/signatures/index.post.ts',
  'server/api/admin/signatures/[id].patch.ts',
  'server/api/admin/signatures/[id].delete.ts',
  'server/api/admin/signatures/preview.get.ts',
  'server/api/discovery/[pointId]/scan.post.ts',
  'server/api/discovery/[pointId]/confirm.post.ts',
  'server/api/discovery/[pointId]/hosts.get.ts',
  'server/api/admin/users/index.get.ts',
  'server/api/admin/users/[id]/role.patch.ts',
]

function guardsAt(file: string, level: string, fn = 'requireRole'): boolean {
  const src = readFileSync(join(process.cwd(), file), 'utf8')
  return new RegExp(`${fn}\\([\\s\\S]*?['"]${level}['"]`).test(src)
}

describe('rbac: enforcement wiring (route source-scan)', () => {
  it('connect/exec routes are gated ≥operator', () => {
    for (const f of OPERATOR_ROUTES)
      expect(guardsAt(f, 'operator'), `${f} must call requireRole(..., 'operator')`).toBe(true)
    for (const f of OPERATOR_WS_ROUTES)
      expect(guardsAt(f, 'operator', 'hasRole'), `${f} must gate on hasRole(..., 'operator')`).toBe(true)
  })

  it('admin routes are gated admin', () => {
    for (const f of ADMIN_ROUTES)
      expect(guardsAt(f, 'admin'), `${f} must call requireRole(..., 'admin')`).toBe(true)
  })

  it('route_scan_users_role_patch_requires_admin: role change is admin-only (anti self-promotion)', () => {
    expect(guardsAt('server/api/admin/users/[id]/role.patch.ts', 'admin')).toBe(true)
  })
})
