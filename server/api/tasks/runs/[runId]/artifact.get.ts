// Controller: download a run artifact.
// The bucket is PRIVATE — we return a signed URL with a short TTL after the RBAC check
// (same visibility as the run detail).
import { serverSupabaseServiceRole } from '#supabase/server'
import { getRun } from '../../../../repositories/task-runs'
import { listArtifacts, signedArtifactUrl } from '../../../../repositories/task-artifacts'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const role = await getRole(event)
  const sr = serverSupabaseServiceRole(event)
  const run = await getRun(sr, getRouterParam(event, 'runId')!)
  if (!run)
    throw createError({ statusCode: 404, statusMessage: 'run not found' })
  if (role !== 'admin' && run.actor !== user.email)
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })

  const path = String(getQuery(event).path ?? '')
  // The path must belong to THIS run — otherwise the signed URL would become
  // a reader of other runs' artifacts.
  const own = (await listArtifacts(sr, run.id)).find(a => a.path === path)
  if (!own)
    throw createError({ statusCode: 404, statusMessage: 'artifact not found' })

  return { url: await signedArtifactUrl(sr, own.path), name: own.path.split('/').pop(), size: own.size }
})
