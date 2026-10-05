// The cookie path of requireUser gets raw JWT claims from @nuxtjs/supabase 2.0.9
// (`serverSupabaseUser` = `auth.getClaims()`): the id lives in `sub`, `id` is absent,
// so every role lookup by `user.id` returned 403. The Bearer path returns a User with `id`.
import { describe, expect, it } from 'vitest'
import * as rbac from '../../server/utils/rbac'

const mod = rbac as Record<string, unknown>
type Normalize = (u: Record<string, unknown>) => { id: string, email?: string }

describe('session user normalisation', () => {
  it('cookie_claims_get_id_from_sub', () => {
    const normalize = mod.sessionUser as Normalize | undefined
    expect(normalize).toBeTypeOf('function')
    const u = normalize!({ sub: 'u-123', email: 'tech@example.com', role: 'authenticated' })
    expect(u.id).toBe('u-123')
    expect(u.email).toBe('tech@example.com')
  })

  it('a User with id passes through', () => {
    const normalize = mod.sessionUser as Normalize | undefined
    expect(normalize).toBeTypeOf('function')
    expect(normalize!({ id: 'u-9', email: 'a@example.com' }).id).toBe('u-9')
  })
})
