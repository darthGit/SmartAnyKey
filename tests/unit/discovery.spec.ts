// RED. matchType ranking coverage-first → F1(precision·recall). The engine is
// still coverage-first → fails.
import { describe, expect, it } from 'vitest'
import { matchType } from '../../server/services/discovery'
import type { Signature } from '../../server/services/discovery'
import type { Observation, PortObs } from '../../server/repositories/scanner'

let seq = 0
const sig = (
  type_id: string,
  signal_type: Signature['signal_type'],
  pattern: string,
  weight: number,
): Signature => ({ id: `s${seq++}`, type_id, signal_type, pattern, capture_target: null, weight })

const ports = (...nums: number[]): PortObs[] => nums.map(port => ({ port, proto: 'tcp' }))
const obs = (o: Partial<Observation> & { ports: PortObs[] }): Observation => ({ ip: '192.0.2.20', ...o })

// TZD (handheld terminal) = one common port; Kasa = a richer fingerprint (worked examples).
const tzd = (): Signature[] => [sig('tzd', 'port', '5900', 50)]
const kasa = (): Signature[] => [
  sig('kasa', 'cert', 'acme-pos', 50),
  sig('kasa', 'port', '8080', 50),
  sig('kasa', 'port', '5900', 50),
  sig('kasa', 'port', '21', 50),
  sig('kasa', 'port', '5432', 30),
  sig('kasa', 'port', '22', 20),
]

describe('matchType — F1 ranking', () => {
  it('classifies_richer_type_over_single_common_port', () => {
    // host {21,22,80,5900}: TZD R=1.0 P=0.25 F1=0.40; Kasa R=0.48 P=0.75 F1=0.60 → Kasa
    const r = matchType(obs({ ports: ports(21, 22, 80, 5900) }), [...tzd(), ...kasa()])
    expect(r?.proposedTypeId).toBe('kasa')
  })

  it('classifies_bare_port_as_narrow_type', () => {
    // host {5900}: TZD F1=1.0 > Kasa F1=0.33 → TZD
    const r = matchType(obs({ ports: ports(5900) }), [...tzd(), ...kasa()])
    expect(r?.proposedTypeId).toBe('tzd')
  })

  it('full_single_match_stays_confidence_100', () => {
    // all host ports explained, all rules matched → F1=1.0 → confidence 100
    const sigs = [sig('web', 'port', '80', 50), sig('web', 'port', '443', 50)]
    const r = matchType(obs({ ports: ports(80, 443) }), sigs)
    expect(r?.proposedTypeId).toBe('web')
    expect(r?.confidence).toBe(100)
  })

  it('cert_only_type_not_zeroed_by_precision', () => {
    // a cert-only type (no port rules) + unexplained ports → P=1, not zeroed,
    // beats a port type that matches partially
    const certType = [sig('kasa', 'cert', 'acme-pos', 50)]
    const portType = [sig('nas', 'port', '21', 50), sig('nas', 'port', '445', 50)]
    const r = matchType(
      obs({ ports: ports(21, 22, 80), tlsCertCn: 'acme-pos-01' }),
      [...certType, ...portType],
    )
    expect(r?.proposedTypeId).toBe('kasa')
  })

  it('confidence_is_round_f1_and_null_on_no_match', () => {
    // confidence = round(F1*100): host {21,22,80,5900} vs TZD alone → F1=0.40 → 40
    const only = matchType(obs({ ports: ports(21, 22, 80, 5900) }), tzd())
    expect(only?.confidence).toBe(40)
    // empty ruleset / zero matches → null (rogue)
    expect(matchType(obs({ ports: ports(21, 22, 80, 5900) }), [])).toBeNull()
    expect(matchType(obs({ ports: ports(1234) }), tzd())).toBeNull()
  })
})
