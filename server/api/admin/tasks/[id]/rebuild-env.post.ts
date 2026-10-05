// Controller: force-rebuild the environment
// with unchanged `deps` (e.g. to pull fresh patches). Admin-only (ADR-013) —
// it spends runner resources, not a routine operator action.
import { serverSupabaseServiceRole } from '#supabase/server'
import { getTask } from '../../../../repositories/tasks'
import { runTask } from '../../../../services/task-runner'
import { credKey, runnersFromConfig } from '../../../../utils/task-runners'

export default defineEventHandler(async (event) => {
  const { user } = await requireRole(event, 'admin')
  const id = getRouterParam(event, 'id')!
  const sr = serverSupabaseServiceRole(event)
  const task = await getTask(sr, id)
  if (!task)
    throw createError({ statusCode: 404, statusMessage: 'task not found' })

  const result = await runTask(sr, {
    task,
    actor: user.email ?? 'admin',
    keyHex: credKey(event),
    runners: runnersFromConfig(event),
    rebuildEnv: true,
  })
  return { runId: result.runId, status: result.status, envKey: result.envKey }
})
