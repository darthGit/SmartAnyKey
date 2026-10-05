// seed-dev-targets on an empty `device_types` must fail with a clear error,
// not silently insert zero rows.
//
// Why this is a real defect, not a hypothesis: the seeder inserts via
// `with ty as (select id from device_types where slug=…) insert … select … from p, ty`
// — an empty CTE `ty` makes the source empty, so `insert` inserts 0 rows
// without an error, and `ON_ERROR_STOP=1` does not see it.
import { describe, expect, it } from 'vitest'
// @ts-expect-error — an .mjs script without types; we import only the pure guard function
import { requireTypes } from '../../scripts/seed-dev-targets.mjs'

describe('seed taxonomy guard', () => {
  it('empty_device_types_throws_named_error', () => {
    let err: Error | undefined
    try {
      requireTypes(['pos', 'pc'], [])
    }
    catch (e) {
      err = e as Error
    }
    expect(err, 'an empty taxonomy must throw, not pass').toBeInstanceOf(Error)
    // The message must name what is missing and what to do — otherwise it is "zero rows" with different text.
    expect(err!.message).toContain('pos')
    expect(err!.message).toContain('pc')
    expect(err!.message).toContain('seeds/dev.sql')
  })

  it('reports_only_the_missing_slugs', () => {
    let err: Error | undefined
    try {
      requireTypes(['pos', 'pc'], ['pos'])
    }
    catch (e) {
      err = e as Error
    }
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('pc')
    expect(err!.message).not.toContain('pos')
  })

  it('passes_when_all_types_present', () => {
    expect(() => requireTypes(['pos', 'pc'], ['pc', 'pos', 'router'])).not.toThrow()
  })
})
