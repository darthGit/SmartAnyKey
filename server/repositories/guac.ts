// Repository (3-tier): the ONLY layer that talks to guacd — our own net bridge
// (ADR-010). guacamole-lite was removed (provenance, no new dependency): it only
// gave a TCP wrapper, and its protocol parser = a vendored copy of Apache
// `Guacamole.Parser`, which we already have in guacamole-common-js (Apache-2.0,
// browser runtime). So inbound stream parsing is reused (surrogate pairs/
// lengths solved upstream), and outbound encoding (`LEN.VALUE,...;`) is trivial.
// Credentials are resolved on the BFF and go to guacd; the browser gets only guac instructions.
// The handshake is fully here and visible (GUAC_HANDSHAKE_DEBUG) — unlike one
// hidden inside the lib; hence control over connect parameters.
import net from 'node:net'
import Guacamole from 'guacamole-common-js'

// guacd reads these keys in the handshake (the client sends the real canvas size
// in a separate 'size' instruction on resize). Minimum — without disable-display-resize,
// so resizable targets (dev-VNC RandR, RDP) fill the panel. The fallback set
// below disables resize only on retry (if the first attempt failed before a frame).
const DISPLAY_DEFAULTS: Record<string, unknown> = {
  width: 1024,
  height: 768,
  dpi: 96,
  audio: ['audio/L16'],
  video: null,
  image: ['image/png', 'image/jpeg'],
  timezone: null,
}

// Fallback connect parameters for the retry: if the first attempt (with resize)
// failed before the first frame, retry without resize + a fixed color depth —
// this removes display-resize/color-negotiation on init, which (as observed
// in guacd-debug) provokes a VNC client crash under load.
const RETRY_NORESIZE_PARAMS: Record<string, unknown> = {
  'disable-display-resize': true,
  'color-depth': 32,
}

// guacd silent longer than this after the last activity → we drop it (guards
// against hangs). Carried over as is from the previous (guacamole-lite) implementation.
const GUACD_INACTIVITY_MS = 10_000

// Setup-phase serialization (root cause):
// guacd kills the 2nd+ concurrent VNC client start — the child process dies right
// after join, before the VNC target is initialized (in guacd-debug: join →
// «No such process», without «Local system reports»). The first connect survives,
// the rest under a burst do not (race, "first one wins"). Stock Guacamole does not
// hit this, because its session setup naturally spreads connects out in time.
// Our lazy bridge hits guacd with near-simultaneous starts → we serialize: a new
// connect starts only when the previous one has emitted its first frame (VNC is up)
// or the grace ceiling expired. The lock is short (setup window only) — once a
// connect streams, it frees the queue and does not hold the rest.
// ponytail: grace ceiling so a hung target does not block other panels forever;
// if parallelism is ever needed — raise to a cap of N concurrent setups.
const SETUP_GRACE_MS = 2500
let setupTail: Promise<void> = Promise.resolve()

// guac instruction: `LEN.VALUE,...;`, LEN = number of Unicode code points (spread
// iteration counts a surrogate pair as 1). null/undefined → empty element.
function toInstruction(parts: Array<string | number | null | undefined>): string {
  return `${parts.map((p) => { const s = p == null ? '' : String(p); return `${[...s].length}.${s}` }).join(',')};`
}


// guacd connect arguments that must never reach a log (GUAC_HANDSHAKE_DEBUG).
const SECRET_ARG = /password|passphrase|private-key/i
export interface GuacTunnel {
  send: (data: string) => void
  close: () => void
}

export interface GuacTunnelOptions {
  guacdHost: string
  guacdPort: number
  protocol: string // `select <protocol>`
  onData: (chunk: string) => void // guac instructions guacd→browser
  onClose: () => void
  // target parameters (hostname/port/password/username/...) from connectionParameters
  [param: string]: unknown
}

