// Controller: start a point scan as task_run(kind=discovery-scan), or hand back the one
// already running there — one scan per point, whoever asked. Returns the run id; the
// client polls the row, then reads GET hosts. Logic in discovery-scan, DB in the repo.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { getPoint } from '../../../repositories/discovered'
import { startPointScan } from '../../../services/discovery-scan'

// Port scope: default combined = current behaviour
// (backward-compatible — the body is optional). custom is validated in resolvePorts.
const bodySchema = z.object({
  mode: z.enum(['combined', 'signatures', 'custom']).default('combined'),
  customPorts: z.string().optional(),
})

export default defineEventHandler(async (event) => {
  const { user } = await requireRole(event, 'admin')
  const pointId = z.string().uuid().parse(getRouterParam(event, 'pointId'))
  const { mode, customPorts } = bodySchema.parse(await readBody(event).catch(() => ({})))
  const sr = serverSupabaseServiceRole(event)

  const point = await getPoint(sr, pointId)
  if (!point)
    throw createError({ statusCode: 404, statusMessage: 'Point not found' })

  const { executionId, started } = await startPointScan(sr, point, user.email ?? user.id, { mode, customPorts })
  setResponseStatus(event, started ? 202 : 200)
  return { executionId }
})
