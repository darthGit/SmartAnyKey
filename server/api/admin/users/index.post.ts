// Controller: create a user (admin). Returns the
// generated temp password — the admin shows it once. requireRole — auto-imported.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { createUser } from '../../../services/user-admin'

const schema = z.object({
  email: z.string().email(),
  role: z.enum(['viewer', 'operator', 'admin']),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const body = await readValidatedBody(event, schema.parse)
  return createUser(serverSupabaseServiceRole(event), body)
})
