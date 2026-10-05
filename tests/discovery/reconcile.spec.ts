// RED: reconcile diff. A pure function — propose-don't-write: returns
// proposals, does NOT write to devices (the only writer is the confirm route).
import { describe, expect, it } from 'vitest'
import { reconcile, type KnownDevice, type MatchResult, type MatchedObs } from '../../server/services/discovery'
import type { Observation } from '../../server/repositories/scanner'

const CERT = '0249a13c96ae0324d253edbac56072afc46208cf2c5e06e290d8b1ff06e26c03' // real sha256 of the fixture
const obs = (o: Partial<Observation>): Observation => ({ ip: '10.0.6.6', ports: [], ...o })
const match = (typeId: string): MatchResult => ({ proposedTypeId: typeId, confidence: 70, conflict: false, partial: false, capture: null })
const mo = (o: Partial<Observation>, m: MatchResult | null): MatchedObs => ({ obs: obs(o), match: m })
const dev = (d: Partial<KnownDevice>): KnownDevice => ({ id: 'd', host: '10.0.6.6', label: 'x', type_id: 'pc', ...d })

describe('reconcile (AC-3 five statuses)', () => {
  it('New: a classified host without a device → new (deviceId null, nothing is written — AC-4)', () => {
    const [e] = reconcile([mo({ ip: '10.0.6.50' }, match('pc'))], [])
    expect(e).toMatchObject({ status: 'new', deviceId: null })
  })

  it('Matched: the host matches a device (IP + type) → matched', () => {
    const [e] = reconcile([mo({ ip: '10.0.6.6' }, match('pc'))], [dev({ id: 'd1', host: '10.0.6.6', type_id: 'pc' })])
    expect(e).toMatchObject({ status: 'matched', deviceId: 'd1' })
  })

  it('Changed: device found, but the proposed type differs → changed', () => {
    const [e] = reconcile([mo({ ip: '10.0.6.6' }, match('router'))], [dev({ id: 'd1', host: '10.0.6.6', type_id: 'pc' })])
    expect(e).toMatchObject({ status: 'changed', deviceId: 'd1' })
  })

  it('Rogue: a host with no device match and no classification → rogue (AC-5)', () => {
    const [e] = reconcile([mo({ ip: '10.0.6.77' }, null)], [dev({ id: 'd1', host: '10.0.6.6' })])
    expect(e).toMatchObject({ status: 'rogue', deviceId: null })
  })

  it('Missing: a device without an observed host → missing', () => {
    const res = reconcile([], [dev({ id: 'd1', host: '10.0.6.6' })])
    expect(res).toEqual([{ status: 'missing', device: expect.objectContaining({ id: 'd1' }) }])
  })
})

describe('reconcile (AC-9 identity via a stable signal when the IP changes)', () => {
  it('same cert-sha256, IP moved → resolves to the same device (changed, not new)', () => {
    const devices = [dev({ id: 'd1', host: '10.0.6.6', type_id: 'pc', tlsCertSha256: CERT })]
    const [e] = reconcile([mo({ ip: '10.0.6.201', tlsCertCn: 'localhost', tlsCertSha256: CERT }, match('pc'))], devices)
    expect(e).toMatchObject({ status: 'changed', deviceId: 'd1' }) // bound to d1 despite the new IP
  })

  it('different signal and different IP → treated as a new host (new), not confused with a device', () => {
    const devices = [dev({ id: 'd1', host: '10.0.6.6', tlsCertSha256: CERT })]
    const [e] = reconcile([mo({ ip: '10.0.6.202', tlsCertSha256: 'deadbeef' }, match('pc'))], devices)
    expect(e).toMatchObject({ status: 'new', deviceId: null })
  })
})
