// Domain service: rule-engine + reconcile. Pure functions (no DB — persistence
// lives in the executor/repo, 3-Tier). The engine is domain-agnostic: it harvests
// neutral signals (Observation), and what they mean is decided by the client's
// rules (device_type_signatures) on the client's own device_types — pilot data
// validates the engine, it does not become a default. Empty ruleset → all unknown.
import { CURATED_PORTS } from '../repositories/scanner'
import type { Observation } from '../repositories/scanner'

export interface Signature {
  id: string
  type_id: string
  signal_type: 'ip_range' | 'port' | 'banner' | 'cert' | 'os'
  pattern: string
  capture_target: 'hostname' | 'point_number' | null
  weight: number                    // strength of THIS signal (independent; the user does not split 100%)
}

export interface MatchResult {
  proposedTypeId: string
  confidence: number                // round(F1×100) — composite precision·recall fit
  conflict: boolean                 // ≥2 types with equal (F1, weight) → flag
  partial: boolean                  // not all of the type's signals matched
  capture: { target: 'hostname' | 'point_number', value: string } | null
  matchedOn?: string | null         // 'M/N · port:22, banner:RouterOS' — transparency
}

// IPv4 ∈ CIDR (v4 only; the scan target is already validated in scanner.assertTarget).
function ipToInt(ip: string): number | null {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some(o => !Number.isInteger(o) || o < 0 || o > 255))
    return null
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
}
function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split('/')
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw)
  const a = ipToInt(ip); const b = ipToInt(net)
  if (a === null || b === null || bits < 0 || bits > 32)
    return false
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (a & mask) === (b & mask)
}

// Whether ONE signature matches the observation. Returns capture (for regex signals).
function testSignature(sig: Signature, obs: Observation): { hit: boolean, capture?: string } {
  switch (sig.signal_type) {
    case 'ip_range':
      return { hit: ipInCidr(obs.ip, sig.pattern) }
    case 'port':
      return { hit: obs.ports.some(p => p.port === Number(sig.pattern)) }
    case 'banner': {
      const re = safeRe(sig.pattern)
      for (const p of obs.ports) {
        const m = p.banner && re?.exec(p.banner)
        if (m) return { hit: true, capture: m[1] }
      }
      return { hit: false }
    }
    case 'cert': {
      const m = obs.tlsCertCn ? safeRe(sig.pattern)?.exec(obs.tlsCertCn) : null
      return { hit: !!m, capture: m?.[1] }
    }
    case 'os': {
      const m = obs.osGuess ? safeRe(sig.pattern)?.exec(obs.osGuess) : null
      return { hit: !!m, capture: m?.[1] }
    }
  }
}

// Rules are user-authored → a regex may be broken; do not fail the scan.
function safeRe(pattern: string): RegExp | null {
  try { return new RegExp(pattern) }
  catch { return null }
}

const CIDR_PATTERN = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?:\/(?:3[0-2]|[12]?\d))?$/

// Validate pattern by signal_type (admin trust boundary): CIDR/IP for ip_range,
// 1-65535 for port, a compilable regex for banner/cert/os.
export function validatePattern(signalType: Signature['signal_type'], pattern: string): boolean {
  switch (signalType) {
    case 'ip_range': return CIDR_PATTERN.test(pattern)
    case 'port': { const n = Number(pattern); return Number.isInteger(n) && n >= 1 && n <= 65535 }
    default: return safeRe(pattern) !== null
  }
}

// Ranking = F1 of two coverages (amendment to ADR-012). Recall R = coverage (how
// much of the type's fingerprint landed on the host). Precision P = how many of the
// host's real ports the type explains (penalty for unexplained ones). Coverage-only
// self-normalised per type → a type with one common port (handheld=5900) beat a
// richer partial one (POS); F1 weighs both → the full and specific fingerprint wins.

// Precision: share of the host's open ports the type explains. A type without port
// rules makes no claim on ports → P=1 (a cert/os/banner type is not zeroed). A port
// is explained by a port rule on that port OR a banner rule matching that port's banner.
export function precision(obs: Observation, sigs: Signature[], recall: number): number {
  const portRules = sigs.filter(s => s.signal_type === 'port')
  if (portRules.length === 0)
    return 1
  if (obs.ports.length === 0)
    return recall
  const bannerRules = sigs.filter(s => s.signal_type === 'banner')
  let explained = 0
  for (const p of obs.ports) {
    const byPort = portRules.some(r => Number(r.pattern) === p.port)
    const byBanner = !byPort && p.banner != null && bannerRules.some(r => safeRe(r.pattern)?.test(p.banner!) ?? false)
    if (byPort || byBanner)
      explained++
  }
  return explained / obs.ports.length
}

export function f1(p: number, r: number): number {
  return p + r > 0 ? (2 * p * r) / (p + r) : 0
}

