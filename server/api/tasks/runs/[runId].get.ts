// Controller: run detail (phases, log, artifacts).
// Same visibility as the log: your own run — to everyone, someone else's — admin only.
import { serverSupabaseServiceRole } from '#supabase/server'
import { getRun } from '../../../repositories/task-runs'
import { listArtifacts } from '../../../repositories/task-artifacts'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const role = await getRole(event)
  const sr = serverSupabaseServiceRole(event)
  const run = await getRun(sr, getRouterParam(event, 'runId')!)
  if (!run)
    throw createError({ statusCode: 404, statusMessage: 'run not found' })
  if (role !== 'admin' && run.actor !== user.email)
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  return { ...run, artifacts: await listArtifacts(sr, run.id) }
})
