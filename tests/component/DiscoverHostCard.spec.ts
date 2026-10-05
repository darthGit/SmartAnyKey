// @vitest-environment nuxt
// Structured host card: type icon+color + status/conf/port chips; rogue looks
// different. Shared by DiscoverDrawer and TeachStep (the same component, checked
// visually).
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DiscoverHostCard from '../../app/components/DiscoverHostCard.vue'
import type { DeviceType, DiscoveredHost } from '../../app/types/board'

const kasa: DeviceType = {
  id: 't-kasa', slug: 'cash-register', name: 'Каса', icon: '💰',
  color: '#8b5cf6', default_action: 'vnc', sort: 0,
}

const classified: DiscoveredHost = {
  id: 'h1', ip: '192.0.2.20', hostname: 'kasa-01',
  open_ports: [{ port: 21, proto: 'tcp' }, { port: 22, proto: 'tcp' }, { port: 5900, proto: 'tcp' }],
  ssh_hostkey: null, tls_cert_sha256: null, tls_cert_cn: null, os_guess: null,
  confidence: 60, matched_signal: '3/6 · port:5900', reconcile_status: 'new',
  matched_device_id: null, proposed_type_id: 't-kasa',
  device_types: { slug: 'cash-register', name: 'Каса' }, observed_at: '2026-07-21T00:00:00Z',
} as DiscoveredHost

const rogue: DiscoveredHost = {
  id: 'h2', ip: '192.0.2.99', hostname: null,
  open_ports: [{ port: 8291, proto: 'tcp' }],
  ssh_hostkey: null, tls_cert_sha256: null, tls_cert_cn: null, os_guess: null,
  confidence: null, matched_signal: null, reconcile_status: 'rogue',
  matched_device_id: null, proposed_type_id: null, device_types: null,
  observed_at: '2026-07-21T00:00:00Z',
} as DiscoveredHost

describe('DiscoverHostCard', () => {
  it('host_card_shows_type_icon_and_color', async () => {
    const w = await mountSuspended(DiscoverHostCard, { props: { host: classified, types: [kasa] } })
    const icon = w.find('[data-testid="type-icon"]')
    expect(icon.exists()).toBe(true)
    expect(icon.text()).toContain('💰')                  // resolved type icon
    expect(icon.attributes('style') ?? '').toContain('#8b5cf6') // inline type color (from data, not hardcoded)
  })

  it('status_conf_ports_as_chips_rogue_distinct', async () => {
    const w = await mountSuspended(DiscoverHostCard, { props: { host: classified, types: [kasa] } })
    expect(w.find('[data-testid="chip-status"]').exists()).toBe(true)
    const conf = w.find('[data-testid="chip-confidence"]')
    expect(conf.exists()).toBe(true)
    expect(conf.text()).toContain('60')
    expect(w.findAll('[data-testid="chip-port"]').length).toBeGreaterThan(0)

    // rogue: a separate state, no "empty type" (no type-icon)
    const r = await mountSuspended(DiscoverHostCard, { props: { host: rogue, types: [kasa] } })
    expect(r.find('[data-testid="rogue"]').exists()).toBe(true)
    expect(r.find('[data-testid="type-icon"]').exists()).toBe(false)
  })
})
