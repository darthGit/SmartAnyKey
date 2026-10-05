// Controller: admin password reset — new temp + re-arm of the
// forced change. Returns the temp password (shown once).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { resetPassword } from '../../../../services/user-admin'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  return resetPassword(serverSupabaseServiceRole(event), id)
})
