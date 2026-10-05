// Controller (ADR-007): ws terminal bridge. Validation at the boundary (zod uuid),
// auth via the service (authorizeUpgrade), logic — ssh-bridge, DB — repository
// (3-Tier). One bridge per peer; lifecycle: open→bridge,
// message→write/resize, close/error→bridge.close().
//
// Frames: tty goes to the client as binary (peer.send(Buffer)); control/errors —
// JSON text ({type:'error',code}). The client tells them apart by frame type.
// ponytail: ws rate-limit later (Phase 3).
import { z } from 'zod'
import { getDeviceForConnection } from '../../../repositories/devices'
import { sessionFailCode } from '../../../services/remote-session'
import { resolveCredentials } from '../../../services/credentials'
import { adminClient, getUserByToken } from '../../../repositories/supabase-admin'
import {
  SshAuthError,
  UpgradeUnauthorizedError,
  authorizeUpgrade,
  openSshBridge,
  resolveSshConnection,
} from '../../../services/ssh-bridge'
import type { SshBridge } from '../../../services/ssh-bridge'

const idSchema = z.string().uuid()
const bridges = new WeakMap<object, SshBridge>()

function fail(peer: { send: (d: string) => void, close: (code?: number, reason?: string) => void }, code: string) {
  peer.send(JSON.stringify({ type: 'error', code }))
  peer.close(1011, code)
}

export default defineWebSocketHandler({
  async open(peer) {
    try {
      const url = new URL(peer.request!.url)
      const deviceId = idSchema.parse(url.pathname.split('/').pop())
      // Token in the query (a browser WebSocket cannot send Authorization).
      // ponytail: a query token is ok for a localhost internal tool; move it to a
      // cookie/subprotocol if ws goes beyond localhost (URL logs).
      const token = url.searchParams.get('token') ?? ''

      const user = await authorizeUpgrade(() => getUserByToken(token))

      const admin = adminClient()
      // RBAC: opening a session ≥operator. ws has no H3 event → getRoleForUser+hasRole.
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
      resolveSshConnection(device) // throws if 'ssh' is not in actions

      const cred = await resolveCredentials(admin, device.id, 'ssh', useRuntimeConfig().credEncryptionKey, {
        actor: user.email ?? user.id,
      })
      const bridge = await openSshBridge({
        host: device.host,
        port: cred?.port ?? 22,
        username: cred?.username ?? '',
        password: cred?.password ?? '',
        cols: 80,
        rows: 24,
        onData: chunk => peer.send(chunk),
        onClose: () => peer.close(),
      })
      bridges.set(peer, bridge)
    }
    catch (err) {
      if (err instanceof UpgradeUnauthorizedError) {
        peer.close(1008, 'unauthorized')
        return
      }
      if (err instanceof SshAuthError) {
        fail(peer, 'auth')
        return
      }
      fail(peer, sessionFailCode(err, 'terminal'))
    }
  },

  message(peer, message) {
    const bridge = bridges.get(peer)
    if (!bridge)
      return
    let msg: { type?: string, data?: string, cols?: number, rows?: number }
    try {
      msg = JSON.parse(message.text())
    }
    catch {
      return
    }
    if (msg.type === 'input' && typeof msg.data === 'string')
      bridge.write(msg.data)
    else if (msg.type === 'resize' && msg.cols && msg.rows)
      bridge.resize(msg.cols, msg.rows)
  },

  close(peer) {
    bridges.get(peer)?.close()
    bridges.delete(peer)
  },

  error(peer) {
    bridges.get(peer)?.close()
    bridges.delete(peer)
  },
})
