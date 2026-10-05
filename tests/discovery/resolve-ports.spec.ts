// RED: resolvePorts — a pure function that builds the port string for
// nmap -p by mode. combined = curated ∪ port signatures;
// signatures = signatures only; custom = validated passthrough.
import { describe, expect, it } from 'vitest'
import { resolvePorts, validatePortSpec, type Signature } from '../../server/services/discovery'
import { buildServiceArgs, CURATED_PORTS } from '../../server/repositories/scanner'

const sig = (s: Partial<Signature>): Signature =>
  ({ id: 's', type_id: 't', signal_type: 'port', pattern: '5432', capture_target: null, weight: 50, ...s })

// a "-p" string → a set of numeric ports (order does not matter)
const ports = (spec: string) => new Set(spec.split(',').map(Number))
const curated = ports(CURATED_PORTS)

describe('resolvePorts', () => {
  it('AC-1 combined: union of curated + signature ports, no duplicates', () => {
    const sigs = [sig({ pattern: '5432' }), sig({ id: 'b', pattern: '6379' }), sig({ id: 'c', signal_type: 'banner', pattern: 'ssh' })]
    const out = resolvePorts('combined', sigs, undefined)
    const set = ports(out)
    for (const c of curated) expect(set.has(c), `curated ${c}`).toBe(true)
    expect(set.has(5432)).toBe(true)
    expect(set.has(6379)).toBe(true)
    // no duplicates: string length = set size
    expect(out.split(',').length).toBe(set.size)
  })

  it('AC-1 combined: a signature port already in curated is not duplicated', () => {
    const out = resolvePorts('combined', [sig({ pattern: '22' })], undefined) // 22 ∈ curated
    expect(out.split(',').filter(p => p === '22').length).toBe(1)
  })

  it('AC-2 signatures: only signature ports, no curated port missing among them', () => {
    const set = ports(resolvePorts('signatures', [sig({ pattern: '5432' }), sig({ id: 'b', pattern: '6379' })], undefined))
    expect(set).toEqual(new Set([5432, 6379]))
    expect(set.has(443)).toBe(false) // 443 ∈ curated, but not in the signatures
  })

  it('AC-2 signatures: only signal_type=port is taken (banner/cert/ip_range are ignored)', () => {
    const set = ports(resolvePorts('signatures', [
      sig({ pattern: '5432' }),
      sig({ id: 'b', signal_type: 'banner', pattern: 'OpenSSH' }),
      sig({ id: 'c', signal_type: 'cert', pattern: 'cn' }),
    ], undefined))
    expect(set).toEqual(new Set([5432]))
  })

  it('AC-3 custom: a valid string is returned as is', () => {
    expect(resolvePorts('custom', [], '5432,6379')).toBe('5432,6379')
    expect(resolvePorts('custom', [], '1-65535')).toBe('1-65535')
  })

  it('AC-3 custom: an invalid string → throw (with a meaningful message)', () => {
    for (const bad of ['--script vuln', '5432; rm -rf /', '80 443', 'abc', '', '$(whoami)'])
      expect(() => resolvePorts('custom', [], bad), bad).toThrow(/invalid/i)
  })

  it('AC-4 signatures without any port signature → throw (an empty scan is impossible)', () => {
    expect(() => resolvePorts('signatures', [], undefined)).toThrow(/signature/i)
    expect(() => resolvePorts('signatures', [sig({ signal_type: 'banner', pattern: 'x' })], undefined)).toThrow(/signature/i)
  })

  it('AC-6 resolved custom ports reach nmap argv (-p) via buildServiceArgs', () => {
    const args = buildServiceArgs(['10.0.6.1'], { ports: resolvePorts('custom', [], '5432') })
    const pIdx = args.indexOf('-p')
    expect(pIdx).toBeGreaterThanOrEqual(0)
    expect(args[pIdx + 1]).toBe('5432')
  })
})

describe('validatePortSpec', () => {
  it('accepts digits/commas/hyphens', () => {
    expect(validatePortSpec('5432')).toBe(true)
    expect(validatePortSpec('80,443,8080')).toBe(true)
    expect(validatePortSpec('1-65535')).toBe(true)
  })
  it('rejects spaces, letters, shell metacharacters, empty', () => {
    for (const bad of ['80 443', 'abc', '--script', '5432;x', '', '$(x)', '80,'])
      expect(validatePortSpec(bad), bad).toBe(false)
  })
})
