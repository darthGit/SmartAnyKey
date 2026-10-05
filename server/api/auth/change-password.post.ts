// Controller: self password change. Target = the logged-in user
// (requireUser().id), NOT from the body — otherwise escalation. Clears the forced change.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { changeOwnPassword } from '../../services/user-admin'

const schema = z.object({ password: z.string().min(8) })

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  assertRate(event, `pwd:${user.id}`, LIMITS.authAction)
  const { password } = await readValidatedBody(event, schema.parse)
  await changeOwnPassword(serverSupabaseServiceRole(event), user.id, password)
  return { ok: true }
})
