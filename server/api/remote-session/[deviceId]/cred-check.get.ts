// Controller: pre-check that a credential exists before
// opening the pane (ssh/vnc/rdp). The client calls this before openPane; no cred →
// a modal with instructions instead of an opaque abort in guacd. requireRole('operator')
// (ADR-013) — the same gate as on connect. The secret is NOT read/decrypted.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { hasCredential } from '../../../services/credentials'

const paramsSchema = z.object({ deviceId: z.string().uuid() })
const querySchema = z.object({ action: z.enum(['vnc', 'rdp', 'ssh']) })

export default defineEventHandler(async (event) => {
  await requireRole(event, 'operator')
  const { deviceId } = await getValidatedRouterParams(event, paramsSchema.parse)
  const { action } = await getValidatedQuery(event, querySchema.parse)
  const sr = serverSupabaseServiceRole(event)
  return { hasCred: await hasCredential(sr, deviceId, action) }
})
