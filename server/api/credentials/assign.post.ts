// Controller: bind a set to (level, target, action). credSetId:null → remove the
// binding. The model is keyed by action (ADR-009 amendment): credential_bindings.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'

const schema = z.object({
  level: z.enum(['device', 'type', 'point', 'global']),
  targetId: z.string().uuid().nullable(), // null only for global
  action: z.enum(['vnc', 'rdp', 'ssh']),
  credSetId: z.string().uuid().nullable(),
}).refine(b => (b.level === 'global') === (b.targetId === null), {
  message: 'targetId must be null only for level=global',
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const body = await readValidatedBody(event, schema.parse)
  const sr = serverSupabaseServiceRole(event)

  // Remove the existing binding on this (level, target, action) — idempotent upsert.
  let del = sr.from('credential_bindings').delete().eq('level', body.level).eq('action', body.action)
  del = body.targetId === null ? del.is('target_id', null) : del.eq('target_id', body.targetId)
  const { error: delErr } = await del
  if (delErr)
    throw createError({ statusCode: 502, statusMessage: `DB: ${delErr.message}` })

  if (body.credSetId) {
    const { error } = await sr.from('credential_bindings').insert({
      level: body.level, target_id: body.targetId, action: body.action, cred_set_id: body.credSetId,
    })
    if (error)
      throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  }
  return { ok: true }
})
