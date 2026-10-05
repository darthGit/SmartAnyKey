// Controller: create a device type. Admin-only (ADR-013).
// zod at the boundary (default_action enum); 23505 unique-slug → 409 (repo).
import { serverSupabaseServiceRole } from '#supabase/server'
import { insertType } from '../../../repositories/device-types'
import { createSchema } from '../../../services/device-types'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const input = await readValidatedBody(event, createSchema.parse)
  const type = await insertType(serverSupabaseServiceRole(event), input)
  setResponseStatus(event, 201)
  return type
})
