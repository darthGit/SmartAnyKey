// Unit tests of the task panel's pure helpers.
// The panel is self-contained (fetches data through the BFF), so we test the decisions —
// "when is the next run", "how long has it been running", "how much space" — without a browser.
import { describe, expect, it } from 'vitest'
import { formatBytes, formatDuration, nextCronRun, runDurationMs, runStatusColor } from '../../app/utils/taskFormat'

const NOW = new Date('2026-08-13T12:00:00.000Z')

describe('nextCronRun', () => {
  it('takes the nearest time among several cron triggers', () => {
    const r = nextCronRun([
      { kind: 'cron', next_run_at: '2026-08-13T18:00:00.000Z', enabled: true },
      { kind: 'cron', next_run_at: '2026-08-13T12:05:00.000Z', enabled: true },
    ], NOW)
    expect(r?.at).toBe('2026-08-13T12:05:00.000Z')
    expect(r?.inMs).toBe(5 * 60_000)
  })

  it('a disabled trigger does not count (AC-6 — the toggle really disables)', () => {
    const r = nextCronRun([
      { kind: 'cron', next_run_at: '2026-08-13T12:05:00.000Z', enabled: false },
      { kind: 'cron', next_run_at: '2026-08-13T13:00:00.000Z', enabled: true },
    ], NOW)
    expect(r?.at).toBe('2026-08-13T13:00:00.000Z')
  })

  it('a webhook trigger has no "next run"', () => {
    expect(nextCronRun([{ kind: 'webhook', enabled: true }], NOW)).toBeNull()
    expect(nextCronRun([], NOW)).toBeNull()
    expect(nextCronRun(null, NOW)).toBeNull()
  })

  it('an overdue slot returns a negative inMs — downtime must be visible', () => {
    // "the backup did not run for three days and nobody noticed" — the panel shows
    // the overdue state instead of quietly drawing a future date.
    const r = nextCronRun([{ kind: 'cron', next_run_at: '2026-08-13T08:00:00.000Z', enabled: true }], NOW)
    expect(r?.inMs).toBe(-4 * 3600_000)
  })
})

describe('formatDuration', () => {
  it.each([
    [1400, '1.4s'],
    [59_900, '59.9s'],
    [125_000, '2m 05s'],
    [3_600_000, '1h 00m'],
    [3_780_000, '1h 03m'],
    [0, '0s'],
  ])('%i ms → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })

  it('nothing to show — empty, not "NaNs"', () => {
    expect(formatDuration(null)).toBe('')
    expect(formatDuration(undefined)).toBe('')
    expect(formatDuration(-5)).toBe('')
  })
})

describe('runDurationMs', () => {
  it('an unfinished run counts up to now — the panel timer ticks', () => {
    const run = { status: 'running', started_at: '2026-08-13T11:59:30.000Z', finished_at: null }
    expect(runDurationMs(run, NOW)).toBe(30_000)
  })

  it('the duration measured by the runner takes priority over the time difference', () => {
    const run = {
      status: 'done',
      started_at: '2026-08-13T11:59:00.000Z',
      finished_at: '2026-08-13T12:00:00.000Z',
      result: { durationMs: 41_000 },
    }
    expect(runDurationMs(run, NOW)).toBe(41_000)
  })

  it('without started_at — null, not 0 (0 would look like an "instant run")', () => {
    expect(runDurationMs({ status: 'running' }, NOW)).toBeNull()
    expect(runDurationMs(null, NOW)).toBeNull()
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [912_345, '912.3 kB'],
    [1_400_000_000, '1.4 GB'],
  ])('%i → %s', (n, expected) => {
    expect(formatBytes(n)).toBe(expected)
  })

  it('unknown size — empty', () => {
    expect(formatBytes(null)).toBe('')
    expect(formatBytes(undefined)).toBe('')
  })
})

describe('runStatusColor', () => {
  it('skipped is NOT an error (AC-7: a skip is visible but not red)', () => {
    expect(runStatusColor('skipped')).toBe('neutral')
    expect(runStatusColor('done')).toBe('success')
    expect(runStatusColor('failed')).toBe('error')
    expect(runStatusColor('running')).toBe('info')
    expect(runStatusColor(undefined)).toBe('neutral')
  })
})
