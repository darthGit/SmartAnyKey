// Controller: per-protocol cred status for the admin UI.
// Admin-only (ADR-013). Read via service_role (credential_bindings RLS deny-all);
// the secret does NOT leak — only {action, resolved, level}. web = URL without a cred → excluded.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { getDeviceForConnection } from '../../../../repositories/devices'
import { credStatus } from '../../../../services/credentials'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  const sr = serverSupabaseServiceRole(event)
  const dev = await getDeviceForConnection(sr, id)
  if (!dev)
    throw createError({ statusCode: 404, statusMessage: 'device not found' })
  const creddable = dev.actions.filter(a => a !== 'web') as ('vnc' | 'rdp' | 'ssh')[]
  return credStatus(sr, id, creddable)
})
