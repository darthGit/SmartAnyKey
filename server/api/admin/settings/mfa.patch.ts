// Controller: change the 2FA policy. Applies from the next request, no restart.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'

const schema = z.object({ requiredRole: z.enum(['viewer', 'operator', 'admin']).nullable() })

export default defineEventHandler(async (event) => {
  const { user } = await requireRole(event, 'admin')
  const { requiredRole } = await readValidatedBody(event, schema.parse)
  const { error } = await serverSupabaseServiceRole(event).from('app_settings')
    .update({ mfa_required_role: requiredRole }).eq('id', true)
  if (error)
    throw createError({ statusCode: 500, statusMessage: error.message })
  console.info(`[mfa] policy set to ${requiredRole ?? 'off'} by ${user.email ?? user.id}`)
  return { requiredRole }
})
