// Terminal BFF logic — SSH bridge (repo mocked, no real ssh2/network), ws-upgrade
// authorization, SSH action resolution. Written RED: the modules
// (server/services/ssh-bridge.ts, server/repositories/ssh.ts) did not exist yet
// → the suite fails. Style: a unit over the service, like tests/unit/remote-session.spec.ts.
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SshAuthError,
  SshConnectError,
  UpgradeUnauthorizedError,
  authorizeUpgrade,
  openSshBridge,
  resolveSshConnection,
} from '../../server/services/ssh-bridge'

// The repository is the only layer with ssh2 (3-tier). Mocked so the bridge
// does not pull a real connection. vi.hoisted — mock/const are hoisted above the
// imports, so the substitution applies before ssh-bridge loads.
const { openShell } = vi.hoisted(() => ({ openShell: vi.fn() }))
vi.mock('../../server/repositories/ssh', () => ({ openShell }))

function fakeHandle() {
  const stream = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>
    setWindow: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
  stream.write = vi.fn()
  stream.setWindow = vi.fn()
  stream.close = vi.fn()
  const conn = { end: vi.fn() }
  return { stream, conn }
}

const CONN = { host: 'testbox', port: 2222, username: 'smartanykey', password: 'testbox-secret-pass', cols: 80, rows: 24 }

beforeEach(() => { openShell.mockReset() })

describe('openSshBridge', () => {
  it('only_tty_bytes_to_client', async () => {
    const handle = fakeHandle()
    openShell.mockResolvedValue(handle)
    const onData = vi.fn()
    const bridge = await openSshBridge({ ...CONN, onData, onClose: vi.fn() })
    handle.stream.emit('data', Buffer.from('$ ls\n'))
    // only tty bytes go to the client
    expect(onData).toHaveBeenCalledTimes(1)
    expect(Buffer.from(onData.mock.calls[0][0]).toString()).toBe('$ ls\n')
    // the client-facing bridge surface does not expose credentials
    expect(Object.keys(bridge).sort()).toEqual(['close', 'resize', 'write'])
  })

  it('close_ends_ssh_connection', async () => {
    const handle = fakeHandle()
    openShell.mockResolvedValue(handle)
    const bridge = await openSshBridge({ ...CONN, onData: vi.fn(), onClose: vi.fn() })
    bridge.close()
    expect(handle.conn.end).toHaveBeenCalled()
  })

  it('auth_error_surfaced_as_typed_error', async () => {
    openShell.mockRejectedValue(Object.assign(
      new Error('All configured authentication methods failed'),
      { level: 'client-authentication' },
    ))
    await expect(openSshBridge({ ...CONN, onData: vi.fn(), onClose: vi.fn() }))
      .rejects.toBeInstanceOf(SshAuthError)
  })

  it('connect_error_surfaced_as_typed_error', async () => {
    openShell.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    await expect(openSshBridge({ ...CONN, onData: vi.fn(), onClose: vi.fn() }))
      .rejects.toBeInstanceOf(SshConnectError)
  })
})

describe('authorizeUpgrade', () => {
  it('upgrade_refused_without_user', async () => {
    await expect(authorizeUpgrade(async () => null)).rejects.toBeInstanceOf(UpgradeUnauthorizedError)
  })

  it('upgrade_allowed_with_user', async () => {
    await expect(authorizeUpgrade(async () => ({ id: 'u1' }))).resolves.toEqual({ id: 'u1' })
  })
})

describe('resolveSshConnection', () => {
  const base = { actions: ['ssh'], default_action: null, type_default_action: 'ssh' }

  it('device_with_ssh_action_ok', () => {
    expect(resolveSshConnection(base)).toBe('ssh')
  })

  it('device_without_ssh_action_rejected', () => {
    expect(() => resolveSshConnection({ ...base, actions: ['vnc', 'rdp'] })).toThrow()
  })
})