// Opens a TCP bridge to guacd. Scheme:
//  1) the setup gate serializes starts (queue) — we do not hit guacd with a burst.
//  2) resolve on the first frame (not on 'ready'): browser-bound instructions
//     are buffered until it, so the retry is transparent to the browser (one clean session).
//  3) retry with resize→no resize: if the first attempt failed before the first frame
//     (guacd dropped the connect after ready, as under concurrency with real
//     cash registers) — retry without display-resize. Success → stream; a second failure
//     → reject (the controller will show 'host').
export function openGuacTunnel(opts: GuacTunnelOptions): Promise<GuacTunnel> {
  const { guacdHost, guacdPort, protocol, onData, onClose, ...settings } = opts
  const baseCfg = { ...DISPLAY_DEFAULTS, ...settings }
  const debug = !!process.env.GUAC_HANDSHAKE_DEBUG
  // the host tag unambiguously attributes each instruction to a specific connect/socket
  const tag = String(baseCfg.hostname ?? '?')
  const log = (dir: '>>>' | '<<<' | '##', s: string) => { if (debug) console.error(`[guacd ${tag} ${dir}]`, s) }

  // setup gate: this connect waits until the previous one frees the queue (first
  // frame / grace), and holds it itself until established — serializes starts.
  const prevTail = setupTail
  let releaseGate!: () => void
  setupTail = new Promise<void>((res) => { releaseGate = res })

  return prevTail.then(() => new Promise<GuacTunnel>((resolve, reject) => {
    let gateReleased = false
    let settled = false
    let retried = false
    const openGate = () => {
      if (gateReleased)
        return
      gateReleased = true
      clearTimeout(graceTimer)
      releaseGate()
    }
    // after openGate: the closure reads graceTimer only when called (timer/attempt)
    const graceTimer = setTimeout(openGate, SETUP_GRACE_MS)

    // One connect attempt with the given set of extra connect parameters.
    const attempt = (extra: Record<string, unknown>) => {
      const cfg = { ...baseCfg, ...extra }
      const sock = net.connect(guacdPort, guacdHost)
      const parser = new Guacamole.Parser()
      const buffer: string[] = [] // browser-bound, held until the first frame
      let established = false
      let done = false
      let lastActivity = Date.now()
      let protocolVersion = '1_0_0'

      // `shown` is what the debug log prints — the connect line carries secrets.
      const send = (data: string, shown = data) => { log('>>>', shown); sock.write(data) }
      const destroy = () => {
        clearInterval(inactivity)
        if (!sock.destroyed)
          sock.destroy()
      }

      // attempt terminal (close/error/inactivity). Before the first frame: retry without
      // resize (once) or reject. After — a normal bridge close (onClose).
      const terminate = (err?: Error) => {
        if (done)
          return
        done = true
        destroy()
        if (established) {
          openGate()
          onClose()
          return
        }
        if (!retried) {
          retried = true
          log('##', 'setup failed before the first frame → retry without display-resize')
          attempt(RETRY_NORESIZE_PARAMS)
          return
        }
        openGate()
        if (!settled) {
          settled = true
          reject(err ?? new Error('guacd closed before first frame'))
        }
      }

      const inactivity = setInterval(() => {
        if (Date.now() > lastActivity + GUACD_INACTIVITY_MS)
          terminate(new Error('guacd inactive too long'))
      }, 1000)

      // Reply to the server's args: connect arguments in guacd's order; VERSION_*
      // is echoed with the negotiated version, the rest come from cfg.
      const sendHandshakeReply = (serverArgs: string[]) => {
        const connectArgs = serverArgs.map((argName) => {
          if (argName.startsWith('VERSION_')) {
            const v = argName.slice(8)
            protocolVersion = (v === '1_0_0' || v === '1_1_0') ? v : '1_1_0'
            return `VERSION_${protocolVersion}`
          }
          return (cfg[argName] as string | undefined) ?? null
        })
        send(toInstruction(['size', cfg.width as number, cfg.height as number, cfg.dpi as number]))
        send(toInstruction(['audio', ...((cfg.audio as string[]) ?? [])]))
        send(toInstruction(['video', ...((cfg.video as string[]) ?? [])]))
        send(toInstruction(['image', ...((cfg.image as string[]) ?? [])]))
        if (protocolVersion === '1_1_0')
          send(toInstruction(['timezone', ...(cfg.timezone ? [cfg.timezone as string] : [])]))
        const masked = connectArgs.map((v, i) => (v && SECRET_ARG.test(serverArgs[i] ?? '')) ? '***' : v)
        send(toInstruction(['connect', ...connectArgs]), toInstruction(['connect', ...masked]))
      }

      parser.oninstruction = (opcode: string, params: string[]) => {
        lastActivity = Date.now()
        log('<<<', toInstruction([opcode, ...params]))
        if (opcode === 'args') {
          sendHandshakeReply(params)
          return
        }
        // connection-id as an empty opcode; 'ready' does NOT yet mean a frame — buffer it
        const instr = opcode === 'ready' ? toInstruction(['', params[0]]) : toInstruction([opcode, ...params])
        if (established) {
          onData(instr)
          return
        }
        if (opcode === 'ready') {
          buffer.push(instr) // held until the first frame
          return
        }
        // the first non-handshake instruction = guacd started the framebuffer (VNC is up):
        // connect established → resolve, flush the buffer, free the queue.
        established = true
        settled = true
        resolve({ send, close: destroy })
        buffer.push(instr)
        for (const b of buffer)
          onData(b)
        buffer.length = 0
        openGate()
      }

      sock.once('connect', () => send(toInstruction(['select', protocol])))
      sock.on('data', (d: Buffer) => parser.receive(d.toString('utf8')))
      sock.on('error', err => terminate(err))
      sock.on('close', () => terminate())
    }

    attempt({}) // first attempt — with resize (defaults)
  }))
}
