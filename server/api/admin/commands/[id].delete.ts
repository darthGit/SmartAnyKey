// Controller: delete a type's command (admin).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { removeCommand } from '../../../repositories/device-commands'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  await removeCommand(serverSupabaseServiceRole(event), id)
  return { ok: true }
})
