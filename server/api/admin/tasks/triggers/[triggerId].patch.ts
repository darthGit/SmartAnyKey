// Controller: a trigger's toggle/schedule. Admin-only.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { updateTrigger } from '../../../../repositories/tasks'

const schema = z.object({
  cron: z.string().max(120).optional(),
  misfire_policy: z.enum(['run', 'skip']).optional(),
  sync: z.boolean().optional(),
  enabled: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = getRouterParam(event, 'triggerId')!
  const body = await readValidatedBody(event, schema.parse)
  try {
    return await updateTrigger(serverSupabaseServiceRole(event), id, body)
  }
  catch (ex: unknown) {
    if (ex instanceof Error && ex.message.startsWith('cron:'))
      throw createError({ statusCode: 400, statusMessage: ex.message })
    throw ex
  }
})
