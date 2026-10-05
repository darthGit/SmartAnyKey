// Controller: edit a device type. Admin-only. Partial patch (zod).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { updateType } from '../../../repositories/device-types'
import { patchSchema } from '../../../services/device-types'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  const patch = await readValidatedBody(event, patchSchema.parse)
  return updateType(serverSupabaseServiceRole(event), id, patch)
})
