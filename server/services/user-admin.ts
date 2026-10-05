// User-management lifecycle (amends ADR-013).
// Pure functions take a service client (convention of credentials.ts/rbac.ts).
// No email (SMTP): temp password + app_metadata.must_change_password forced change.
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import type { Role } from '../utils/rbac'
import { wouldOrphanAdmins } from '../utils/rbac'

// Crypto-random temp password (base64url, ~24 chars). Shown to the admin once.
export function generateTempPassword(): string {
  return randomBytes(18).toString('base64url')
}

async function adminIds(service: SupabaseClient): Promise<string[]> {
  const { data } = await service.from('profiles').select('user_id').eq('role', 'admin')
  return (data ?? []).map(r => r.user_id)
}

export async function createUser(service: SupabaseClient, { email, role }: { email: string, role: Role }) {
  const tempPassword = generateTempPassword()
  const { data, error } = await service.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    app_metadata: { must_change_password: true },
  })
  if (error)
    throw createError({ statusCode: 400, statusMessage: error.message })
  const { error: pErr } = await service.from('profiles')
    .upsert({ user_id: data.user.id, role, updated_at: new Date().toISOString() })
  if (pErr)
    throw createError({ statusCode: 500, statusMessage: pErr.message })
  return { id: data.user.id, tempPassword }
}

export async function resetPassword(service: SupabaseClient, userId: string) {
  const tempPassword = generateTempPassword()
  const { error } = await service.auth.admin.updateUserById(userId, {
    password: tempPassword,
    app_metadata: { must_change_password: true },
  })
  if (error)
    throw createError({ statusCode: 400, statusMessage: error.message })
  return { tempPassword }
}

export async function deleteUser(service: SupabaseClient, userId: string) {
  // anti-lockout: deleting an admin = the role disappears → check it as a demotion (BEFORE delete).
  if (wouldOrphanAdmins(await adminIds(service), userId, 'viewer'))
    throw createError({ statusCode: 409, statusMessage: 'Cannot delete the last admin' })
  const { error } = await service.auth.admin.deleteUser(userId)
  if (error)
    throw createError({ statusCode: 400, statusMessage: error.message })
}

// Self: the caller changes their OWN password (userId = requireUser().id, not from body) + clears the flag.
export async function changeOwnPassword(service: SupabaseClient, userId: string, newPassword: string) {
  const { error } = await service.auth.admin.updateUserById(userId, {
    password: newPassword,
    app_metadata: { must_change_password: false },
  })
  if (error)
    throw createError({ statusCode: 400, statusMessage: error.message })
}
