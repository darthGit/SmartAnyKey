// Controller: list of auth users + their role (admin-only). The role
// comes from profiles (joined in memory). requireRole/types — auto-imported from server/utils.
import { serverSupabaseServiceRole } from '#supabase/server'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const sr = serverSupabaseServiceRole(event)

  // perPage 1000 — there are few auth users; paginate if it grows.
  const { data, error } = await sr.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error)
    throw createError({ statusCode: 500, statusMessage: error.message })

  const { data: profiles } = await sr.from('profiles').select('user_id, role')
  const roleById = new Map((profiles ?? []).map(p => [p.user_id, p.role]))
  const { data: enrolled } = await sr.rpc('mfa_enrolled_users')
  const withMfa = new Set((enrolled ?? []) as string[])

  return data.users.map(u => ({
    id: u.id,
    email: u.email,
    role: roleById.get(u.id) ?? null,
    mfa: withMfa.has(u.id),
  }))
})
