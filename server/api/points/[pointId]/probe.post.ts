// Controller: on-demand probe of a point's devices.
// Operator gate: a viewer reads the cached status (RLS device_status) but
// does not start a probe. 3-Tier: logic in services/health, DB in repositories,
// port resolve in services/credentials.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { probePoint } from '../../../services/health'
import { readByDevices, upsertStatuses } from '../../../repositories/device-status'
import { listPointTargets } from '../../../repositories/probe-target'
import { tcpProbe } from '../../../utils/tcp-probe'

const bodySchema = z.object({ force: z.boolean().optional() }).default({})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'operator')
  const pointId = z.string().uuid().parse(getRouterParam(event, 'pointId'))
  const { force } = await readValidatedBody(event, bodySchema.parse)
  const sr = serverSupabaseServiceRole(event)

  const targets = await listPointTargets(sr, pointId)
  return probePoint(
    {
      probe: tcpProbe,
      readCached: ids => readByDevices(sr, ids),
      persist: rows => upsertStatuses(sr, rows),
      now: () => Date.now(),
    },
    targets,
    { force },
  )
})
