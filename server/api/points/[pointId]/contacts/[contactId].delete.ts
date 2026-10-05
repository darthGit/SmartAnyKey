// Controller: delete a contact.
// Operator gate (ADR-013), the same per-point scope as in patch.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { deleteContact } from '../../../../repositories/point-contacts'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'operator')
  const pointId = z.string().uuid().parse(getRouterParam(event, 'pointId'))
  const contactId = z.string().uuid().parse(getRouterParam(event, 'contactId'))
  await deleteContact(serverSupabaseServiceRole(event), pointId, contactId)
  setResponseStatus(event, 204)
  return null
})
