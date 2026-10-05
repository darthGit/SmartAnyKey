// RBAC integration. Prerequisite: the stack is up, migration 0009 applied.
// Harness: service-role admin API + anon login, no HTTP to :3000.
import { afterAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { getRoleForUser } from '../../server/utils/rbac'

const url = process.env.SUPABASE_URL!
const anonKey = process.env.SUPABASE_KEY!
const service = createClient(url, process.env.SUPABASE_SERVICE_KEY!)

const created: string[] = []
async function makeUser(email: string, password: string) {
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw new Error(`createUser ${email}: ${error.message}`)
  created.push(data.user.id)
  return data.user.id
}

afterAll(async () => {
  for (const id of created) await service.auth.admin.deleteUser(id).catch(() => {})
})

describe('rbac integration', () => {
  it('profileless_user_sees_no_board_rows: a logged-in user without a profile sees no points (RLS deny)', async () => {
    await makeUser('rbac-noprofile@test.local', 'rbac-test-pass-123')
    const anon = createClient(url, anonKey)
    const { error: signErr } = await anon.auth.signInWithPassword({
      email: 'rbac-noprofile@test.local', password: 'rbac-test-pass-123',
    })
    expect(signErr).toBeNull()
    const { data, error } = await anon.from('points').select('id')
    expect(error).toBeNull()
    expect(data).toEqual([]) // require-profile RLS → 0 rows
  })

  it('getRole_reflects_profile_change: a profiles.role change is visible via getRoleForUser at once', async () => {
    const uid = await makeUser('rbac-role@test.local', 'rbac-test-pass-123')
    await service.from('profiles').upsert({ user_id: uid, role: 'viewer' })
    expect(await getRoleForUser(service, uid)).toBe('viewer')
    await service.from('profiles').update({ role: 'operator' }).eq('user_id', uid)
    expect(await getRoleForUser(service, uid)).toBe('operator')
  })
})
