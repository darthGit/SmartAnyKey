// RED: pure layout-state helpers — mode from the pane count, sidebar width
// clamp+persist, rail toggle+persist. Module
// app/composables/useBoardLayout does not exist yet → fails. Persist is tested via
// a Storage-like fake (no Nuxt/happy-dom), style — a unit over logic, like
// tests/unit/remote-session.spec.ts.
import { describe, expect, it } from 'vitest'
import {
  clampWidth,
  computeMode,
  loadRailed,
  loadWidth,
  saveRailed,
  saveWidth,
} from '../../app/composables/useBoardLayout'

function fakeStore() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
  }
}

describe('computeMode', () => {
  it('mode_full_when_no_panes', () => {
    expect(computeMode(0)).toBe('full')
  })

  it('mode_split_when_panes', () => {
    expect(computeMode(1)).toBe('split')
    expect(computeMode(3)).toBe('split')
  })
})

describe('sidebar width', () => {
  it('width_clamped_and_persisted', () => {
    const s = fakeStore()
    // clamp: min 220px, max 50% of viewport
    expect(clampWidth(100, 1000)).toBe(220)
    expect(clampWidth(5000, 1000)).toBe(500)
    expect(clampWidth(300, 1000)).toBe(300)
    // persist round-trip (we store the already-clamped value)
    saveWidth(s, clampWidth(5000, 1000))
    expect(loadWidth(s, 1000, 250)).toBe(500)
    // empty storage → fallback
    expect(loadWidth(fakeStore(), 1000, 250)).toBe(250)
  })
})

describe('rail', () => {
  it('rail_toggle_persisted', () => {
    const s = fakeStore()
    expect(loadRailed(s)).toBe(false) // default
    saveRailed(s, true)
    expect(loadRailed(s)).toBe(true)
    saveRailed(s, false)
    expect(loadRailed(s)).toBe(false)
  })
})
