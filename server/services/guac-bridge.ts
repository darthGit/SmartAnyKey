// Domain service: orchestrates the guacd bridge between the ws peer and the repo (no
// direct net/guacd). Mirror of ssh-bridge.ts (ADR-010, ADR-007).
// Classifies repo errors into typed ones (GuacAuthError / GuacConnectError).
// Creds stay here ↔ guacd; they never reach the bridge surface (send/close).
import { openGuacTunnel } from '../repositories/guac'

export class GuacAuthError extends Error {}
export class GuacConnectError extends Error {}

export interface GuacBridge {
  send: (data: string) => void
  close: () => void
}

export async function openGuacBridge(opts: {
  guacdHost?: string
  guacdPort?: number
  protocol: string
  // target parameters from connectionParameters() — hostname/port/password/[username]/...
  params: Record<string, string>
  width?: number
  height?: number
  onData: (chunk: string) => void
  onClose: () => void
}): Promise<GuacBridge> {
  try {
    // onData/onClose are passed to the repo — it subscribes them on GuacdClient before
    // 'ready', so the initial framebuffer is not lost. The returned tunnel
    // ({send,close}) is the bridge surface — creds stay inside the tunnel.
    return await openGuacTunnel({
      guacdHost: opts.guacdHost ?? '127.0.0.1',
      guacdPort: opts.guacdPort ?? 4822,
      protocol: opts.protocol,
      onData: opts.onData,
      onClose: opts.onClose,
      ...opts.params,
      ...(opts.width ? { width: opts.width } : {}),
      ...(opts.height ? { height: opts.height } : {}),
    })
  }
  catch (err) {
    // ponytail: guacd returns an auth failure (e.g. a wrong VNC password) as a separate
    // guac 'error' instruction AFTER connect — it reaches the client as 'data', so
    // no reject here. guacUnauthorized stays as a seam for future server-side
    // classification; for now almost every failure here is a connect error.
    if ((err as { guacUnauthorized?: boolean })?.guacUnauthorized)
      throw new GuacAuthError((err as Error).message)
    throw new GuacConnectError((err as Error)?.message ?? 'guacd connect failed')
  }
}
