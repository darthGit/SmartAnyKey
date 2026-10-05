// Controller: edit a runbook (admin).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { updateRunbook } from '../../../repositories/runbooks'
import { runbookPatchSchema } from '../../../services/runbooks'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  const patch = await readValidatedBody(event, runbookPatchSchema.parse)
  return updateRunbook(serverSupabaseServiceRole(event), id, patch)
})
