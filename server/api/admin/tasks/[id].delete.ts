// Controller: delete a task. Admin-only (ADR-013).
// Triggers cascade (FK), runs remain with task_id=null — the audit trail
// outlives the definition (same principle as the label snapshot of ADR-011).
import { createError } from 'h3'
import { serverSupabaseServiceRole } from '#supabase/server'
import { getTask, removeTask } from '../../../repositories/tasks'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = getRouterParam(event, 'id')!
  const sr = serverSupabaseServiceRole(event)

  // A builtin task cannot be deleted: its row is set by a migration, so
  // an admin could not restore it short of reinstalling (ADR-018 amendment 4).
  const task = await getTask(sr, id)
  if (task?.builtin) {
    throw createError({
      statusCode: 409,
      statusMessage: `built-in task "${task.builtin}" cannot be deleted — turn it off with its toggle`,
    })
  }

  await removeTask(sr, id)
  return { ok: true }
})