// Match an observation against the client's rules. null = unknown (no match /
// empty ruleset). Conflict (different types) → flag, the highest F1 wins.
interface Candidate {
  typeId: string
  coverage: number        // recall R (0..1)
  precision: number       // P (0..1)
  f1: number              // score
  matchedWeight: number
  matchedCount: number
  total: number
  descs: string[]
  capture: MatchResult['capture']
}

export function matchType(obs: Observation, signatures: Signature[]): MatchResult | null {
  const byType = new Map<string, Signature[]>()
  for (const sig of signatures) {
    const list = byType.get(sig.type_id) ?? []
    list.push(sig)
    byType.set(sig.type_id, list)
  }

  const candidates: Candidate[] = []
  for (const [typeId, sigs] of byType) {
    let matchedWeight = 0
    let totalWeight = 0
    let matchedCount = 0
    const descs: string[] = []
    let capture: MatchResult['capture'] = null
    for (const sig of sigs) {
      totalWeight += sig.weight
      const r = testSignature(sig, obs)
      if (!r.hit)
        continue
      matchedWeight += sig.weight
      matchedCount++
      descs.push(`${sig.signal_type}:${sig.pattern}`)
      if (!capture && r.capture && sig.capture_target)
        capture = { target: sig.capture_target, value: r.capture }
    }
    if (matchedCount === 0)
      continue
    const coverage = totalWeight > 0 ? matchedWeight / totalWeight : 0
    const p = precision(obs, sigs, coverage)
    candidates.push({
      typeId, matchedWeight, matchedCount, total: sigs.length, descs, capture,
      coverage, precision: p, f1: f1(p, coverage),
    })
  }
  if (candidates.length === 0)
    return null

  // ranking: F1 ↓, tie-break — absolute matched weight ↓
  candidates.sort((a, b) => b.f1 - a.f1 || b.matchedWeight - a.matchedWeight)
  const best = candidates[0]!
  const second = candidates[1]
  const conflict = !!second && second.f1 === best.f1 && second.matchedWeight === best.matchedWeight

  return {
    proposedTypeId: best.typeId,
    confidence: Math.round(best.f1 * 100),
    conflict,
    partial: best.matchedCount < best.total,
    capture: best.capture,
    matchedOn: `${best.matchedCount}/${best.total} · ${best.descs.join(', ')}`,
  }
}

// --- Reconcile (propose-don't-write) ---

export interface KnownDevice {
  id: string
  host: string
  label: string
  type_id: string
  // stable signals from the previous matched scan (for identity when the IP changes)
  sshHostkey?: string | null
  tlsCertSha256?: string | null
  // observed name — now from `devices` itself (survives a scan in which the device
  // did not match), not only from the last observation
  hostname?: string | null
  hostnameSource?: string | null
  hostnameAt?: string | null
}

// --- Hostname as an observed fact ---
// Source rank: the closer to the machine itself, the more trust. PTR says what DNS
// thinks; NSE/SSH — what the machine says about itself. Rank is a domain rule, so it
// lives in code, not a CHECK in the schema (transport = a data dimension).
export type HostnameSource = 'ssh' | 'nse' | 'ptr'

export interface HostnameFact {
  value: string
  source: HostnameSource
  at: string
}

const RANK: Record<string, number> = { ssh: 3, nse: 2, ptr: 1 }
const rank = (s?: string | null) => RANK[s ?? ''] ?? 0

// Names are compared normalised: case and the trailing DNS dot are not a mismatch
// (`DESKTOP-4F8H2K` vs `desktop-4f8h2k`, `kasa-7.` vs `kasa-7`).
// ponytail: short name vs FQDN (`kasa-7` vs `kasa-7.lan`) are treated as different —
// stripping the domain = deciding for the client how things are named; add if noisy.
const norm = (v?: string | null) => (v ?? '').trim().replace(/\.$/, '').toLowerCase()

// Who overwrites whom: higher rank always; equal — the fresher; lower — never.
// ponytail: no expiry — a stale ssh record stays until ssh re-captures it; add a
// time-to-live if it starts lying.
export function pickHostname(current: HostnameFact | null, incoming: HostnameFact | null): HostnameFact | null {
  if (!incoming)
    return current
  if (!current)
    return incoming
  return rank(incoming.source) >= rank(current.source) ? incoming : current
}

// What the scan saw on the host: NSE (machine about itself) beats reverse-DNS.
export function observedHostname(obs: Observation, at: string): HostnameFact | null {
  if (obs.nseHostname)
    return { value: obs.nseHostname, source: 'nse', at }
  if (obs.hostname)
    return { value: obs.hostname, source: 'ptr', at }
  return null
}

const currentFact = (d: KnownDevice): HostnameFact | null =>
  d.hostname ? { value: d.hostname, source: (d.hostnameSource as HostnameSource) ?? 'ptr', at: d.hostnameAt ?? '' } : null

