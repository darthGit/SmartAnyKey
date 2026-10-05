// Controller (ADR-010): ws bridge for browser↔guacd graphics. Mirror of
// terminal/[deviceId].ws.ts (ADR-007): validation at the boundary (zod uuid), auth via
// the service (authorizeUpgrade), logic in guac-bridge, DB in the repository
// (3-tier). One bridge per peer.
//
// Frames: the guac protocol is TEXT instructions both ways (Guacamole.Client ↔
// guacd through our own net bridge). peer.send(string) / bridge.send(message.text()).
// Control errors before connect are also sent as a guac 'error' instruction (fail()).
// ponytail: ws rate limit later (Phase 3), as in terminal.
import { z } from 'zod'
import { getDeviceForConnection } from '../../../repositories/devices'
import { resolveCredentials } from '../../../services/credentials'
import { adminClient, getUserByToken } from '../../../repositories/supabase-admin'
import { connectionParameters, resolveAction, sessionFailCode } from '../../../services/remote-session'
import { UpgradeUnauthorizedError, authorizeUpgrade } from '../../../services/ssh-bridge'
import { GuacAuthError, openGuacBridge } from '../../../services/guac-bridge'
import type { GuacBridge } from '../../../services/guac-bridge'

const idSchema = z.string().uuid()
const bridges = new WeakMap<object, GuacBridge>()
// DIAGNOSTIC (GUAC_HANDSHAKE_DEBUG): lifecycle log, to see WHO tears the connection
// and WHEN under the multi-panel — ws-close (browser) vs guacd-onClose (our bridge).
const hostByPeer = new WeakMap<object, string>()
const ctlDbg = !!process.env.GUAC_HANDSHAKE_DEBUG
function ctl(peer: object, ev: string) {
  if (ctlDbg)
    console.error(`[guac-ctl ${hostByPeer.get(peer) ?? '?'}] ${ev}`)
}

// A guac error goes to the client as a guac 'error' instruction, so Guacamole.Client
// shows the status (5.error,<msg>,<code>;), and we close the ws.
function fail(peer: { send: (d: string) => void, close: (code?: number, reason?: string) => void }, code: string) {
  peer.send(`5.error,${code.length}.${code},1.0;`)
  peer.close(1011, code)
}

export default defineWebSocketHandler({
  async open(peer) {
    try {
      const url = new URL(peer.request!.url)
      const deviceId = idSchema.parse(url.pathname.split('/').pop())
      // Token and action in the query (the browser WebSocket cannot send Authorization).
      const token = url.searchParams.get('token') ?? ''
      const requestedAction = url.searchParams.get('action') ?? undefined

      const user = await authorizeUpgrade(() => getUserByToken(token))

      const admin = adminClient()
      // RBAC: opening a session requires ≥operator. ws has no H3 event → getRoleForUser+hasRole.
      if (!hasRole(await getRoleForUser(admin, user.id), 'operator')) {
        fail(peer, 'auth')
        return
      }
      // Per user: a stolen or scripted token must not open sessions without bound.
      if (hitRate(`session:${user.id}`, LIMITS.sessionOpen, 60_000)) {
        fail(peer, 'rate')
        return
      }
      const device = await getDeviceForConnection(admin, deviceId)
      if (!device) {
        fail(peer, 'action')
        return
      }
      const action = resolveAction(device, requestedAction) // throws if the action is outside actions
      if (action === 'ssh' || action === 'web') {
        // graphics ws only for vnc/rdp; ssh has its own terminal ws, web is a redirect
        fail(peer, 'action')
        return
      }

      const cred = await resolveCredentials(admin, device.id, action, useRuntimeConfig().credEncryptionKey, {
        actor: user.email ?? user.id,
      })
      const cfg = useRuntimeConfig()
      hostByPeer.set(peer, device.host)
      ctl(peer, 'open→openGuacBridge')
      const bridge = await openGuacBridge({
        guacdHost: cfg.guacdHost,
        guacdPort: Number(cfg.guacdPort),
        protocol: action,
        params: connectionParameters(action, device.host, cred),
        onData: chunk => peer.send(chunk),
        onClose: () => { ctl(peer, 'guacd-onClose → peer.close()'); peer.close() },
      })
      bridges.set(peer, bridge)
      ctl(peer, 'bridge established (ready)')
    }
    catch (err) {
      if (err instanceof UpgradeUnauthorizedError) {
        peer.close(1008, 'unauthorized')
        return
      }
      if (err instanceof GuacAuthError) {
        fail(peer, 'auth')
        return
      }
      fail(peer, sessionFailCode(err, 'guac'))
    }
  },

  message(peer, message) {
    // guac instruction from Guacamole.Client → straight to guacd
    bridges.get(peer)?.send(message.text())
  },

  close(peer) {
    ctl(peer, 'ws-close (browser closed the ws) → bridge.close')
    bridges.get(peer)?.close()
    bridges.delete(peer)
  },

  error(peer) {
    ctl(peer, 'ws-error → bridge.close')
    bridges.get(peer)?.close()
    bridges.delete(peer)
  },
})
