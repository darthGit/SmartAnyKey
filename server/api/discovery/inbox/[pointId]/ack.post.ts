// Controller: acknowledge a point's drift — clears all its
// unacknowledged events in one action (bulk per point, not per event). Admin-gated.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { ackPoint } from '../../../../repositories/drift'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const pointId = z.string().uuid().parse(getRouterParam(event, 'pointId'))
  const cleared = await ackPoint(serverSupabaseServiceRole(event), pointId, new Date())
  return { cleared }
})
