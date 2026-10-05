// L0 health probe (ADR-005): a plain TCP connect via
// node:net. Domain-agnostic — "connect succeeded = service alive",
// zero assumptions about the device type; no ICMP (needs privileges, ADR-005).
import { createConnection } from 'node:net'

export interface ProbeOutcome {
  up: boolean
  latencyMs: number | null
  error: string | null
}

// Resolves exactly once (first event wins): 'connect' → up; 'timeout'/'error' → down.
export function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const start = performance.now()
    let done = false
    const sock = createConnection({ host, port })
    const finish = (out: ProbeOutcome): void => {
      if (done)
        return
      done = true
      sock.destroy()
      resolve(out)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish({ up: true, latencyMs: Math.round(performance.now() - start), error: null }))
    sock.once('timeout', () => finish({ up: false, latencyMs: null, error: 'timeout' }))
    sock.once('error', (e: NodeJS.ErrnoException) => finish({ up: false, latencyMs: null, error: e.code ?? 'error' }))
  })
}
