// RED. Hostname is an observed fact of a device with a source rank
// (`ssh` > `nse` > `ptr`) that never turns into `label` by itself. Pure functions in
// services/discovery.ts, writer in repositories/discovered.ts. Written before the code → must fail.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hostnameUpdates, observedHostname, pickHostname, reconcile, type HostnameFact, type KnownDevice, type MatchResult, type DiffEntry } from '../../server/services/discovery'
import { getKnownDevices, updateDeviceHostname } from '../../server/repositories/discovered'
import { parseHostnameOutput } from '../../server/services/hostname'
import type { Observation } from '../../server/repositories/scanner'

const T1 = '2026-08-10T10:00:00.000Z'
const T2 = '2026-08-14T10:00:00.000Z'
const fact = (value: string, source: HostnameFact['source'], at = T1): HostnameFact => ({ value, source, at })
const obs = (o: Partial<Observation>): Observation => ({ ip: '10.0.6.6', ports: [], ...o })
const match = (typeId = 'pc'): MatchResult => ({ proposedTypeId: typeId, confidence: 70, conflict: false, partial: false, capture: null })
const dev = (d: Partial<KnownDevice>): KnownDevice => ({ id: 'd1', host: '10.0.6.6', label: 'Каса 3', type_id: 'pc', ...d })

describe('pickHostname (AC-3 — source rank decides who overwrites whom)', () => {
  it('no current value → accept any observation', () => {
    expect(pickHostname(null, fact('kasa-7', 'ptr'))).toMatchObject({ value: 'kasa-7', source: 'ptr' })
  })

  it('no new value → current stays (an empty scan does not erase the fact)', () => {
    expect(pickHostname(fact('kasa-7', 'ssh'), null)).toMatchObject({ value: 'kasa-7', source: 'ssh' })
  })

  it('higher rank overwrites lower: ptr → nse → ssh', () => {
    expect(pickHostname(fact('a', 'ptr'), fact('b', 'nse', T2))).toMatchObject({ value: 'b', source: 'nse' })
    expect(pickHostname(fact('b', 'nse'), fact('c', 'ssh', T2))).toMatchObject({ value: 'c', source: 'ssh' })
  })

  it('lower rank does NOT overwrite higher — a scan does not wipe the ssh value', () => {
    expect(pickHostname(fact('c', 'ssh'), fact('a', 'ptr', T2))).toMatchObject({ value: 'c', source: 'ssh' })
    expect(pickHostname(fact('c', 'ssh'), fact('b', 'nse', T2))).toMatchObject({ value: 'c', source: 'ssh' })
  })

  it('equal rank → the fresher one wins', () => {
    expect(pickHostname(fact('old', 'nse', T1), fact('new', 'nse', T2))).toMatchObject({ value: 'new', at: T2 })
  })
})

describe('observedHostname (AC-2/AC-3 — what the scan sees: NSE beats PTR)', () => {
  it('NSE name present → source nse', () => {
    expect(observedHostname(obs({ hostname: 'ptr-name', nseHostname: 'NSE-NAME' }), T2))
      .toMatchObject({ value: 'NSE-NAME', source: 'nse', at: T2 })
  })

  it('reverse DNS only → source ptr', () => {
    expect(observedHostname(obs({ hostname: 'ptr-name' }), T2)).toMatchObject({ value: 'ptr-name', source: 'ptr' })
  })

  it('nothing observed → null (not an empty string)', () => {
    expect(observedHostname(obs({}), T2)).toBeNull()
  })
})

describe('hostnameUpdates (AC-1 — the scan carries the fact onto the matched device)', () => {
  const diff = (status: 'matched' | 'changed' | 'new' | 'rogue', o: Partial<Observation>, deviceId: string | null): DiffEntry =>
    ({ status, obs: obs(o), match: match(), deviceId } as DiffEntry)

  it('matched device with an observed name → one update with source and time', () => {
    const out = hostnameUpdates([diff('matched', { hostname: 'kasa-7' }, 'd1')], [dev({})], T2)
    expect(out).toEqual([{ deviceId: 'd1', fact: { value: 'kasa-7', source: 'ptr', at: T2 } }])
  })

  it('AC-4: the update holds ONLY the hostname triple — no label/type_id/host', () => {
    const [u] = hostnameUpdates([diff('matched', { hostname: 'kasa-7' }, 'd1')], [dev({})], T2)
    expect(Object.keys(u.fact).sort()).toEqual(['at', 'source', 'value'])
  })

  it('lower rank vs an existing ssh → no update at all', () => {
    const devices = [dev({ hostname: 'ssh-name', hostnameSource: 'ssh', hostnameAt: T1 })]
    expect(hostnameUpdates([diff('matched', { hostname: 'ptr-name' }, 'd1')], devices, T2)).toEqual([])
  })

  it('unmatched entries (new/rogue) give no updates — nowhere to write', () => {
    const rows = [diff('new', { hostname: 'x' }, null), diff('rogue', { hostname: 'y' }, null)]
    expect(hostnameUpdates(rows, [], T2)).toEqual([])
  })

  it('same name again → no update (no write noise)', () => {
    const devices = [dev({ hostname: 'kasa-7', hostnameSource: 'ptr', hostnameAt: T1 })]
    expect(hostnameUpdates([diff('matched', { hostname: 'kasa-7' }, 'd1')], devices, T2)).toEqual([])
  })
})

