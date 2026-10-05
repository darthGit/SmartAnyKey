// Controller: GET variant for native middle-click (<a href> → new tab).
// Auth — cookie session. After ADR-010 a new tab remains only for the web action
// (302 to an external URL); vnc/rdp/ssh live as panes on the board, so for
// them we redirect to the board.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { getDeviceForConnection } from '../../repositories/devices'
import { resolveAction } from '../../services/remote-session'
import { buildSessionResponse } from '../../services/session-response'

const paramsSchema = z.object({ deviceId: z.string().uuid() })
const querySchema = z.object({ action: z.enum(['vnc', 'rdp', 'ssh', 'web']).optional() })

export default defineEventHandler(async (event) => {
  await requireRole(event, 'operator')
  const { deviceId } = await getValidatedRouterParams(event, paramsSchema.parse)
  const { action } = await getValidatedQuery(event, querySchema.parse)
  const sr = serverSupabaseServiceRole(event)
  const device = await getDeviceForConnection(sr, deviceId)
  if (!device)
    throw createError({ statusCode: 404, statusMessage: 'Device not found' })
  // Graphics/ssh — a pane on the board; a new tab has no separate session URL.
  // ponytail: a deep link into the board (`/?device=&action=`) with auto-openPane is
  // a separate UI step; for now redirect to the root.
  if (resolveAction(device, action) !== 'web')
    return sendRedirect(event, '/', 302)
  const { sessionUrl } = buildSessionResponse({ device, requestedAction: action })
  return sendRedirect(event, sessionUrl, 302)
})
