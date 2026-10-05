// One in-memory sliding-window limiter for every BFF limit (webhook, session open,
// first-admin setup, password change). Pure: the clock is a parameter.
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { hitRate, resetRates } from '../../server/utils/rate-limit'

const MIN = 60_000

describe('hitRate', () => {
  beforeEach(() => resetRates())

  it('allows_max_hits_in_the_window_then_refuses_with_seconds_to_wait', () => {
    for (let i = 0; i < 3; i++)
      expect(hitRate('k', 3, MIN, 1_000 + i)).toBe(0)
    // The oldest hit (t=1000) leaves the window at t=61000 → 59.998 s from t=1002 → 60.
    expect(hitRate('k', 3, MIN, 1_002)).toBe(60)
  })

  it('a_refused_hit_does_not_extend_the_wait', () => {
    for (let i = 0; i < 3; i++) hitRate('k', 3, MIN, 0)
    for (let i = 0; i < 10; i++) expect(hitRate('k', 3, MIN, 30_000)).toBe(30)
    expect(hitRate('k', 3, MIN, MIN)).toBe(0)
  })

  it('keys_are_independent', () => {
    for (let i = 0; i < 3; i++) hitRate('a', 3, MIN, 0)
    expect(hitRate('a', 3, MIN, 0)).toBeGreaterThan(0)
    expect(hitRate('b', 3, MIN, 0)).toBe(0)
  })

  it('the_window_slides', () => {
    for (let i = 0; i < 3; i++) hitRate('k', 3, MIN, i * 10_000)
    expect(hitRate('k', 3, MIN, 59_999)).toBeGreaterThan(0)
    expect(hitRate('k', 3, MIN, 60_001)).toBe(0)
  })
})

// The limiter is only as good as its call sites — source scan, as the route-gate tests do.
describe('limits are wired', () => {
  const src = (p: string) => readFileSync(p, 'utf8')
  it.each([
    ['server/api/setup/admin.post.ts', /assertRate\(event, `setup:/],
    ['server/api/auth/change-password.post.ts', /assertRate\(event, `pwd:/],
    ['server/routes/api/terminal/[deviceId].ws.ts', /hitRate\(`session:\$\{user\.id\}`/],
    ['server/routes/api/guac/[deviceId].ws.ts', /hitRate\(`session:\$\{user\.id\}`/],
  ])('%s', (file, call) => {
    expect(src(file)).toMatch(call)
  })
})