describe('updateDeviceHostname (AC-1/AC-4 — the writer touches only three columns)', () => {
  it('writes hostname/hostname_source/hostname_at and nothing else', async () => {
    let captured: Record<string, unknown> | undefined
    const sr = { from: () => ({ update: (v: Record<string, unknown>) => { captured = v; return { eq: () => Promise.resolve({ error: null }) } } }) }
    await updateDeviceHostname(sr as never, 'd1', fact('kasa-7', 'ssh', T2))
    expect(Object.keys(captured!).sort()).toEqual(['hostname', 'hostname_at', 'hostname_source'])
    expect(captured).toMatchObject({ hostname: 'kasa-7', hostname_source: 'ssh', hostname_at: T2 })
  })
})

describe('getKnownDevices (AC-7 — identity survives a gap in observations)', () => {
  // The device did not match in the last scan → it has no row in discovered_hosts.
  // hostname must come from devices, otherwise the next scan reconciles it by IP only.
  const client = (deviceRow: Record<string, unknown>) => ({
    from: (table: string) => table === 'devices'
      ? { select: () => ({ eq: () => Promise.resolve({ data: [deviceRow], error: null }) }) }
      : { select: () => ({ eq: () => ({ not: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) }) },
  })

  it('returns hostname/source/time from the devices table itself', async () => {
    const [d] = await getKnownDevices(
      client({ id: 'd1', host: '10.0.6.6', label: 'Каса 3', type_id: 'pc', hostname: 'kasa-7', hostname_source: 'ssh', hostname_at: T1 }) as never,
      'p1',
    )
    expect(d).toMatchObject({ id: 'd1', hostname: 'kasa-7', hostnameSource: 'ssh', hostnameAt: T1 })
  })

  it('reconcile matches such a device by name even after an IP change', async () => {
    const devices = await getKnownDevices(
      client({ id: 'd1', host: '10.0.6.6', label: 'Каса 3', type_id: 'pc', hostname: 'kasa-7', hostname_source: 'ssh', hostname_at: T1 }) as never,
      'p1',
    )
    const [e] = reconcile([{ obs: obs({ ip: '10.0.6.201', hostname: 'kasa-7' }), match: match() }], devices)
    expect(e).toMatchObject({ status: 'changed', deviceId: 'd1' })
  })
})

describe('parseHostnameOutput (AC-3 — validation at the boundary: garbage does not become a fact)', () => {
  it('single line of `hostname` output', () => {
    expect(parseHostnameOutput('kasa-7\n')).toBe('kasa-7')
  })

  it('FQDN is accepted, the trailing dot is trimmed', () => {
    expect(parseHostnameOutput('kasa-7.lan.\n')).toBe('kasa-7.lan')
  })

  it('empty output or garbage → null (no fact written)', () => {
    expect(parseHostnameOutput('')).toBeNull()
    expect(parseHostnameOutput('\n  \n')).toBeNull()
    expect(parseHostnameOutput('bash: hostname: command not found')).toBeNull()
    expect(parseHostnameOutput('-bad start')).toBeNull()
  })
})

describe('AC-4 — the scan service has no path that writes label', () => {
  it('the runScan body does not mention label/type_id/host as a written field', () => {
    const src = readFileSync(join(process.cwd(), 'server/services/discovery-scan.ts'), 'utf8')
    const from = src.indexOf('export async function runScan')
    const body = src.slice(from, src.indexOf('\nexport ', from + 1))
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')   // comments are not code
    // the only label writer is confirmDevice (a human action), outside this body
    expect(body).not.toMatch(/\blabel\b/)
    // `proposed_type_id` (a proposal in discovered_hosts) is legitimate, hence \b
    expect(body).not.toMatch(/\btype_id\s*:/)
  })
})
