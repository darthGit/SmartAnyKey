// Controller: run a type's command
// on a device as a task. Inserts task_run(running), detaches, returns 202 —
// the client polls the row. 3-Tier: logic in command-runner, DB in repositories.
// Phase 2: the run gate = per-command min_role (command authoring = admin in
// /admin/commands); target=local is dispatched to the executor service.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { getDeviceForConnection } from '../../../repositories/devices'
import { getById } from '../../../repositories/device-commands'
import { insertRunning } from '../../../repositories/task-runs'
import { runDetached } from '../../../services/command-runner'
import { hasRole } from '../../../utils/rbac'

const bodySchema = z.object({
  commandId: z.string().uuid(),
  formValues: z.record(z.string(), z.string()).optional(),
})

export default defineEventHandler(async (event) => {
  // Floor ≥operator (ADR-013 invariant: exec is never viewer); per-command
  // min_role may escalate to admin (gate below, after fetching the command).
  const { user, role } = await requireRole(event, 'operator')
  const deviceId = z.string().uuid().parse(getRouterParam(event, 'deviceId'))
  const { commandId, formValues } = await readValidatedBody(event, bodySchema.parse)
  const sr = serverSupabaseServiceRole(event)

  const device = await getDeviceForConnection(sr, deviceId)
  if (!device)
    throw createError({ statusCode: 404, statusMessage: 'Device not found' })
  const command = await getById(sr, commandId)
  if (!command)
    throw createError({ statusCode: 404, statusMessage: 'Command not found' })

  // Per-command run gate: a role below min_role → 403.
  if (!hasRole(role, command.min_role))
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })

  const actor = user.email ?? user.id
  const cfg = useRuntimeConfig(event)
  const run = await insertRunning(sr, {
    kind: command.target === 'local' ? 'local-command' : 'ssh-command',
    actor,
    deviceId,
    refId: command.id,
    label: command.name,
    // Snapshot of body/interpreter/target — without env values (secrets/meta).
    input: { body: command.body, interpreter: command.interpreter, target: command.target },
  })
  runDetached(sr, run.id, {
    device: { id: device.id, host: device.host, actions: device.actions, meta: device.meta },
    command: {
      id: command.id, label: command.name, body: command.body,
      interpreter: command.interpreter, timeout_s: command.timeout_s,
      target: command.target, credRefs: command.cred_refs,
    },
    actor,
    keyHex: cfg.credEncryptionKey,
    formValues,
    executor: { url: cfg.executorUrl, secret: cfg.executorSecret },
  })

  setResponseStatus(event, 202)
  return { executionId: run.id }
})
