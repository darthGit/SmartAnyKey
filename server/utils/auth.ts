// Auth at the trust boundary: Bearer (tests/explicit calls) or the
// module's cookie session (browser GETs). No user → 401.
import type { H3Event } from 'h3'
import { serverSupabaseServiceRole, serverSupabaseUser } from '#supabase/server'
import type { Role } from './rbac'
import { getRoleForUser, hasRole, sessionUser } from './rbac'

export async function requireUser(event: H3Event) {
  const header = getHeader(event, 'authorization')
  if (header?.startsWith('Bearer ')) {
    const { data, error } = await serverSupabaseServiceRole(event).auth.getUser(header.slice(7))
    if (!error && data.user)
      return data.user
  }
  const user = await serverSupabaseUser(event).catch(() => null)
  if (user?.sub)
    return sessionUser(user)
  throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
}

// RBAC event glue: the logged-in user's role + gate. Pure logic — rbac.ts.
export async function getRole(event: H3Event): Promise<Role | null> {
  const user = await requireUser(event)
  return getRoleForUser(serverSupabaseServiceRole(event), user.id)
}

// 401 if not logged in (requireUser), 403 if the role is below min.
export async function requireRole(event: H3Event, min: Role) {
  const user = await requireUser(event)
  const role = await getRoleForUser(serverSupabaseServiceRole(event), user.id)
  if (!hasRole(role, min))
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  return { user, role: role as Role }
}
