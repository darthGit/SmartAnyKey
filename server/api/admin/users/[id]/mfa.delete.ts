// Controller: admin removes a user's second factor (lost phone).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { resetMfa } from '../../../../services/user-admin'

export default defineEventHandler(async (event) => {
  const { user } = await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  await resetMfa(serverSupabaseServiceRole(event), id, user.email ?? user.id)
  return { ok: true }
})
