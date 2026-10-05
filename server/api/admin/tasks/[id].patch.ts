// Controller: edit a task. Admin-only (ADR-013).
import { createError } from 'h3'
import { serverSupabaseServiceRole } from '#supabase/server'
import { getTask, updateTask } from '../../../repositories/tasks'
import { builtinPatchViolation } from '../../../services/task-builtins'
import { makeTaskPatchSchema } from '../../../services/task-runner'
import { runnersFromConfig } from '../../../utils/task-runners'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = getRouterParam(event, 'id')!
  const runtimes = Object.keys(runnersFromConfig(event).registry)
  // Patch schema (NOT `makeTaskSchema().partial()`): we edit any subset of
  // fields, and the output has exactly the keys that came in — the `enabled` toggle
  // must not rewrite the task body.
  const body = await readValidatedBody(event, makeTaskPatchSchema(runtimes).parse)

  const sr = serverSupabaseServiceRole(event)
  // A built-in task's body (ADR-018 amendment #4) is our code, not installation data.
  const task = await getTask(sr, id)
  if (!task)
    throw createError({ statusCode: 404, statusMessage: 'task not found' })
  const violation = builtinPatchViolation(task, body as Record<string, unknown>)
  if (violation)
    throw createError({ statusCode: 400, statusMessage: violation })

  return await updateTask(sr, id, body)
})
