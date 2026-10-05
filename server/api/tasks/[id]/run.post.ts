// Controller: manual task run.
// Gate — the task's own `min_role` (not a constant): an admin task is refused to an
// operator, an operator task is allowed (ADR-013 "actions are gated by requireRole").
// The run is detached: we return 202 + the row id after it is saved, as in ADR-011.
import { serverSupabaseServiceRole } from '#supabase/server'
import { getTask } from '../../../repositories/tasks'
import { runTask } from '../../../services/task-runner'
import { credKey, runnersFromConfig } from '../../../utils/task-runners'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  // Read the definition before the gate: the minimum role is a property of the task.
  const sr = serverSupabaseServiceRole(event)
  const task = await getTask(sr, id)
  if (!task)
    throw createError({ statusCode: 404, statusMessage: 'task not found' })
  if (!task.enabled)
    throw createError({ statusCode: 409, statusMessage: 'task disabled' })

  const { user } = await requireRole(event, task.min_role)

  const started = new Promise<string>((resolve) => {
    const running = runTask(sr, {
      task,
      actor: user.email ?? 'unknown',
      keyHex: credKey(event),
      runners: runnersFromConfig(event),
      onStarted: resolve,
    })
    running.catch(() => { /* the final state lands in task_run; not swallowed here */ })
  })

  setResponseStatus(event, 202)
  return { runId: await started }
})
