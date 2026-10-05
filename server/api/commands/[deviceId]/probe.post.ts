// Controller: run a Tier-B probe on a device.
// Gate: purpose='probe' command + device exposes SSH. No SSH → clean skip
// (Windows-without-SSH doesn't run Tier-B and doesn't fall over — no task_run).
// Otherwise insert task_run(kind='probe') + detached run (fingerprint + drift).
// 3-Tier: logic in services/probe, DB in repositories.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { getDeviceForConnection, readProbeHash } from '../../../repositories/devices'
import { getById } from '../../../repositories/device-commands'
import { insertRunning } from '../../../repositories/task-runs'
import { runProbeDetached } from '../../../services/probe'

const bodySchema = z.object({ commandId: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const { user } = await requireRole(event, 'operator')
  const deviceId = z.string().uuid().parse(getRouterParam(event, 'deviceId'))
  const { commandId } = await readValidatedBody(event, bodySchema.parse)
  const sr = serverSupabaseServiceRole(event)

  const device = await getDeviceForConnection(sr, deviceId)
  if (!device)
    throw createError({ statusCode: 404, statusMessage: 'Device not found' })
  const command = await getById(sr, commandId)
  if (!command)
    throw createError({ statusCode: 404, statusMessage: 'Command not found' })
  if (command.purpose !== 'probe')
    throw createError({ statusCode: 400, statusMessage: 'Not a probe command' })

  // Gate: no SSH action → skip Tier-B cleanly (Tier-A identity untouched).
  if (!device.actions.includes('ssh')) {
    setResponseStatus(event, 200)
    return { status: 'skipped', reason: 'no-ssh' }
  }

  const actor = user.email ?? user.id
  const previousHash = await readProbeHash(sr, deviceId)
  const run = await insertRunning(sr, {
    kind: 'probe',
    actor,
    deviceId,
    refId: command.id,
    label: command.name,
    input: { body: command.body, interpreter: command.interpreter },
  })
  runProbeDetached(sr, run.id, {
    device: { id: device.id, host: device.host, actions: device.actions },
    command: {
      id: command.id, label: command.name, body: command.body,
      interpreter: command.interpreter, timeout_s: command.timeout_s,
      purpose: command.purpose, stable: command.stable,
    },
    actor,
    keyHex: useRuntimeConfig(event).credEncryptionKey,
    previousHash,
  })

  setResponseStatus(event, 202)
  return { executionId: run.id }
})
