// Controller: delete a signature rule (admin).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { removeSignature } from '../../../repositories/discovered'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  await removeSignature(serverSupabaseServiceRole(event), id)
  return { ok: true }
})
