// Auto-diff: comparing observations of labelled samples of ≥2 types → signals that
// distinguish the types (present-in-A / absent-in-B).
// A teach-screen UX assist without ML — the client confirms a hint with a checkbox. Pure function.
import type { Observation } from '../../server/repositories/scanner'

export interface LabeledSample {
  typeId: string
  obs: Observation
}

export interface DiscriminatingSignal {
  typeId: string
  signal_type: 'port' | 'banner' | 'cert' | 'os'
  pattern: string
}

// Neutral signals of one observation (the same axes as the signature engine).
function extract(obs: Observation): { signal_type: DiscriminatingSignal['signal_type'], pattern: string }[] {
  const out: { signal_type: DiscriminatingSignal['signal_type'], pattern: string }[] = []
  for (const p of obs.ports) {
    out.push({ signal_type: 'port', pattern: String(p.port) })
    // the server has product; the client DiscoveredHost.open_ports has only banner → fallback
    const b = p.product ?? p.banner
    if (b) out.push({ signal_type: 'banner', pattern: b })
  }
  if (obs.tlsCertCn) out.push({ signal_type: 'cert', pattern: obs.tlsCertCn })
  if (obs.osGuess) out.push({ signal_type: 'os', pattern: obs.osGuess })
  return out
}

export function signalDiff(samples: LabeledSample[]): DiscriminatingSignal[] {
  const byType = new Map<string, Set<string>>() // typeId → set of "signal_type\0pattern"
  for (const { typeId, obs } of samples) {
    const set = byType.get(typeId) ?? new Set<string>()
    for (const s of extract(obs))
      set.add(`${s.signal_type}\0${s.pattern}`)
    byType.set(typeId, set)
  }
  if (byType.size < 2)
    return [] // nothing to compare against

  const out: DiscriminatingSignal[] = []
  for (const [typeId, keys] of byType) {
    for (const key of keys) {
      const sharedWithOther = [...byType].some(([t, ks]) => t !== typeId && ks.has(key))
      if (sharedWithOther)
        continue
      const [signal_type, pattern] = key.split('\0')
      out.push({ typeId, signal_type: signal_type as DiscriminatingSignal['signal_type'], pattern })
    }
  }
  return out
}
