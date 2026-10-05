// Controller: runbooks applicable to a point (?pointId=). ≥viewer: runbooks hold door codes
// and site instructions, and the service-role read skips RLS (ADR-013).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { runbooksForPoint } from '../../services/runbooks'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'viewer')
  const pointId = z.string().uuid().parse(getQuery(event).pointId)
  return runbooksForPoint(serverSupabaseServiceRole(event), pointId)
})
