// Controller: add a task trigger (cron or webhook).
// Admin-only. The raw webhook token is returned exactly here and never again —
// the DB holds only its hash (repositories/tasks).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { createTrigger } from '../../../../repositories/tasks'

const schema = z.object({
  kind: z.enum(['cron', 'webhook']),
  cron: z.string().max(120).optional(),
  misfire_policy: z.enum(['run', 'skip']).optional(),
  sync: z.boolean().optional(),
  enabled: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const taskId = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, schema.parse)
  if (body.kind === 'cron' && !body.cron)
    throw createError({ statusCode: 400, statusMessage: 'cron expression required' })
  try {
    const row = await createTrigger(serverSupabaseServiceRole(event), { task_id: taskId, ...body })
    setResponseStatus(event, 201)
    return row
  }
  catch (ex: unknown) {
    // An invalid cron expression — 400 with the parser text, not a raw 500.
    if (ex instanceof Error && ex.message.startsWith('cron:'))
      throw createError({ statusCode: 400, statusMessage: ex.message })
    throw ex
  }
})
