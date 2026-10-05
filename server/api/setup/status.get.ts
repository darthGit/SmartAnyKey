// Controller: is the first-run screen open.
// No authentication — on a fresh install there is nobody to authenticate. The gate is
// DB state (`profiles.role='admin'`), and it is computed here, on the server: a gate only
// in the UI would mean an open admin creator (ADR-021).
import { serverSupabaseServiceRole } from '#supabase/server'
import { hasAnyAdmin } from '../../repositories/setup'

export default defineEventHandler(async (event) => {
  const closed = await hasAnyAdmin(serverSupabaseServiceRole(event))
  if (closed) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Setup is closed: this installation already has an admin',
    })
  }
  return { open: true }
})
