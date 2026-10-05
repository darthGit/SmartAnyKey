// RED: rule-engine matcher. A type = a combination of signals (each with its own
// weight); confidence% = sum of matched weights / sum of all the type's weights. The
// engine is domain-agnostic — types/rules here are purely synthetic ids; zero defaults.
import { describe, expect, it } from 'vitest'
import { matchType, type Signature } from '../../server/services/discovery'
import type { Observation } from '../../server/repositories/scanner'

const obs = (o: Partial<Observation>): Observation => ({ ip: '10.0.6.6', ports: [], ...o })
const sig = (s: Partial<Signature>): Signature =>
  ({ id: 's', type_id: 't', signal_type: 'port', pattern: '22', capture_target: null, weight: 60, ...s })

describe('matchType (AC-8: empty ruleset → unknown)', () => {
  it('zero rules → null (unknown), even with rich signals', () => {
    expect(matchType(obs({ ports: [{ port: 22, proto: 'tcp', service: 'ssh' }], tlsCertCn: 'x' }), [])).toBeNull()
  })
})

describe('matchType (AC-2: type = a combination of signals, coverage %)', () => {
  it('the type\'s only signal matched → coverage 100%', () => {
    const m = matchType(obs({ ip: '10.0.6.9' }), [sig({ signal_type: 'ip_range', pattern: '10.0.6.0/24', type_id: 'pc', weight: 70 })])
    expect(m).toMatchObject({ proposedTypeId: 'pc', confidence: 100, conflict: false, partial: false })
  })

  it('partial match (1 of 2 type signals) → confidence < 100, partial=true', () => {
    const m = matchType(obs({ ports: [{ port: 22, proto: 'tcp' }] }), [
      sig({ id: 'a', type_id: 't', signal_type: 'port', pattern: '22', weight: 40 }),
      sig({ id: 'b', type_id: 't', signal_type: 'port', pattern: '8291', weight: 60 }),
    ])
    expect(m).toMatchObject({ proposedTypeId: 't', partial: true })
    // confidence = round(F1·100) (not recall): R=40/100=0.4,
    // P=1/1=1.0 (the only port 22 is explained) → F1=2·0.4·1/1.4=0.571 → 57.
    expect(m?.confidence).toBe(57)
  })

  it('cert regex with capture → type + capture(point_number)', () => {
    const m = matchType(obs({ tlsCertCn: 'kasa-042' }), [
      sig({ signal_type: 'cert', pattern: 'kasa-(\\d+)', type_id: 'kasa', capture_target: 'point_number', weight: 90 }),
    ])
    expect(m).toMatchObject({ proposedTypeId: 'kasa', capture: { target: 'point_number', value: '042' } })
  })

  it('a more specific type (more signals together) beats a single rule (fix "everything→music")', () => {
    const rules: Signature[] = [
      sig({ id: 'm', type_id: 'music', signal_type: 'port', pattern: '22', weight: 60 }),
      sig({ id: 'r1', type_id: 'router', signal_type: 'port', pattern: '22', weight: 60 }),
      sig({ id: 'r2', type_id: 'router', signal_type: 'banner', pattern: 'RouterOS', weight: 90 }),
    ]
    // a plain ssh host: music 100%, router 60/150=40% → music
    expect(matchType(obs({ ports: [{ port: 22, proto: 'tcp', banner: 'OpenSSH' }] }), rules)?.proposedTypeId).toBe('music')
    // MikroTik (ssh + RouterOS): both 100%, router weight 150 > 60 → router
    expect(matchType(obs({ ports: [{ port: 22, proto: 'tcp', banner: 'MikroTik RouterOS' }] }), rules)?.proposedTypeId).toBe('router')
  })

  it('no match → null (unknown)', () => {
    expect(matchType(obs({ ports: [{ port: 8080, proto: 'tcp' }] }), [sig({ signal_type: 'port', pattern: '22' })])).toBeNull()
  })

  it('coverage+weight tie (2 types, 1 signal each, equal weight) → conflict', () => {
    const m = matchType(obs({ ports: [{ port: 22, proto: 'tcp' }], ip: '10.0.6.6' }), [
      sig({ id: 'a', signal_type: 'port', pattern: '22', type_id: 'a', weight: 50 }),
      sig({ id: 'b', signal_type: 'ip_range', pattern: '10.0.6.0/24', type_id: 'b', weight: 50 }),
    ])
    expect(m?.conflict).toBe(true)
  })

  it('matchedOn shows M/N + the matched signals (transparency)', () => {
    const m = matchType(obs({ ports: [{ port: 22, proto: 'tcp' }] }), [
      sig({ id: 'a', type_id: 't', signal_type: 'port', pattern: '22', weight: 60 }),
      sig({ id: 'b', type_id: 't', signal_type: 'port', pattern: '8291', weight: 40 }),
    ])
    expect(m?.matchedOn).toBe('1/2 · port:22')
  })

  it('a broken user regex does not crash the matcher (safeRe → skip)', () => {
    expect(() => matchType(obs({ tlsCertCn: 'x' }), [sig({ signal_type: 'cert', pattern: '(' })])).not.toThrow()
  })
})
