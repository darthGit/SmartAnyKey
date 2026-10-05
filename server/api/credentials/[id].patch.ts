// Controller: edit a set. The password is updated ONLY if provided
// (write-only: the form does not show the existing one, empty field = leave as is).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { encryptToBytea } from '../../services/credentials'

const paramsSchema = z.object({ id: z.string().uuid() })
const bodySchema = z.object({
  name: z.string().min(1).optional(),
  username: z.string().nullish(),
  password: z.string().min(1).optional(), // present → replace; absent → keep
  port: z.number().int().positive().nullish(),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const body = await readValidatedBody(event, bodySchema.parse)
  const sr = serverSupabaseServiceRole(event)
  const config = useRuntimeConfig(event)

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.name !== undefined) patch.name = body.name
  if (body.username !== undefined) patch.username = body.username
  if (body.port !== undefined) patch.port = body.port
  if (body.password) patch.password_enc = encryptToBytea(body.password, config.credEncryptionKey)

  const { data, error } = await sr.from('credential_sets').update(patch).eq('id', id)
    .select('id,name,username,port').single()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return data
})
