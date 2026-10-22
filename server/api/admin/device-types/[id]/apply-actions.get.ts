// Controller: how many devices of the type miss one of its protocols (the count shown
// before "apply to existing"). Admin-only.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { missingActionCount } from '../../../../repositories/device-types'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  return { missing: await missingActionCount(serverSupabaseServiceRole(event), id) }
})
