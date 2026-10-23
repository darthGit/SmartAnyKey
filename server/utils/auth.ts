// Auth at the trust boundary: Bearer (tests/explicit calls) or the
// module's cookie session (browser GETs). No user → 401; a user who still owes the
// second factor → 403 with the reason as the status message.
import type { H3Event } from 'h3'
import { serverSupabaseServiceRole, serverSupabaseUser } from '#supabase/server'
import type { Role } from './rbac'
import { getRoleForUser, hasRole, sessionUser } from './rbac'
import { tokenAal } from './mfa'
import { mfaVerdict } from '../repositories/mfa'

export interface RequireUserOpts {
  // Only for what a user needs before the second factor: their own 2FA status and
  // enrollment, and the forced password change that comes first.
  allowPendingMfa?: boolean
}

export async function requireUser(event: H3Event, opts: RequireUserOpts = {}) {
  const { user, aal } = await authenticate(event)
  if (!opts.allowPendingMfa) {
    const verdict = await mfaVerdict(serverSupabaseServiceRole(event), user.id, aal)
    if (verdict !== 'ok')
      throw createError({ statusCode: 403, statusMessage: verdict })
  }
  return user
}

export async function authenticate(event: H3Event) {
  const header = getHeader(event, 'authorization')
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7)
    const { data, error } = await serverSupabaseServiceRole(event).auth.getUser(token)
    if (!error && data.user)
      return { user: data.user, aal: tokenAal(token) }
  }
  const claims = await serverSupabaseUser(event).catch(() => null)
  if (claims?.sub)
    return { user: sessionUser(claims), aal: claims.aal as string | undefined }
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
