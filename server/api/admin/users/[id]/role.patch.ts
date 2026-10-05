// Controller: change a user's role. Admin-only (anti self-promotion),
// anti-lockout (cannot remove the role from the last admin). upsert — the target user may
// not have a profile yet (first role assignment).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'

const schema = z.object({ role: z.enum(['viewer', 'operator', 'admin']) })

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const targetId = z.string().uuid().parse(getRouterParam(event, 'id'))
  const { role } = await readValidatedBody(event, schema.parse)
  const sr = serverSupabaseServiceRole(event)

  const { data: admins } = await sr.from('profiles').select('user_id').eq('role', 'admin')
  if (wouldOrphanAdmins((admins ?? []).map(a => a.user_id), targetId, role))
    throw createError({ statusCode: 409, statusMessage: 'Cannot demote the last admin' })

  const { error } = await sr.from('profiles')
    .upsert({ user_id: targetId, role, updated_at: new Date().toISOString() })
  if (error)
    throw createError({ statusCode: 500, statusMessage: error.message })

  return { ok: true, role }
})
