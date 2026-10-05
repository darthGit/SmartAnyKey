// Controller: state of the built-in backup task for the first-run finish block.
// Admin-only, like the task itself (ADR-018 amendment #4: the dump = all client data).
//
// A separate route, not `GET /api/admin/tasks`: that list needs runtimes,
// triggers and bodies of all tasks, while the first-run finish needs one row and its time.
import { serverSupabaseServiceRole } from '#supabase/server'
import { backupOnRampState } from '../../services/setup-backup'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  return await backupOnRampState(serverSupabaseServiceRole(event))
})
