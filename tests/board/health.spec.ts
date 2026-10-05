// RED: health service.
// probePoint orchestrates probing the point's devices with injected deps (probe/readCached/
// persist/now) — 3-tier: the service does not touch the DB directly,
// the repo seam is injected, which makes the cache gate / bounded parallel unit-testable
// without a live DB. aggregate is a pure function.
import { describe, expect, it, vi } from 'vitest'
import { aggregate, probePoint, type DeviceTarget, type ProbeDeps } from '../../server/services/health'

const T = (over: Partial<DeviceTarget> = {}): DeviceTarget =>
  ({ id: 'd1', action: 'ssh', host: '10.30.0.1', port: 22, ...over })

// Base deps: nothing cached, probe always up, fixed clock.
function deps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    probe: vi.fn(async () => ({ up: true, latencyMs: 5, error: null })),
    readCached: vi.fn(async () => []),
    persist: vi.fn(async () => {}),
    now: () => 1_000_000,
    ...over,
  }
}

describe('aggregate (AC-5)', () => {
  it('aggregate_all_up_has_down_not_probed', () => {
    expect(aggregate([])).toBe('not-probed')
    expect(aggregate(['up', 'up'])).toBe('all-up')
    expect(aggregate(['up', 'down'])).toBe('has-down')
    // anything not up (down/unknown) → has-down: the aggregate signals "something is wrong"
    expect(aggregate(['up', 'unknown'])).toBe('has-down')
    expect(aggregate(['down'])).toBe('has-down')
  })
})

describe('probePoint cache-gate (AC-4)', () => {
  it('cache_gate_reuses_within_30s: fresh cache and !force → no new probe', async () => {
    const now = 1_000_000
    const d = deps({
      now: () => now,
      // row probed 10s ago (< 30s ttl)
      readCached: vi.fn(async () => [
        { device_id: 'd1', action: 'ssh', status: 'up', latency_ms: 4, checked_at: now - 10_000, error: null },
      ]),
    })
    const out = await probePoint(d, [T()], { force: false, ttlMs: 30_000 })
    expect(d.probe).not.toHaveBeenCalled()
    expect(out.devices).toHaveLength(1)
    expect(out.devices[0].status).toBe('up')
  })

  it('cache_gate: stale cache (>30s) → probes again', async () => {
    const now = 1_000_000
    const d = deps({
      now: () => now,
      readCached: vi.fn(async () => [
        { device_id: 'd1', action: 'ssh', status: 'down', latency_ms: null, checked_at: now - 40_000, error: 'refused' },
      ]),
    })
    await probePoint(d, [T()], { force: false, ttlMs: 30_000 })
    expect(d.probe).toHaveBeenCalledTimes(1)
  })

  it('force_refetches: force=true ignores a fresh cache → probes', async () => {
    const now = 1_000_000
    const d = deps({
      now: () => now,
      readCached: vi.fn(async () => [
        { device_id: 'd1', action: 'ssh', status: 'up', latency_ms: 4, checked_at: now - 1_000, error: null },
      ]),
    })
    await probePoint(d, [T()], { force: true, ttlMs: 30_000 })
    expect(d.probe).toHaveBeenCalledTimes(1)
    expect(d.persist).toHaveBeenCalled()
  })
})

describe('probePoint bounded parallel (AC-8)', () => {
  it('probes_devices_in_bounded_parallel: concurrent, but ≤ concurrency', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const probe = vi.fn(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 10))
      inFlight--
      return { up: true, latencyMs: 1, error: null }
    })
    const targets = Array.from({ length: 6 }, (_, i) => T({ id: `d${i}`, host: `10.30.0.${i}` }))
    const d = deps({ probe })
    await probePoint(d, targets, { concurrency: 3 })
    expect(probe).toHaveBeenCalledTimes(6)     // all probed
    expect(maxInFlight).toBeGreaterThan(1)     // not serialized
    expect(maxInFlight).toBeLessThanOrEqual(3) // not above the limit
  })
})
