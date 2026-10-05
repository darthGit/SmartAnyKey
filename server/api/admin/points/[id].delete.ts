// Controller: delete a point.
// Admin-only (ADR-013). The repo cleans up orphaned credential_bindings at TWO levels
// (point + device for the point's devices) before delete — the points→devices cascade does
// not call deleteDevice, so it does not remove them itself (verified on a live DB).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { deletePoint } from '../../../repositories/points'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  await deletePoint(serverSupabaseServiceRole(event), id)
  setResponseStatus(event, 204)
  return null
})
