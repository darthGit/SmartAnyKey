// Teach-screen mapping: selected signals (checkbox/regex/capture) → device_type_signatures
// rows for the type. Row shape = the server/api/admin/signatures/index.post schema.
// Several samples of one type are generalised (not 1:1): identical ones are deduplicated;
// several regex variants of one signal_type → one OR row (matches any variant of the
// machine). Pure function.
export type SignalType = 'ip_range' | 'port' | 'banner' | 'cert' | 'os'

export interface SignalSelection {
  signal_type: SignalType
  pattern: string
  capture_target?: 'hostname' | 'point_number' | null
  weight?: number
}

export interface SignatureDraftRow {
  type_id: string
  signal_type: SignalType
  pattern: string
  capture_target: 'hostname' | 'point_number' | null
  weight: number
}

// banner/cert/os match by regex (see discovery.testSignature) → variants can be
// merged into one OR. port/ip_range are not regex and stay separate rows.
const REGEX_SIGNALS = new Set<SignalType>(['banner', 'cert', 'os'])

function toRow(typeId: string, signal_type: SignalType, pattern: string, src: SignalSelection): SignatureDraftRow {
  return {
    type_id: typeId,
    signal_type,
    pattern,
    capture_target: src.capture_target ?? null,
    weight: src.weight ?? 50,
  }
}

export function teachSignatureDraft(typeId: string, selections: SignalSelection[]): SignatureDraftRow[] {
  const byType = new Map<SignalType, SignalSelection[]>()
  for (const sel of selections) {
    const list = byType.get(sel.signal_type) ?? []
    list.push(sel)
    byType.set(sel.signal_type, list)
  }

  const rows: SignatureDraftRow[] = []
  for (const [signal_type, sels] of byType) {
    // dedupe identical patterns (the same signal from several samples → not 1:1)
    const distinct = [...new Map(sels.map(s => [s.pattern, s])).values()]
    if (REGEX_SIGNALS.has(signal_type) && distinct.length > 1) {
      const orPattern = `(?:${distinct.map(d => d.pattern).join('|')})`
      rows.push(toRow(typeId, signal_type, orPattern, distinct[0]))
    }
    else {
      for (const sel of distinct)
        rows.push(toRow(typeId, signal_type, sel.pattern, sel))
    }
  }
  return rows
}
