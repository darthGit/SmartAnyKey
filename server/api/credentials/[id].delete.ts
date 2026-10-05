// Controller: delete a set. FKs on devices/types/points — on delete set
// null (bindings are simply removed, devices stay).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'

const paramsSchema = z.object({ id: z.string().uuid() })

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const { error } = await serverSupabaseServiceRole(event).from('credential_sets').delete().eq('id', id)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return { ok: true }
})
