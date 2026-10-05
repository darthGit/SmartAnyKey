// Controller: blast radius of deleting a point. Admin-only (ADR-013). Feeds the
// confirmation text — a deferred/irreversible effect is made explicit, because
// delete is irreversible.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { countBlastRadius } from '../../../../repositories/points'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  return countBlastRadius(serverSupabaseServiceRole(event), id)
})
