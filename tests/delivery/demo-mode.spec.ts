// Demo mode: `install.sh --demo` adds a fictional branch LAN with real SSH/VNC/RDP
// targets and seeds the showcase data. It lives in its own overlay, because the
// customer compose holds only what the product uses (compose-composition.spec.ts),
// and a normal install must not pull a single demo image.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(p, 'utf8')
const install = () => read('docker/install.sh')

describe('demo mode (AC-13, AC-14)', () => {
  it('demo_targets_live_in_their_own_overlay_and_publish_nothing', () => {
    const demo = read('docker/docker-compose.demo.yml')
    for (const svc of ['demo-router', 'demo-desk', 'demo-office', 'demo-signage', 'demo-printer', 'demo-nvr'])
      expect(demo, `${svc} missing from the demo overlay`).toMatch(new RegExp(`^ {2}${svc}:$`, 'm'))
    expect(demo, 'a demo target must not listen on the host').not.toMatch(/^\s+ports:/m)
  })

  it('dev_overlay_no_longer_carries_the_demo_lan', () => {
    expect(read('docker/docker-compose.dev.yml')).not.toMatch(/corp\.lan|demo-router/)
  })

  it('installer_adds_the_overlay_only_in_demo_mode', () => {
    const s = install()
    // The overlay file is named once, inside the branch that --demo / SAK_DEMO=1 opens.
    const at = s.indexOf('docker-compose.demo.yml')
    expect(at, 'install.sh does not know the demo overlay').toBeGreaterThan(-1)
    expect(s.lastIndexOf('docker-compose.demo.yml')).toBe(at)
    expect(s.slice(Math.max(0, at - 300), at), 'the overlay must sit behind the demo switch').toMatch(/SAK_DEMO/)
  })

  it('installer_remembers_demo_mode_so_an_upgrade_keeps_the_targets', () => {
    // Re-running install.sh is the upgrade path and it uses --remove-orphans: without
    // the switch persisted in docker/.env an upgrade would delete the demo targets.
    expect(install()).toMatch(/SAK_DEMO=1/)
    expect(install()).toMatch(/--demo/)
  })

  it('installer_seeds_the_showcase_only_in_demo_mode', () => {
    const s = install()
    const seed = s.indexOf('seed-showcase.mjs')
    expect(seed, 'demo mode must seed the showcase data').toBeGreaterThan(-1)
    expect(s.slice(Math.max(0, seed - 400), seed)).toMatch(/SAK_DEMO/)
  })
})
