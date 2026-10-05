// Controller: edit a contact. Operator gate (ADR-013). The repo is scoped by both
// point_id and id → a substituted foreign pointId gives 404, not an edit of a
// neighbouring point's contact.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { updateContact } from '../../../../repositories/point-contacts'
import { contactPatchSchema } from '../../../../services/point-contacts'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'operator')
  const pointId = z.string().uuid().parse(getRouterParam(event, 'pointId'))
  const contactId = z.string().uuid().parse(getRouterParam(event, 'contactId'))
  const patch = await readValidatedBody(event, contactPatchSchema.parse)
  return updateContact(serverSupabaseServiceRole(event), pointId, contactId, patch)
})
