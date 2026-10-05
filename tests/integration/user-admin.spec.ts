// User-management lifecycle. Precondition: the stack is up,
// 0009 applied. Harness: user-admin.ts functions + Supabase admin API/anon login.
import { afterAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { changeOwnPassword, createUser, deleteUser, resetPassword } from '../../server/services/user-admin'

const url = process.env.SUPABASE_URL!
const anonKey = process.env.SUPABASE_KEY!
const service = createClient(url, process.env.SUPABASE_SERVICE_KEY!)

const emails: string[] = []
function uniq(tag: string) {
  const e = `um-${tag}@test.local`
  emails.push(e)
  return e
}
async function cleanup() {
  const { data } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 })
  for (const u of (data?.users ?? []).filter(x => emails.includes(x.email!)))
    await service.auth.admin.deleteUser(u.id).catch(() => {})
}
afterAll(cleanup)

const canLogin = async (email: string, password: string) => {
  const { data, error } = await createClient(url, anonKey).auth.signInWithPassword({ email, password })
  return { ok: !error, mustChange: data?.user?.app_metadata?.must_change_password }
}

describe('user-admin lifecycle', () => {
  it('create_returns_temp_and_user_can_login', async () => {
    const email = uniq('create')
    const { tempPassword } = await createUser(service, { email, role: 'operator' })
    expect(tempPassword.length).toBeGreaterThanOrEqual(8)
    const r = await canLogin(email, tempPassword)
    expect(r.ok).toBe(true)
    expect(r.mustChange).toBe(true) // forced change on first login
  })

  it('changeOwnPassword_clears_must_change', async () => {
    const email = uniq('change')
    const { id, tempPassword } = await createUser(service, { email, role: 'viewer' })
    await changeOwnPassword(service, id, 'new-strong-pass-123')
    const r = await canLogin(email, 'new-strong-pass-123')
    expect(r.ok).toBe(true)
    expect(r.mustChange).toBe(false)
    const old = await canLogin(email, tempPassword)
    expect(old.ok).toBe(false) // the old temp no longer works
  })

  it('reset_rearms_must_change_with_new_temp', async () => {
    const email = uniq('reset')
    const { id } = await createUser(service, { email, role: 'viewer' })
    await changeOwnPassword(service, id, 'interim-pass-123') // clears the flag
    const { tempPassword } = await resetPassword(service, id) // admin reset
    const r = await canLogin(email, tempPassword)
    expect(r.ok).toBe(true)
    expect(r.mustChange).toBe(true) // reset re-enables the forced change
  })

  it('delete_cascades_profile', async () => {
    const email = uniq('delete')
    const { id } = await createUser(service, { email, role: 'viewer' })
    await deleteUser(service, id)
    const { data } = await service.from('profiles').select('user_id').eq('user_id', id)
    expect(data).toEqual([]) // profile removed by cascade
    const { data: u } = await service.auth.admin.getUserById(id)
    expect(u?.user ?? null).toBeNull()
  })

  it('blocks_last_admin_delete', async () => {
    // dev@ is the only permanent admin; deleteUser must refuse (409), dev survives.
    const { data: dev } = await service.from('profiles').select('user_id').eq('role', 'admin').single()
    await expect(deleteUser(service, dev!.user_id)).rejects.toThrow()
    const { data: still } = await service.auth.admin.getUserById(dev!.user_id)
    expect(still?.user?.id).toBe(dev!.user_id) // not deleted
  })
})
