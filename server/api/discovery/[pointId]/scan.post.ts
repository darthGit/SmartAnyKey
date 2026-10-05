// Controller: start a point scan as task_run(kind=discovery-scan).
// Inserts a running row, detaches execution, returns 202 — the client polls the row
// (RLS actor=self), then reads GET hosts. Logic in discovery-scan, DB in the repo.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { getPoint } from '../../../repositories/discovered'
import { insertRunning } from '../../../repositories/task-runs'
import { runScanDetached } from '../../../services/discovery-scan'

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

  const actor = user.email ?? user.id
  const run = await insertRunning(sr, {
    kind: 'discovery-scan',
    actor,
    deviceId: null,
    refId: pointId,
    label: `Discover #${point.number}`,
    input: { subnet: point.subnet, mode, customPorts: customPorts ?? null },
  })
  runScanDetached(sr, run.id, pointId, { mode, customPorts })

  setResponseStatus(event, 202)
  return { executionId: run.id }
})
