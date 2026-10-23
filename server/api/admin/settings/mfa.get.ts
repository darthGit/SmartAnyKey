// Controller: the 2FA policy — the lowest role that must use a second factor (null = nobody).
import { serverSupabaseServiceRole } from '#supabase/server'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const { data, error } = await serverSupabaseServiceRole(event).from('app_settings').select('mfa_required_role').single()
  if (error)
    throw createError({ statusCode: 500, statusMessage: error.message })
  return { requiredRole: data.mfa_required_role }
})
