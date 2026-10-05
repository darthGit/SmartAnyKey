// RED. Install step 2, which the client currently does by hand:
// `SAK_PUBLIC_SUPABASE_URL` must be reachable both from the browser AND from
// inside the container, so `localhost` there only fits host-dev.
//
// Why this is not done in compose: `docker-compose.yml:643` is interpolated at
// parse time, before the container starts, so autodetection is only possible in
// the image. For the same reason compose drops the `:-http://localhost:8000`
// default — with a non-empty default the entrypoint cannot tell "the client
// deliberately set localhost" from "not set".
import { describe, expect, it } from 'vitest'
// @ts-expect-error — .mjs script without types
import { resolvePublicAddress } from '../../scripts/public-address.mjs'

/** Shape of node:os networkInterfaces() — exactly what stdlib returns. */
const NETS = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [
    { address: 'fe80::1', family: 'IPv6', internal: false },
    { address: '192.0.2.10', family: 'IPv4', internal: false },
  ],
  docker0: [{ address: '198.51.100.1', family: 'IPv4', internal: false }],
}

describe('public address (AC-5)', () => {
  it('env_url_overrides_autodetect', () => {
    const r = resolvePublicAddress({ envUrl: 'http://sak.example:8000', nets: NETS, port: 8000 })
    expect(r.url).toBe('http://sak.example:8000')
    expect(r.source).toBe('env')
  })

  it('autodetect_picks_first_non_loopback_ipv4_and_reports_it', () => {
    const r = resolvePublicAddress({ envUrl: '', nets: NETS, port: 8000 })
    expect(r.url).toBe('http://192.0.2.10:8000')
    expect(r.source).toBe('autodetect')
    // "Says it out loud" is part of the decision, not cosmetics: silent guessing
    // here is worse than an error. The notice must name both the address and the NIC.
    expect(r.notice).toContain('192.0.2.10')
    expect(r.notice).toContain('eth0')
  })

  it('skips_loopback_and_ipv6', () => {
    const only = { lo: NETS.lo, eth1: [{ address: '::1', family: 'IPv6', internal: false }] }
    const r = resolvePublicAddress({ envUrl: '', nets: only, port: 8000 })
    // Nothing to pick — silently setting localhost would hand the client an
    // install that returns 500 on every gated route.
    expect(r.url).toBeNull()
    expect(r.notice).toMatch(/SAK_PUBLIC_SUPABASE_URL/)
  })

  it('skips_docker_bridges', () => {
    // docker0/br-* is our own bridge, not the machine's address on the client network.
    // Picking it = an install unreachable from the technician's browser.
    const first = { docker0: NETS.docker0, eth0: NETS.eth0 }
    expect(resolvePublicAddress({ envUrl: '', nets: first, port: 8000 }).url)
      .toBe('http://192.0.2.10:8000')
  })

  it('accepts_numeric_family_from_older_node', () => {
    // node:os returns family as the string 'IPv4' on 18+, as the number 4 on older ones.
    const numeric = { eth0: [{ address: '192.0.2.20', family: 4, internal: false }] }
    expect(resolvePublicAddress({ envUrl: '', nets: numeric, port: 8000 }).url)
      .toBe('http://192.0.2.20:8000')
  })

  it('whitespace_only_env_counts_as_unset', () => {
    const r = resolvePublicAddress({ envUrl: '   ', nets: NETS, port: 8000 })
    expect(r.source).toBe('autodetect')
  })
})

// Regression found by a live clean-room run on 2026-09-18, not by a test:
// all the logic above was green, yet on install autodetection never fired once —
// because `bootstrap.mjs` copies `.env.example` verbatim (replacing only the
// secrets), and it had `SAK_PUBLIC_SUPABASE_URL=http://localhost:8000`. So the
// entrypoint always saw "set explicitly" and kept localhost, after which every
// gated route returned 500 (`profiles count: TypeError: fetch failed`).
describe('.env.example does not pin the public address (AC-5)', () => {
  it('ships_the_variable_empty_so_autodetect_can_run', async () => {
    const { readFileSync } = await import('node:fs')
    const line = readFileSync('docker/.env.example', 'utf8')
      .split('\n')
      .find(l => l.startsWith('SAK_PUBLIC_SUPABASE_URL='))
    expect(line, 'docker/.env.example has no SAK_PUBLIC_SUPABASE_URL').toBeDefined()
    expect(line!.slice('SAK_PUBLIC_SUPABASE_URL='.length).trim(),
      'a non-empty value in the template disables auto-detection on EVERY install').toBe('')
  })
})
