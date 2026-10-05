// Controller: create a point.
// Admin-only (ADR-013). Previously only the CSV import created points.
// The body is validated by zod at the boundary — a malformed CIDR fails here, not as a raw PG 22P02.
import { serverSupabaseServiceRole } from '#supabase/server'
import { createPoint } from '../../../repositories/points'
import { createSchema } from '../../../services/points'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const body = await readValidatedBody(event, createSchema.parse)
  const row = await createPoint(serverSupabaseServiceRole(event), body)
  setResponseStatus(event, 201)
  return row
})
