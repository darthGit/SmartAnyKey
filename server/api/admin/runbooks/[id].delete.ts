// Controller: delete a runbook (admin).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { removeRunbook } from '../../../repositories/runbooks'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  await removeRunbook(serverSupabaseServiceRole(event), id)
  return { ok: true }
})
