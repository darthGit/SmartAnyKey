// Controller: point note.
// Operator gate: a viewer reads the note (RLS points select), only
// operator+ edits. Limit 2000 — zod here + DB CHECK (0014). points write =
// service_role → we write via the BFF.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { NOTE_MAX, updateNote } from '../../../services/notes'

const bodySchema = z.object({ note: z.string().max(NOTE_MAX) })

export default defineEventHandler(async (event) => {
  await requireRole(event, 'operator')
  const pointId = z.string().uuid().parse(getRouterParam(event, 'pointId'))
  const { note } = await readValidatedBody(event, bodySchema.parse)
  const sr = serverSupabaseServiceRole(event)
  await updateNote({
    write: async (id, n) => {
      const { error } = await sr.from('points').update({ note: n }).eq('id', id)
      if (error)
        throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
    },
  }, pointId, note)
  return { ok: true }
})
