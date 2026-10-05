// Controller: create a task. Admin-only (ADR-013).
// The runtime is validated against the configured ones (registry), not a list in code.
import { serverSupabaseServiceRole } from '#supabase/server'
import { createTask } from '../../../repositories/tasks'
import { makeTaskSchema } from '../../../services/task-runner'
import { runnersFromConfig } from '../../../utils/task-runners'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const runtimes = Object.keys(runnersFromConfig(event).registry)
  const body = await readValidatedBody(event, makeTaskSchema(runtimes).parse)
  const row = await createTask(serverSupabaseServiceRole(event), body)
  setResponseStatus(event, 201)
  return row
})
