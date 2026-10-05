// Controller: list of credential sets for the admin UI. Metadata only — without
// password_enc (the password is write-only, ADR-009). service_role (RLS deny-all).
import { serverSupabaseServiceRole } from '#supabase/server'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const { data, error } = await serverSupabaseServiceRole(event)
    .from('credential_sets')
    .select('id,name,username,port,created_at,updated_at')
    .order('name')
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return data
})
