// Controller: stop the point's running scan — nmap is killed and the run ends
// failed/stopped, so the point can be scanned again at once.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { stopPointScan } from '../../../services/discovery-scan'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const pointId = z.string().uuid().parse(getRouterParam(event, 'pointId'))
  if (!await stopPointScan(serverSupabaseServiceRole(event), pointId))
    throw createError({ statusCode: 404, statusMessage: 'No scan is running for this point' })
  setResponseStatus(event, 202)
  return { stopped: true }
})
