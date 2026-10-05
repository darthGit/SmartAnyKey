// Client-side board search. A deliberate exception to "server-side search over
// devices/points": the board is already preloaded in RAM
// (index.vue fetchAllDevices) → wider match without a round-trip. Pure function.
import { fuzzyScore } from './fuzzy'

export type MatchReason = 'point' | 'device' | 'note' | 'runbook' | 'contact'

// Minimal structural shapes (util decoupled from the full board types).
interface SearchPoint { id: string, number: number, address: string, note?: string | null }
interface SearchDevice { label: string, host: string }
interface SearchRunbook { title: string, body: string }
// value_norm comes from the DB (generated column, 0017) — not computed here.
interface SearchContact { kind: string, value: string, value_norm: string, label: string | null }

export interface SearchResult<P extends SearchPoint = SearchPoint> {
  point: P
  matchReason: MatchReason
}

export interface SearchContext<P extends SearchPoint = SearchPoint> {
  points: P[]
  devicesByPoint: Map<string, SearchDevice[]>
  runbooksByPoint?: Map<string, SearchRunbook[]>
  contactsByPoint?: Map<string, SearchContact[]>
  // PHONE_MATCH_TAIL from runtimeConfig.public. undefined = exact phone match only
  // (the national-number length is deployment-specific, not hardcoded).
  phoneMatchTail?: number
}

// Mirrors server/services/point-contacts.ts::matchesValue for phones — change
// ONLY together (client search and server lookup must match the same numbers,
// otherwise "search found it, but the webhook did not").
function phoneHit(norm: string, qDigits: string, tail?: number): boolean {
  if (norm === qDigits)
    return true
  if (!tail || norm.length < tail || qDigits.length < tail)
    return false
  return norm.slice(-tail) === qDigits.slice(-tail)
}

// Ranking tiers: exact number → number prefix → number substring
// → address (fuzzy) → device (label/host) → note → runbook. Higher score ranks higher.
export function searchBoard<P extends SearchPoint>(
  query: string,
  ctx: SearchContext<P>,
): SearchResult<P>[] {
  const q = query.trim().toLowerCase()
  // Empty query → all points in the order they arrived (index.vue → by number).
  if (!q)
    return ctx.points.map(point => ({ point, matchReason: 'point' as const }))

  const scored: { point: P, matchReason: MatchReason, score: number }[] = []
  for (const point of ctx.points) {
    const num = String(point.number)
    let score = 0
    let reason: MatchReason = 'point'

    if (num === q)
      score = 4000
    else if (num.startsWith(q))
      score = 3000
    else if (num.includes(q))
      score = 2500
    else {
      const addr = fuzzyScore(point.address, q)
      if (addr > 0)
        score = 1000 + addr // ≤2000 — always below any number match
    }

    if (score === 0) {
      const devs = ctx.devicesByPoint.get(point.id) ?? []
      if (devs.some(d => d.label.toLowerCase().includes(q) || d.host.toLowerCase().includes(q))) {
        score = 800
        reason = 'device'
      }
    }
    // Contacts. A phone match is the strongest signal after the point number:
    // a caller's number is unambiguous, and this path removes the search during
    // an incoming call (the north-star use case).
    // Checked after the point number, so "202" stays a point match.
    if (score === 0) {
      const cs = ctx.contactsByPoint?.get(point.id) ?? []
      const qDigits = q.replace(/\D/g, '')
      // ≥5 digits — so that "10" or "147" do not pull in the contact tier by accident.
      if (qDigits.length >= 5 && cs.some(c => c.kind === 'phone' && phoneHit(c.value_norm, qDigits, ctx.phoneMatchTail))) {
        score = 3500
        reason = 'contact'
      }
      else if (cs.some(c => c.value_norm.includes(q) || (c.label ?? '').toLowerCase().includes(q))) {
        score = 700
        reason = 'contact'
      }
    }
    if (score === 0 && point.note && point.note.toLowerCase().includes(q)) {
      score = 600
      reason = 'note'
    }
    if (score === 0) {
      const rbs = ctx.runbooksByPoint?.get(point.id) ?? []
      if (rbs.some(r => r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q))) {
        score = 400
        reason = 'runbook'
      }
    }

    if (score > 0)
      scored.push({ point, matchReason: reason, score })
  }

  scored.sort((a, b) => b.score - a.score || a.point.number - b.point.number)
  return scored.map(({ point, matchReason }) => ({ point, matchReason }))
}
