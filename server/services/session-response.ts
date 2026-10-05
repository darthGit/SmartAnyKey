// Builds the session response for remote-session controllers. After ADR-010 only
// the web action remains here (WebFig etc.) — a direct external link. vnc/rdp go
// via the ws bridge (/api/guac/:id), ssh — via /api/terminal/:id; no
// json-auth minting.
import type { DeviceForConnection } from '../repositories/devices'
import { resolveAction } from './remote-session'

export interface SessionResponse {
  kind: 'web'
  sessionUrl: string
}

export function buildSessionResponse(opts: {
  device: DeviceForConnection
  requestedAction: string | undefined
}): SessionResponse {
  const action = resolveAction(opts.device, opts.requestedAction)
  if (action !== 'web')
    throw new Error(`Action "${action}" opens through the ws bridge, not through remote-session`)
  return { kind: 'web', sessionUrl: `http://${opts.device.host}` }
}
