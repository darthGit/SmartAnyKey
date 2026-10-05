// Bootstrap default admin. seedAdmin is idempotent: a repeated run does not
// duplicate the user and leaves exactly one admin. Precondition: the stack is
// up, 0009 applied.
import { afterAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { seedAdmin } from '../../scripts/seed-admin.mjs'

const service = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const EMAIL = 'rbac-bootstrap@test.local'
const PASSWORD = 'rbac-bootstrap-pass-123'

async function findByEmail(email: string) {
  const { data } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 })
  return (data?.users ?? []).filter(u => u.email === email)
}

afterAll(async () => {
  for (const u of await findByEmail(EMAIL)) await service.auth.admin.deleteUser(u.id).catch(() => {})
})

describe('seed-admin bootstrap', () => {
  it('idempotent_single_admin_from_env: two runs → one admin user with profiles.role=admin', async () => {
    await seedAdmin(service, { email: EMAIL, password: PASSWORD })
    await seedAdmin(service, { email: EMAIL, password: PASSWORD }) // again — no dup

    const users = await findByEmail(EMAIL)
    expect(users.length).toBe(1)

    const { data: profile } = await service.from('profiles')
      .select('role').eq('user_id', users[0]!.id).single()
    expect(profile!.role).toBe('admin')
  })
})
