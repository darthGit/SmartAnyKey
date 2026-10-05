// Controller: enable the backup with one click.
// Admin-only. Only `enabled` is switched on — the schedule is already in the task trigger
// (`0 3 * * *`, migration 0018), so the client has nothing to fill in.
import { serverSupabaseServiceRole } from '#supabase/server'
import { enableBackup } from '../../services/setup-backup'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  return await enableBackup(serverSupabaseServiceRole(event))
})
