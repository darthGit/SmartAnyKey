// Controller: diff of the point's latest scan — observed hosts (New/Matched/
// Changed/Rogue) + Missing (devices without a host). Read-only; the client
// polls the scan status separately via task_run (executionId).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { latestDiff } from '../../../services/discovery-scan'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const pointId = z.string().uuid().parse(getRouterParam(event, 'pointId'))
  return await latestDiff(serverSupabaseServiceRole(event), pointId)
})
