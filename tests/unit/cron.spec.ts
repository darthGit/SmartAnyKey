// RED. Our own minimal cron parser — no new dependency:
// 5 fields + `*`, `n`, `n-m`, `a,b`, `*/n` + `@hourly`/`@daily`.
// Module server/utils/cron.ts does not exist yet → the suite fails.
//
// Pitfall: the next time is computed from the given `from`, so a scheduler
// that passes `now` will NOT run 48 missed slots after downtime. Here we check
// exactly this parser property; the misfire policy is in task-scheduler.spec.ts.
import { describe, expect, it } from 'vitest'
import { nextRunAt, parseCron } from '../../server/utils/cron'

// Install-local time: one TZ for the whole instance; tests build dates
// with the Date constructor → the same local TZ as the parser.
const at = (iso: string) => new Date(iso)

describe('parseCron — validation (AC-6)', () => {
  it('accepts_five_field_expressions', () => {
    expect(() => parseCron('*/5 * * * *')).not.toThrow()
    expect(() => parseCron('0 9-17 * * 1-5')).not.toThrow()
    expect(() => parseCron('0 0,12 1 * *')).not.toThrow()
  })

  it('accepts_shorthands', () => {
    expect(() => parseCron('@hourly')).not.toThrow()
    expect(() => parseCron('@daily')).not.toThrow()
  })

  it('invalid_expression_throws: too few fields', () => {
    expect(() => parseCron('* * *')).toThrow()
  })

  it('invalid_expression_throws: field out of range', () => {
    expect(() => parseCron('99 * * * *')).toThrow() // minute 0-59
    expect(() => parseCron('0 24 * * *')).toThrow() // hour 0-23
    expect(() => parseCron('0 0 32 * *')).toThrow() // day 1-31
    expect(() => parseCron('0 0 * 13 *')).toThrow() // month 1-12
    expect(() => parseCron('0 0 * * 8')).toThrow() // dow 0-7
  })

  it('invalid_expression_throws: garbage and step 0', () => {
    expect(() => parseCron('abc')).toThrow()
    expect(() => parseCron('*/0 * * * *')).toThrow()
    expect(() => parseCron('')).toThrow()
  })

  it('invalid_expression_throws: reversed range', () => {
    expect(() => parseCron('0 17-9 * * *')).toThrow()
  })
})

describe('nextRunAt — step and boundaries (AC-6)', () => {
  it('next_run_at_every_5_minutes', () => {
    expect(nextRunAt('*/5 * * * *', at('2026-08-13T10:03:00')))
      .toEqual(at('2026-08-13T10:05:00'))
  })

  it('step crosses the hour boundary', () => {
    expect(nextRunAt('*/5 * * * *', at('2026-08-13T10:57:30')))
      .toEqual(at('2026-08-13T11:00:00'))
  })

  it('result is strictly in the future — exactly on a slot does not return the same time', () => {
    const from = at('2026-08-13T10:05:00')
    expect(nextRunAt('*/5 * * * *', from).getTime()).toBeGreaterThan(from.getTime())
  })

  it('hour range n-m', () => {
    expect(nextRunAt('0 9-17 * * *', at('2026-08-13T08:10:00')))
      .toEqual(at('2026-08-13T09:00:00'))
    expect(nextRunAt('0 9-17 * * *', at('2026-08-13T09:30:00')))
      .toEqual(at('2026-08-13T10:00:00'))
    // after the window — next day at 9:00
    expect(nextRunAt('0 9-17 * * *', at('2026-08-13T18:00:00')))
      .toEqual(at('2026-08-14T09:00:00'))
  })

  it('list a,b', () => {
    expect(nextRunAt('0 0,12 * * *', at('2026-08-13T03:00:00')))
      .toEqual(at('2026-08-13T12:00:00'))
    expect(nextRunAt('0 0,12 * * *', at('2026-08-13T13:00:00')))
      .toEqual(at('2026-08-14T00:00:00'))
  })

  it('month boundary: 0 0 1 * * from mid-month', () => {
    expect(nextRunAt('0 0 1 * *', at('2026-08-13T10:00:00')))
      .toEqual(at('2026-09-01T00:00:00'))
  })

  it('February boundary of a non-leap year (2027-02-28 → 03-01)', () => {
    expect(nextRunAt('0 0 * * *', at('2027-02-28T12:00:00')))
      .toEqual(at('2027-03-01T00:00:00'))
  })

  it('day of week: 0 0 * * 1 = the nearest Monday', () => {
    // 2026-08-13 is a Thursday → Monday 2026-08-17
    expect(nextRunAt('0 0 * * 1', at('2026-08-13T10:00:00')))
      .toEqual(at('2026-08-17T00:00:00'))
  })

  it('dow 7 == 0 (Sunday)', () => {
    expect(nextRunAt('0 0 * * 7', at('2026-08-13T10:00:00')))
      .toEqual(nextRunAt('0 0 * * 0', at('2026-08-13T10:00:00')))
  })

  it('@hourly / @daily', () => {
    expect(nextRunAt('@hourly', at('2026-08-13T10:03:00')))
      .toEqual(at('2026-08-13T11:00:00'))
    expect(nextRunAt('@daily', at('2026-08-13T10:03:00')))
      .toEqual(at('2026-08-14T00:00:00'))
  })
})

describe('nextRunAt — from `from`, not from the missed slot (AC-17)', () => {
  it('next_run_computed_from_now_not_missed_slot', () => {
    // 4 hours of downtime: the slot that should have run is 06:00.
    const missedSlot = at('2026-08-13T06:00:00')
    const now = at('2026-08-13T10:02:00')

    const fromNow = nextRunAt('*/5 * * * *', now)
    const fromMissed = nextRunAt('*/5 * * * *', missedSlot)

    // From `now` — the next slot after now; from the missed one — 06:05 (start of a burst).
    expect(fromNow).toEqual(at('2026-08-13T10:05:00'))
    expect(fromMissed).toEqual(at('2026-08-13T06:05:00'))
    expect(fromNow.getTime()).toBeGreaterThan(now.getTime())
  })

  it('no call returns a time in the past relative to `from`', () => {
    const now = at('2026-08-13T10:02:34')
    for (const expr of ['*/5 * * * *', '@hourly', '@daily', '0 9-17 * * 1-5', '0 0 1 * *'])
      expect(nextRunAt(expr, now).getTime(), expr).toBeGreaterThan(now.getTime())
  })
})
