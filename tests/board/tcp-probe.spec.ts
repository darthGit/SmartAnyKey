// RED: tcpProbe — a plain TCP connect
// via node:net, zero domain assumptions (domain-agnostic),
// no ICMP (ADR-005). Reachable port → up+latency; refused/timeout → down.
// The test is real: we start a localhost server on an ephemeral port for up,
// a closed port / non-routable for down — no mocks (this is pure network logic).
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { tcpProbe } from '../../server/utils/tcp-probe'

let server: Server | null = null

afterEach(() => {
  server?.close()
  server = null
})

function listen(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })
}

describe('tcpProbe', () => {
  it('up_on_open_port: connecting to an open port → up + latencyMs', async () => {
    const port = await listen()
    const r = await tcpProbe('127.0.0.1', port, 1000)
    expect(r.up).toBe(true)
    expect(r.latencyMs).not.toBeNull()
    expect(r.latencyMs!).toBeGreaterThanOrEqual(0)
    expect(r.error).toBeNull()
  })

  it('down_on_closed_or_timeout: a closed port → down (refused), no latency', async () => {
    // Start and immediately close a server so the port is guaranteed to be free.
    const port = await listen()
    await new Promise<void>(res => server!.close(() => res()))
    server = null
    const r = await tcpProbe('127.0.0.1', port, 1000)
    expect(r.up).toBe(false)
    expect(r.latencyMs).toBeNull()
    expect(r.error).toBeTruthy()
  })

  it('down_on_closed_or_timeout: a non-routable target with a short timeout → down', async () => {
    // 192.0.2.0/24 = TEST-NET-1 (RFC 5737), guaranteed not to be routed.
    const r = await tcpProbe('192.0.2.1', 80, 150)
    expect(r.up).toBe(false)
    expect(r.error).toBeTruthy()
  })
})
