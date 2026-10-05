// Controller: a task's webhook trigger.
//
// The only entry point without session auth — external systems do not have our JWT, so
// requireUser/requireRole are deliberately NOT called here (ADR-013: the gate is for
// user actions, not machine calls). Authentication = the trigger token, which
// `services/tasks` compares by hash; flood protection — rate-limit (429).
import { runHook } from '../../../services/tasks'
import { serverSupabaseServiceRole } from '#supabase/server'
import { credKey, runnersFromConfig } from '../../../utils/task-runners'

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')!
  const payload = await readBody(event).catch(() => undefined)

  // Idempotency key: a standard header; a repeated delivery does not create
  // a second run. `?sync=1` — synchronous mode.
  const idempotencyKey = getHeader(event, 'idempotency-key') ?? null
  const rawQuery = getQuery(event)
  const sync = rawQuery.sync === '1' ? true : undefined

  // The rest of the query is caller data, delivered to the task as `RUN_QUERY`.
  // The payload body is left alone: it belongs to whoever sent the request, and
  // the query — to whoever built the URL (for a sink these are two different authors).
  const query: Record<string, string> = {}
  for (const [k, v] of Object.entries(rawQuery)) {
    if (k === 'sync')
      continue
    // An array (?a=1&a=2) collapses to the last value — the task needs a string.
    query[k] = String(Array.isArray(v) ? v[v.length - 1] : v)
  }

  const result = await runHook(serverSupabaseServiceRole(event), {
    token,
    payload,
    keyHex: credKey(event),
    runners: runnersFromConfig(event),
    idempotencyKey,
    sync,
    query: Object.keys(query).length ? query : null,
  })

  setResponseStatus(event, result.status)
  return result
})
