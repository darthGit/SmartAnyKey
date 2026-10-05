// Controller: a type's command list for the context menu (?typeId=). ≥viewer: the read
// goes through the service role, which skips RLS, so the role gate is the only gate (ADR-013).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { listByType } from '../../repositories/device-commands'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'viewer')
  const typeId = z.string().uuid().parse(getQuery(event).typeId)
  // Returns ALL commands (action + probe); the board context menu filters to
  // action, the admin editor needs both.
  return listByType(serverSupabaseServiceRole(event), typeId)
})
