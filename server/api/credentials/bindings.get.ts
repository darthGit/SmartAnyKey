// Controller: list of bindings (level, target, action → set) for the admin UI.
// service_role (RLS deny-all). No password_enc — metadata only.
import { serverSupabaseServiceRole } from '#supabase/server'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const { data, error } = await serverSupabaseServiceRole(event)
    .from('credential_bindings')
    .select('id,level,target_id,action,cred_set_id,credential_sets(name)')
    .order('level')
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return data
})
