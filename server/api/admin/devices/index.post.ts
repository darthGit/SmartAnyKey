// Controller: manual add of a device.
// Admin-only (ADR-013). The body is validated by zod at the boundary (→ 400). Mirror of [id].patch.ts.
// ponytail: a duplicate point_id+host is not checked — a manual add is done by an admin explicitly, who
//           sees the existing devices in the search on the same page. Upgrade = a DB unique constraint
//           (point_id+host), a separate change if it gets noisy.
import { serverSupabaseServiceRole } from '#supabase/server'
import { createDevice } from '../../../repositories/devices'
import { createSchema } from '../../../services/devices'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const body = await readValidatedBody(event, createSchema.parse)
  const row = await createDevice(serverSupabaseServiceRole(event), body)
  setResponseStatus(event, 201)
  return row
})
