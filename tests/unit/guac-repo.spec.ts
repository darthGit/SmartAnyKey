// Repo — the only layer that talks to guacd. After replacing guacamole-lite with
// our own net bridge we test against a real loopback fake guacd (not a vendor
// mock): the fake plays the server side of the protocol (select→args→…→ready).
//
// Characterization tests (handshake / black screen / onClose / reject) are a
// green baseline: the openGuacTunnel contract is unchanged, they must stay
// green after the swap (the RED equivalent for a behavior-preserving swap).
// Truly red at the time: the guacamole-lite import check (the import was still
// there) and the handshake logging check (silentLogger).
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Guacamole from 'guacamole-common-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openGuacTunnel } from '../../server/repositories/guac'

// Minimal fake guacd: accepts client instructions, auto-replies
// args → (on connect) ready + the initial framebuffer in the same packet.
function startFakeGuacd(opts: { withFramebuffer?: boolean } = {}) {
  const received: string[][] = [] // instructions our client sent to guacd
  const sockets = new Set<net.Socket>()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    const parser = new Guacamole.Parser()
    parser.oninstruction = (opcode: string, params: string[]) => {
      received.push([opcode, ...params])
      if (opcode === 'select')
        sock.write(toInstruction(['args', 'VERSION_1_1_0', 'hostname', 'port', 'password']))
      if (opcode === 'connect') {
        const ready = toInstruction(['ready', '$conn-1'])
        const fb = opts.withFramebuffer === false ? '' : toInstruction(['sync', '0'])
        sock.write(ready + fb) // ready + frame in one write — the black-screen regression
      }
    }
    sock.on('data', (d: Buffer) => parser.receive(d.toString('utf8')))
    sock.on('error', () => {})
  })
  return new Promise<{ port: number, received: string[][], close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        received,
        close: () => { for (const s of sockets) s.destroy(); server.close() }, // drops the live connection → the client sees FIN
      })
    })
  })
}

// guac instruction: `LEN.VALUE,...;` (LEN = code points). guacamole-common-js 1.5.0
// ESM has no static toInstruction — we encode it ourselves, trivially.
const toInstruction = (parts: (string | number)[]) =>
  `${parts.map((p) => { const s = String(p ?? ''); return `${[...s].length}.${s}` }).join(',')};`

const OPEN = { protocol: 'vnc', hostname: 'target', port: '5900', password: 'secret' }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('openGuacTunnel — handshake (baseline)', () => {
  it('sends select <protocol> and connect with the target values in args order', async () => {
    const g = await startFakeGuacd()
    const tunnel = await openGuacTunnel({ guacdHost: '127.0.0.1', guacdPort: g.port, ...OPEN, onData: vi.fn(), onClose: vi.fn() })
    const select = g.received.find(i => i[0] === 'select')!
    expect(select[1]).toBe('vnc')
    // guacd sent args=[VERSION,hostname,port,password] → connect in the same order
    const connect = g.received.find(i => i[0] === 'connect')!
    expect(connect).toEqual(['connect', 'VERSION_1_1_0', 'target', '5900', 'secret'])
    expect(g.received.some(i => i[0] === 'size')).toBe(true)
    expect(g.received.some(i => i[0] === 'image')).toBe(true)
    tunnel.close()
    g.close()
  })

  it('resolves to {send,close} and send writes to guacd', async () => {
    const g = await startFakeGuacd()
    const tunnel = await openGuacTunnel({ guacdHost: '127.0.0.1', guacdPort: g.port, ...OPEN, onData: vi.fn(), onClose: vi.fn() })
    expect(Object.keys(tunnel).sort()).toEqual(['close', 'send'])
    tunnel.send('4.sync,1.0;')
    await vi.waitFor(() => expect(g.received.some(i => i[0] === 'sync')).toBe(true))
    tunnel.close()
    g.close()
  })

  it('delivers the connection-id and the initial frame (black-screen regression)', async () => {
    const g = await startFakeGuacd()
    const received: string[] = []
    const tunnel = await openGuacTunnel({ guacdHost: '127.0.0.1', guacdPort: g.port, ...OPEN, onData: d => received.push(d), onClose: vi.fn() })
    await vi.waitFor(() => expect(received.join('')).toContain('sync'))
    expect(received.join('')).toContain('$conn-1') // connection-id proxied to the client
    tunnel.close()
    g.close()
  })

  it('onClose fires when guacd drops the connection', async () => {
    const g = await startFakeGuacd()
    const onClose = vi.fn()
    const tunnel = await openGuacTunnel({ guacdHost: '127.0.0.1', guacdPort: g.port, ...OPEN, onData: vi.fn(), onClose })
    g.close() // server closed the socket → the client sees FIN
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    tunnel.close()
  })

  it('early net error (port closed) → reject before open', async () => {
    // port 1 on loopback — a guaranteed ECONNREFUSED
    await expect(openGuacTunnel({ guacdHost: '127.0.0.1', guacdPort: 1, ...OPEN, onData: vi.fn(), onClose: vi.fn() }))
      .rejects.toThrow()
  })
})

