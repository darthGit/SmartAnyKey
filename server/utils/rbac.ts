// RBAC — coarse global roles (ADR-013 pending).
// A pure module: no #supabase/server import (so it stays importable in
// node-env unit tests). Event glue (requireRole/getRole) lives in auth.ts.
import type { SupabaseClient } from '@supabase/supabase-js'

export type Role = 'viewer' | 'operator' | 'admin'
export const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 }

// The cookie path hands over raw JWT claims (@nuxtjs/supabase 2.0.9 `serverSupabaseUser` =
// `auth.getClaims()`): the id is `sub`, there is no `id`. The Bearer path returns a User.
// One shape for both, so `user.id` is never undefined in a role lookup.
export function sessionUser<T extends { id?: string, sub?: string, email?: string }>(u: T): T & { id: string } {
  return { ...u, id: (u.id ?? u.sub)! }
}

// Ladder: a role reaches min if its rank ≥ min. No role → deny.
export function hasRole(role: Role | null | undefined, min: Role): boolean {
  return !!role && role in ROLE_RANK && ROLE_RANK[role] >= ROLE_RANK[min]
}

// Anti-lockout: whether removing the role from target leaves zero admins.
export function wouldOrphanAdmins(adminUserIds: string[], targetUserId: string, newRole: Role): boolean {
  if (newRole === 'admin')
    return false
  return adminUserIds.filter(id => id !== targetUserId).length === 0
}

// User role from profiles (deny-by-default: no row → null).
export async function getRoleForUser(client: SupabaseClient, userId: string): Promise<Role | null> {
  const { data } = await client.from('profiles').select('role').eq('user_id', userId).maybeSingle()
  return (data?.role as Role) ?? null
}
