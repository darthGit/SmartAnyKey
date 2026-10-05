// Controller: set/clear a point's rescan cadence. Without this the
// scheduled task never has a due point → nothing to detect (usability, not just AC).
// Admin-gated; enabling makes the point due on the next tick.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { getPoint } from '../../../repositories/discovered'
import { setSchedule } from '../../../repositories/drift'

const bodySchema = z.object({ cadenceMinutes: z.number().int().positive().nullable() })

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const pointId = z.string().uuid().parse(getRouterParam(event, 'pointId'))
  const { cadenceMinutes } = await readValidatedBody(event, bodySchema.parse)
  const sr = serverSupabaseServiceRole(event)

  const point = await getPoint(sr, pointId)
  if (!point)
    throw createError({ statusCode: 404, statusMessage: 'Point not found' })

  await setSchedule(sr, pointId, cadenceMinutes, new Date())
  return { ok: true }
})