// Whether this observation will change an already known fact (drift). First contact
// (`hostname` was null) is not drift but an inventory fill.
function changesHostname(dev: KnownDevice, obs: Observation): boolean {
  const cur = currentFact(dev)
  if (!cur)
    return false
  const winner = pickHostname(cur, observedHostname(obs, ''))
  return norm(winner?.value) !== norm(cur.value)
}

// What the scan writes to `devices`: exactly the hostname triple per matched device
// (label/type/host are never touched).
export function hostnameUpdates(diff: DiffEntry[], devices: KnownDevice[], now: string): { deviceId: string, fact: HostnameFact }[] {
  const out: { deviceId: string, fact: HostnameFact }[] = []
  for (const e of diff) {
    if (e.status === 'missing' || !e.deviceId)
      continue
    const dev = devices.find(d => d.id === e.deviceId)
    if (!dev)
      continue
    const cur = currentFact(dev)
    const winner = pickHostname(cur, observedHostname(e.obs, now))
    // Write when the value changed or the fact rose in rank (ptr → nse/ssh):
    // otherwise the stronger source would stay unwritten and a weaker one could
    // later overwrite it.
    if (winner && winner !== cur && (norm(winner.value) !== norm(cur?.value) || rank(winner.source) > rank(cur?.source)))
      out.push({ deviceId: e.deviceId, fact: winner })
  }
  return out
}

export interface MatchedObs {
  obs: Observation
  match: MatchResult | null
}

export type DiffEntry =
  // hostnameChanged: same device, but the machine named itself differently → drift.
  // Lives on the diff entry, because reconcile holds both halves of the comparison.
  | { status: 'new' | 'matched' | 'changed' | 'rogue', obs: Observation, match: MatchResult | null, deviceId: string | null, hostnameChanged?: boolean }
  | { status: 'missing', device: KnownDevice }

// An observation resolves to a device by a stable signal (hostkey/cert/hostname) —
// even if the IP changed; an IP match is only a fallback.
function findDevice(obs: Observation, devices: KnownDevice[]): KnownDevice | undefined {
  return devices.find(d =>
    (d.sshHostkey && d.sshHostkey === obs.sshHostkey)
    || (d.tlsCertSha256 && d.tlsCertSha256 === obs.tlsCertSha256)
    || (d.hostname && obs.hostname && d.hostname === obs.hostname))
    ?? devices.find(d => d.host === obs.ip)
}

// Each host → New/Matched/Changed/Rogue; devices without a host → Missing.
export function reconcile(observed: MatchedObs[], devices: KnownDevice[]): DiffEntry[] {
  const out: DiffEntry[] = []
  const seen = new Set<string>()
  for (const { obs, match } of observed) {
    const dev = findDevice(obs, devices)
    if (dev) {
      seen.add(dev.id)
      // Changed: the IP moved or the proposed type differs from the current one
      const changed = dev.host !== obs.ip || (match != null && match.proposedTypeId !== dev.type_id)
      out.push({ status: changed ? 'changed' : 'matched', obs, match, deviceId: dev.id, hostnameChanged: changesHostname(dev, obs) })
    }
    else if (match) {
      out.push({ status: 'new', obs, match, deviceId: null })       // classified, but an unknown device
    }
    else {
      out.push({ status: 'rogue', obs, match: null, deviceId: null }) // no match and no classification
    }
  }
  for (const d of devices)
    if (!seen.has(d.id))
      out.push({ status: 'missing', device: d })
  return out
}

// --- Port-set resolution ---
// The nmap scan scope derives from the mode. Signatures are only matched against the
// scan (testSignature), so a signature's port must be added to -p explicitly, else it
// is never observed. combined = curated ∪ ports of port signatures.

export type ScanMode = 'combined' | 'signatures' | 'custom'

// nmap -p spec: comma-separated ports/ranges, digits only. A format guard — not
// a shell (execFile argv), but no flags/spaces/metacharacters get into argv.
const PORT_SPEC_RE = /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/
export function validatePortSpec(s: string): boolean {
  return PORT_SPEC_RE.test(s)
}

// Ports from active port signatures (numeric, deduped).
function signaturePorts(signatures: Signature[]): number[] {
  const set = new Set<number>()
  for (const s of signatures)
    if (s.signal_type === 'port') {
      const n = Number(s.pattern)
      if (Number.isInteger(n))
        set.add(n)
    }
  return [...set]
}

export function resolvePorts(mode: ScanMode, signatures: Signature[], customPorts?: string): string {
  if (mode === 'custom') {
    if (!customPorts || !validatePortSpec(customPorts))
      throw new Error(`Invalid port spec: ${customPorts ?? ''}`)
    return customPorts
  }
  const sigPorts = signaturePorts(signatures)
  if (mode === 'signatures') {
    if (sigPorts.length === 0)
      throw new Error('No port signatures to scan (add a port signature or pick another mode)')
    return [...new Set(sigPorts)].join(',')
  }
  // combined (default)
  const curated = CURATED_PORTS.split(',').map(Number)
  return [...new Set([...curated, ...sigPorts])].join(',')
}
