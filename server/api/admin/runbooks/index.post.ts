// Controller: create a runbook (admin). service_role (write deny-all for the client).
import { serverSupabaseServiceRole } from '#supabase/server'
import { createRunbook } from '../../../repositories/runbooks'
import { runbookCreateSchema } from '../../../services/runbooks'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const input = await readValidatedBody(event, runbookCreateSchema.parse)
  return createRunbook(serverSupabaseServiceRole(event), input)
})
