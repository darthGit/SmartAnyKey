// Sliding-window rate limiter shared by every BFF limit.
// ponytail: in-memory on one instance — there is one BFF (ADR-015). With horizontal
// scaling → a Postgres-backed counter; for now this is a ceiling, not a hole.
import type { H3Event } from 'h3'
import { createError, setResponseHeader } from 'h3'
const hits = new Map<string, number[]>()

/** Records a hit for `key`. Returns 0 when allowed, else whole seconds until a slot frees. */
export function hitRate(key: string, max: number, windowMs: number, now = Date.now()): number {
  const recent = (hits.get(key) ?? []).filter(t => now - t < windowMs)
  if (recent.length >= max) {
    hits.set(key, recent)
    return Math.ceil((recent[0]! + windowMs - now) / 1000)
  }
  recent.push(now)
  hits.set(key, recent)
  // ponytail: keys of one-off visitors linger; sweep only when the map grows large.
  if (hits.size > 10_000) {
    for (const [k, ts] of hits) {
      if (now - ts[ts.length - 1]! >= windowMs)
        hits.delete(k)
    }
  }
  return 0
}

/** Tests/diagnostics only. */
export function resetRates(): void {
  hits.clear()
}

/** Per-minute limits that are installation settings (docker/.env.example). */
export const LIMITS = {
  sessionOpen: Number(process.env.SAK_SESSION_OPEN_PER_MIN ?? 30),
  authAction: Number(process.env.SAK_AUTH_ACTION_PER_MIN ?? 5),
}

/** HTTP form: 429 + Retry-After when `key` is over `max` per minute. */
export function assertRate(event: H3Event, key: string, max: number): void {
  const wait = hitRate(key, max, 60_000)
  if (wait) {
    setResponseHeader(event, 'Retry-After', String(wait))
    throw createError({ statusCode: 429, statusMessage: `Too many attempts, try again in ${wait} s` })
  }
}
