// Controller: re-run a run on the same data
// (payload from the snapshot, not from the current state of the external system).
// The gate is the task's `min_role`, like a manual run.
import { serverSupabaseServiceRole } from '#supabase/server'
import { getRun } from '../../../../repositories/task-runs'
import { getTask } from '../../../../repositories/tasks'
import { rerun } from '../../../../services/tasks'
import { credKey, runnersFromConfig } from '../../../../utils/task-runners'

export default defineEventHandler(async (event) => {
  const sr = serverSupabaseServiceRole(event)
  const run = await getRun(sr, getRouterParam(event, 'runId')!)
  if (!run?.task_id)
    throw createError({ statusCode: 404, statusMessage: 'run not found' })
  const task = await getTask(sr, run.task_id)
  if (!task)
    throw createError({ statusCode: 409, statusMessage: 'task no longer exists' })

  const { user } = await requireRole(event, task.min_role)
  const result = await rerun(sr, {
    runId: run.id,
    actor: user.email ?? 'unknown',
    keyHex: credKey(event),
    runners: runnersFromConfig(event),
  })
  setResponseStatus(event, 202)
  return { runId: result.runId, status: result.status }
})
