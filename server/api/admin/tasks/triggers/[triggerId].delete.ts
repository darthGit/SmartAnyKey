// Controller: delete a trigger. Admin-only.
import { serverSupabaseServiceRole } from '#supabase/server'
import { removeTrigger } from '../../../../repositories/tasks'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  await removeTrigger(serverSupabaseServiceRole(event), getRouterParam(event, 'triggerId')!)
  return { ok: true }
})
