// Controller: edit a point.
// Admin-only (ADR-013). The partial patch is validated by zod at the boundary.
// `number` is editable on purpose — the consequences (a duplicate on re-import of an old
// CSV, capture_target='point_number') are explained by the UI.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { updatePoint } from '../../../repositories/points'
import { patchSchema } from '../../../services/points'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  const patch = await readValidatedBody(event, patchSchema.parse)
  return updatePoint(serverSupabaseServiceRole(event), id, patch)
})
