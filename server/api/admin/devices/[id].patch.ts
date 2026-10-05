// Controller: edit a device's protocols.
// Admin-only (ADR-013). The partial patch is validated by zod at the boundary.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { updateDevice } from '../../../repositories/devices'
import { patchSchema } from '../../../services/devices'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  const patch = await readValidatedBody(event, patchSchema.parse)
  return updateDevice(serverSupabaseServiceRole(event), id, patch)
})
