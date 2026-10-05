// User management: temp password generation + enforcement wiring.
// Wiring/self-only — a source scan (no HTTP). Lifecycle logic — the integration spec.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateTempPassword } from '../../server/services/user-admin'

const read = f => readFileSync(join(process.cwd(), f), 'utf8')

describe('user-admin: temp password', () => {
  it('generateTempPassword: ≥12 chars and different every time', () => {
    const a = generateTempPassword()
    const b = generateTempPassword()
    expect(a.length).toBeGreaterThanOrEqual(12)
    expect(a).not.toBe(b)
  })
})

describe('user-admin: enforcement wiring (source-scan)', () => {
  const ADMIN_ROUTES = [
    'server/api/admin/users/index.post.ts',
    'server/api/admin/users/[id]/reset-password.post.ts',
    'server/api/admin/users/[id]/index.delete.ts',
  ]
  it('route_scan_create_reset_delete_require_admin', () => {
    for (const f of ADMIN_ROUTES)
      expect(/requireRole\([\s\S]*?['"]admin['"]/.test(read(f)), `${f} → requireRole(..., 'admin')`).toBe(true)
  })

  it('change_password_route_is_self_only', () => {
    const src = read('server/api/auth/change-password.post.ts')
    expect(/requireUser\(/.test(src), 'change-password must be self-only via requireUser').toBe(true)
    // target = the logged-in user; do NOT accept another userId (from body/route) → no escalation
    expect(/getRouterParam|body\.userId|body\.user_id/.test(src), 'does not take another user\'s userId').toBe(false)
  })

  it('deleteUser gates anti-lockout (wouldOrphanAdmins)', () => {
    expect(read('server/services/user-admin.ts').includes('wouldOrphanAdmins')).toBe(true)
  })
})