describe('openGuacTunnel — own bridge (RED before the swap)', () => {
  it('AC-3 — repo does not import guacamole-lite (a mention in a comment is ok)', () => {
    const src = readFileSync(fileURLToPath(new URL('../../server/repositories/guac.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/(?:import|require)[^\n]*guacamole-lite/)
  })

  it('AC-5 — behind a flag logs the full handshake (select…ready)', async () => {
    vi.stubEnv('GUAC_HANDSHAKE_DEBUG', '1')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const g = await startFakeGuacd()
    const tunnel = await openGuacTunnel({ guacdHost: '127.0.0.1', guacdPort: g.port, ...OPEN, onData: vi.fn(), onClose: vi.fn() })
    const logged = spy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(logged).toMatch(/select/)
    expect(logged).toMatch(/ready/)
    tunnel.close()
    g.close()
  })

  // The debug flag is switched on exactly when a connection misbehaves, and its
  // log lands in `docker logs` — the target password must not go with it.
  it('debug log masks secret connect arguments; guacd still receives them', async () => {
    vi.stubEnv('GUAC_HANDSHAKE_DEBUG', '1')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const g = await startFakeGuacd()
    const tunnel = await openGuacTunnel({ guacdHost: '127.0.0.1', guacdPort: g.port, ...OPEN, onData: vi.fn(), onClose: vi.fn() })
    const logged = spy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(logged).toMatch(/connect/)
    expect(logged).not.toContain(OPEN.password)
    expect(g.received.find(i => i[0] === 'connect')).toContain(OPEN.password)
    tunnel.close()
    g.close()
  })

  // Fix: a concurrent burst of starts crashed the 2nd+ VNC client in guacd. We
  // serialize setup — a new connection starts only after the previous one's frame.
  // Here: 3 simultaneous openGuacTunnel calls must reach guacd sequentially
  // (connect#N before select#(N+1)).
  it('AC-7 — serializes setup: connections reach guacd one at a time', async () => {
    const events: string[] = []
    let idx = 0
    const server = net.createServer((sock) => {
      const n = ++idx
      const parser = new Guacamole.Parser()
      parser.oninstruction = (op: string) => {
        if (op === 'select') {
          events.push(`select#${n}`)
          sock.write(toInstruction(['args', 'VERSION_1_1_0', 'hostname', 'port', 'password']))
        }
        if (op === 'connect') {
          events.push(`connect#${n}`)
          // ready + frame (sync) → our bridge frees the setup queue → the next one starts
          sock.write(toInstruction(['ready', `$c${n}`]) + toInstruction(['sync', '0']))
        }
      }
      sock.on('data', (d: Buffer) => parser.receive(d.toString('utf8')))
      sock.on('error', () => {})
    })
    const port = await new Promise<number>((res) => {
      server.listen(0, '127.0.0.1', () => res((server.address() as net.AddressInfo).port))
    })
    // 3 connections at once (no await between them)
    const opts = (h: string) => ({ guacdHost: '127.0.0.1', guacdPort: port, protocol: 'vnc', hostname: h, port: '5900', password: 'x', onData: vi.fn(), onClose: vi.fn() })
    const tunnels = await Promise.all([openGuacTunnel(opts('a')), openGuacTunnel(opts('b')), openGuacTunnel(opts('c'))])
    // sequential: each connect precedes the next select (not a burst of all selects at once)
    expect(events).toEqual(['select#1', 'connect#1', 'select#2', 'connect#2', 'select#3', 'connect#3'])
    tunnels.forEach(t => t.close())
    server.close()
  })

  // Fallback: the first attempt with resize fails before the frame (guacd dropped
  // after ready) → a retry without display-resize must come up and stream.
  // Transparent to the browser.
  it('AC-7 — retries without display-resize if the first attempt failed before the frame', async () => {
    let idx = 0
    let retryDisabledResize = false
    const server = net.createServer((sock) => {
      const n = ++idx
      const parser = new Guacamole.Parser()
      parser.oninstruction = (op: string, params: string[]) => {
        if (op === 'select')
          sock.write(toInstruction(['args', 'VERSION_1_1_0', 'hostname', 'port', 'password', 'disable-display-resize', 'color-depth']))
        if (op === 'connect') {
          if (n === 1) {
            sock.write(toInstruction(['ready', '$a1'])) // ready, but no frame will follow → drop
            setTimeout(() => sock.destroy(), 20)
          }
          else {
            retryDisabledResize = params[4] === 'true' // 5th connect arg = disable-display-resize
            sock.write(toInstruction(['ready', '$a2']) + toInstruction(['sync', '0'])) // ready + frame
          }
        }
      }
      sock.on('data', (d: Buffer) => parser.receive(d.toString('utf8')))
      sock.on('error', () => {})
    })
    const port = await new Promise<number>((res) => {
      server.listen(0, '127.0.0.1', () => res((server.address() as net.AddressInfo).port))
    })
    const received: string[] = []
    const tunnel = await openGuacTunnel({ guacdHost: '127.0.0.1', guacdPort: port, ...OPEN, onData: d => received.push(d), onClose: vi.fn() })
    expect(retryDisabledResize).toBe(true) // the retry went with disable-display-resize
    expect(idx).toBe(2) // exactly one retry
    expect(received.join('')).toContain('sync') // the retry's frame reached the browser
    tunnel.close()
    server.close()
  })
})
