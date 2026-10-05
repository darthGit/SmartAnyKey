// Controller: delete a user (admin, anti-lockout in the service).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { deleteUser } from '../../../../services/user-admin'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  await deleteUser(serverSupabaseServiceRole(event), id)
  return { ok: true }
})
