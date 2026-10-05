// Controller: drift inbox — points with unacknowledged drift,
// grouped + escalated flags. Admin-gated read (service_role bypasses RLS).
import { serverSupabaseServiceRole } from '#supabase/server'
import { driftInbox } from '../../services/drift'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  return await driftInbox(serverSupabaseServiceRole(event))
})
