// Controller: add a contact.
// The gate is **operator**, not admin (ADR-013): a number is dictated to the technician during
// a call, and they must record it themselves. The same level as the point note
// (note.patch.ts) — a contact is the structured half of the operator's memory.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { createContact } from '../../../repositories/point-contacts'
import { contactCreateSchema } from '../../../services/point-contacts'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'operator')
  const pointId = z.string().uuid().parse(getRouterParam(event, 'pointId'))
  const body = await readValidatedBody(event, contactCreateSchema.parse)
  const row = await createContact(serverSupabaseServiceRole(event), pointId, body)
  setResponseStatus(event, 201)
  return row
})
