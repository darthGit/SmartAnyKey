// guac-bridge — domain service of the browser↔guacd bridge. The repository (the
// only layer with guacamole-lite, 3-tier) is mocked. The onData/onClose stream
// subscription is now done by the repo (before 'ready', so the initial framebuffer
// is not lost) — here we check that the bridge passes them through to the repo,
// returns only {send,close} without credentials, and classifies errors.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GuacAuthError, GuacConnectError, openGuacBridge } from '../../server/services/guac-bridge'

const { openGuacTunnel } = vi.hoisted(() => ({ openGuacTunnel: vi.fn() }))
vi.mock('../../server/repositories/guac', () => ({ openGuacTunnel }))

const CONN = {
  protocol: 'vnc' as const,
  params: { hostname: '192.0.2.1', port: '5900', password: 'super-secret-vnc' },
  width: 1024,
  height: 768,
}

beforeEach(() => { openGuacTunnel.mockReset() })

describe('openGuacBridge', () => {
  it('surface is only send/close, no credentials; password and callbacks go to the repo (AC-4)', async () => {
    openGuacTunnel.mockResolvedValue({ send: vi.fn(), close: vi.fn() })
    const onData = vi.fn()
    const onClose = vi.fn()
    const bridge = await openGuacBridge({ ...CONN, onData, onClose })

    expect(Object.keys(bridge).sort()).toEqual(['close', 'send'])
    expect(JSON.stringify(bridge)).not.toContain('super-secret-vnc')
    // password + onData/onClose are passed to the repo (where the stream is subscribed before 'ready')
    expect(openGuacTunnel).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'vnc',
      password: 'super-secret-vnc',
      onData,
      onClose,
    }))
  })

  it('closing the bridge closes the guacd tunnel — no orphan (AC-5)', async () => {
    const close = vi.fn()
    openGuacTunnel.mockResolvedValue({ send: vi.fn(), close })
    const bridge = await openGuacBridge({ ...CONN, onData: vi.fn(), onClose: vi.fn() })
    bridge.close()
    expect(close).toHaveBeenCalled()
  })

  it('auth_failure_typed', async () => {
    openGuacTunnel.mockRejectedValue(Object.assign(new Error('guacd unauthorized'), { guacUnauthorized: true }))
    await expect(openGuacBridge({ ...CONN, onData: vi.fn(), onClose: vi.fn() }))
      .rejects.toBeInstanceOf(GuacAuthError)
  })

  it('connect_failure_typed', async () => {
    openGuacTunnel.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    await expect(openGuacBridge({ ...CONN, onData: vi.fn(), onClose: vi.fn() }))
      .rejects.toBeInstanceOf(GuacConnectError)
  })
})
