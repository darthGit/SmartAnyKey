// Controller: JSON variant for a click. After ADR-010 it serves ONLY the web action
// (external link); vnc/rdp/ssh are opened by the frontend directly via
// ws bridges. Validation at the boundary (zod), logic — service, DB — repository.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { getDeviceForConnection } from '../repositories/devices'
import { buildSessionResponse } from '../services/session-response'

const bodySchema = z.object({
  deviceId: z.string().uuid(),
  action: z.enum(['vnc', 'rdp', 'ssh', 'web']).optional(),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'operator')
  const body = await readValidatedBody(event, bodySchema.parse)
  const sr = serverSupabaseServiceRole(event)
  const device = await getDeviceForConnection(sr, body.deviceId)
  if (!device)
    throw createError({ statusCode: 404, statusMessage: 'Device not found' })
  // Throws for non-web actions (their place is the ws bridge); the frontend no longer
  // comes here for graphics/ssh.
  return buildSessionResponse({ device, requestedAction: body.action })
})
