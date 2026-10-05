// Controller: list of task definitions + their triggers.
// Task authoring = admin (ADR-013): a task runs arbitrary code.
import { serverSupabaseServiceRole } from '#supabase/server'
import { listTasks, listTriggers } from '../../../repositories/tasks'
import { runnersFromConfig } from '../../../utils/task-runners'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const sr = serverSupabaseServiceRole(event)
  const tasks = await listTasks(sr)
  const withTriggers = await Promise.all(tasks.map(async t => ({
    ...t,
    triggers: await listTriggers(sr, t.id),
  })))
  // List of configured runtimes — so the UI does not guess what is available.
  return { tasks: withTriggers, runtimes: Object.keys(runnersFromConfig(event).registry) }
})
