// Controller: give every device of the type the protocols it misses. Adds only, never
// removes (a protocol set by hand on one device stays). Admin-only; idempotent.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { applyTypeActions } from '../../../../repositories/device-types'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  return { updated: await applyTypeActions(serverSupabaseServiceRole(event), id) }
})
