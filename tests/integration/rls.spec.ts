// RLS part. Precondition: the local stack is up,
// migrations applied.
import { beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL!
const anonKey = process.env.SUPABASE_KEY!

describe('RLS', () => {
  it('AC-1: without a JWT points are not readable (0 rows)', async () => {
    const anon = createClient(url, anonKey)
    const { data, error } = await anon.from('points').select('id')
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  describe('authenticated', () => {
    const client = createClient(url, anonKey)

    beforeAll(async () => {
      const { error } = await client.auth.signInWithPassword({
        email: 'dev@smartanykey.local',
        password: 'devpassword123',
      })
      if (error) throw new Error(`Test user login failed: ${error.message}`)
    })

    it('sees points (seed in place)', async () => {
      const { data, error } = await client.from('points').select('id', { count: 'exact', head: false }).limit(1)
      expect(error).toBeNull()
      expect(data!.length).toBe(1)
    })

    it('AC-7: credential_sets are closed even to authenticated (0 rows, no password_enc)', async () => {
      const { data, error } = await client.from('credential_sets').select('*')
      expect(error).toBeNull()
      expect(data).toEqual([]) // RLS deny-all → no rows, so password_enc does not leak either
    })
  })
})
