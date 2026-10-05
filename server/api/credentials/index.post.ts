// Controller: create a set. The password is encrypted before the write (write-only).
// One global default: enabling a new one → clears the previous one (partial-unique).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { encryptToBytea } from '../../services/credentials'

const schema = z.object({
  name: z.string().min(1),
  username: z.string().nullish(),
  password: z.string().nullish(),
  port: z.number().int().positive().nullish(),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const body = await readValidatedBody(event, schema.parse)
  const sr = serverSupabaseServiceRole(event)
  const config = useRuntimeConfig(event)

  const { data, error } = await sr.from('credential_sets').insert({
    name: body.name,
    username: body.username ?? null,
    password_enc: body.password ? encryptToBytea(body.password, config.credEncryptionKey) : null,
    port: body.port ?? null,
  }).select('id,name,username,port').single()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return data
})
