// Controller: copy-password for cases outside a session (audited, ADR-009).
// Resolves the device's set, returns plaintext ONLY in the response body (TLS) and
// writes action:'copy' to credential_access_log. For a future UI button.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { getDeviceForConnection } from '../../repositories/devices'
import { resolveCredentials } from '../../services/credentials'
import { resolveAction } from '../../services/remote-session'

const schema = z.object({
  deviceId: z.string().uuid(),
  action: z.enum(['vnc', 'rdp', 'ssh']).optional(), // no web: web has no credentials
})

export default defineEventHandler(async (event) => {
  const { user } = await requireRole(event, 'admin')
  const { deviceId, action } = await readValidatedBody(event, schema.parse)
  const sr = serverSupabaseServiceRole(event)
  const device = await getDeviceForConnection(sr, deviceId)
  if (!device)
    throw createError({ statusCode: 404, statusMessage: 'Device not found' })
  const config = useRuntimeConfig(event)
  const resolved = resolveAction(device, action) // the device default, if unset
  // resolve with audit action:'copy' — the log records the set actually chosen.
  const cred = await resolveCredentials(sr, device.id, resolved, config.credEncryptionKey, {
    actor: user.email ?? user.id,
    action: 'copy',
  })
  if (!cred?.password)
    throw createError({ statusCode: 404, statusMessage: 'No password for device' })
  return { username: cred.username, password: cred.password }
})
