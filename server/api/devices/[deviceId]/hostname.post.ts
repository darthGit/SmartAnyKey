// Controller: "Check name" — read the hostname from the machine itself over SSH.
// Synchronous (one built-in command, ~200ms),
// unlike probe/exec, which detach and are polled.
// Gate: operator (ADR-013 — an action beyond access). Renaming (`label`) stays
// admin-only: `PATCH /api/admin/devices/[id]`, developer decision 2026-08-14.
// Audit: a `task_run(kind='hostname-check')` row (ADR-011) + credential_access_log
// from resolveCredentials — as for the other device actions.
// 3-tier: logic in services/hostname, DB in repositories.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { getDeviceForConnection, readHostnameFact } from '../../../repositories/devices'
import { finish, insertRunning } from '../../../repositories/task-runs'
import { checkHostname } from '../../../services/hostname'

export default defineEventHandler(async (event) => {
  const { user } = await requireRole(event, 'operator')
  const deviceId = z.string().uuid().parse(getRouterParam(event, 'deviceId'))
  const sr = serverSupabaseServiceRole(event)

  const device = await getDeviceForConnection(sr, deviceId)
  if (!device)
    throw createError({ statusCode: 404, statusMessage: 'Device not found' })
  // The same clean skip as in Tier-B: a device without ssh is not an error, just
  // unreachable over this transport (NSE/PTR remain).
  if (!device.actions.includes('ssh')) {
    setResponseStatus(event, 200)
    return { status: 'skipped', reason: 'no-ssh' }
  }

  const actor = user.email ?? user.id
  const current = await readHostnameFact(sr, deviceId)
  const run = await insertRunning(sr, {
    kind: 'hostname-check',
    actor,
    deviceId,
    refId: null,
    label: 'hostname',
    input: { body: 'hostname', interpreter: 'raw' },
  })
  const res = await checkHostname(sr, {
    device: { id: device.id, host: device.host, actions: device.actions, meta: device.meta },
    current,
    actor,
    keyHex: useRuntimeConfig(event).credEncryptionKey,
  })
  await finish(sr, run.id, res.status === 'ok'
    ? { status: 'done', result: { hostname: res.fact.value, source: res.fact.source, applied: res.applied }, error: null }
    : { status: 'failed', result: null, error: res.error })

  if (res.status === 'failed')
    throw createError({ statusCode: 502, statusMessage: `hostname: ${res.error}` })
  return { status: 'ok', hostname: res.fact.value, source: res.fact.source, at: res.fact.at, applied: res.applied }
})
