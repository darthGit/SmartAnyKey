// Controller: run log.
// Visibility mirrors the `task_run` RLS policy (0015): admin sees all (including
// `actor='scheduler'`), the rest — their own. We read as service_role (it bypasses RLS),
// so the filter must be applied in code.
import { serverSupabaseServiceRole } from '#supabase/server'
import { listRuns } from '../../../repositories/task-runs'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const role = await getRole(event)
  const q = getQuery(event)
  return await listRuns(serverSupabaseServiceRole(event), {
    taskId: typeof q.taskId === 'string' ? q.taskId : undefined,
    status: typeof q.status === 'string' ? q.status : undefined,
    // Not admin → own runs only.
    actor: role === 'admin' ? undefined : (user.email ?? '—'),
    limit: Math.min(Number(q.limit ?? 50), 200),
    offset: Number(q.offset ?? 0),
  })
})
