// Domain service: orchestrates the SSH bridge between the ws peer and the repo (no
// ssh2 import). Classifies repo errors into typed ones (SshAuthError / SshConnectError),
// authorises the ws upgrade, resolves the device's SSH action. (ADR-007)
import { openShell } from '../repositories/ssh'
import { resolveAction } from './remote-session'
import type { ConnectableDevice, GuacAction } from './remote-session'

export class SshAuthError extends Error {}
export class SshConnectError extends Error {}
export class UpgradeUnauthorizedError extends Error {}

export interface SshBridge {
  write: (data: string | Buffer) => void
  resize: (cols: number, rows: number) => void
  close: () => void
}

export async function openSshBridge(opts: {
  host: string
  port: number
  username: string
  password: string
  cols: number
  rows: number
  onData: (chunk: Buffer) => void
  onClose: () => void
}): Promise<SshBridge> {
  let handle
  try {
    handle = await openShell({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      password: opts.password,
      cols: opts.cols,
      rows: opts.rows,
    })
  }
  catch (err) {
    // ssh2 marks an auth failure with level='client-authentication'; the rest
    // (ECONNREFUSED, ETIMEDOUT, host down) → connection error.
    if ((err as { level?: string })?.level === 'client-authentication')
      throw new SshAuthError((err as Error).message)
    throw new SshConnectError((err as Error)?.message ?? 'SSH connect failed')
  }
  const { stream, conn } = handle
  stream.on('data', (chunk: Buffer) => opts.onData(chunk))
  stream.on('close', () => {
    opts.onClose()
    conn.end()
  })
  return {
    // only tty bytes go to the client; credentials stay here
    write: data => stream.write(data),
    resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
    close: () => {
      stream.close()
      conn.end()
    },
  }
}

export async function authorizeUpgrade<U>(getUser: () => Promise<U | null>): Promise<U> {
  const user = await getUser()
  if (!user)
    throw new UpgradeUnauthorizedError('Unauthorized')
  return user
}

export function resolveSshConnection(device: ConnectableDevice): GuacAction {
  return resolveAction(device, 'ssh')
}
