// RED. Precondition: the stack is up.
// Harness as in tests/integration/point-crud.spec.ts — service-role round-trip,
// no HTTP to :3000.
//
// ⚠ This file proves exactly half of the gate — the rejection. The other half
// (creating the first admin + a race of two concurrent POSTs) needs a "zero admins"
// state, while the dev DB must hold exactly one admin (user-admin.spec.ts takes it
// via `.single()`). A test that assumes a clean DB is the same defect that cost a
// session in credential-bindings. The creation half is proven by a live run in a
// clean room.
import { createClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { createFirstAdmin } from '../../server/services/setup'

const service = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)

const CANDIDATE_EMAIL = '__first-admin-test__@smartanykey.local'

let adminsBefore = 0

beforeAll(async () => {
  const { count, error } = await service
    .from('profiles')
    .select('user_id', { count: 'exact', head: true })
    .eq('role', 'admin')
  if (error)
    throw new Error(`profiles count: ${error.message}`)
  adminsBefore = count ?? 0
  // The test's precondition, stated out loud: it checks the rejection, so an admin must exist.
  expect(adminsBefore, 'the dev DB must have ≥1 admin — otherwise this test checks the wrong thing').toBeGreaterThan(0)
})

describe('first admin gate (AC-2)', () => {
  it('rejects_when_an_admin_already_exists', async () => {
    await expect(createFirstAdmin(service, {
      email: CANDIDATE_EMAIL,
      password: 'irrelevant-because-it-must-be-rejected',
    })).rejects.toThrow()
  })

  it('rejected_attempt_creates_no_rows', async () => {
    await createFirstAdmin(service, {
      email: CANDIDATE_EMAIL,
      password: 'irrelevant-because-it-must-be-rejected',
    }).catch(() => {})

    const { count } = await service
      .from('profiles')
      .select('user_id', { count: 'exact', head: true })
      .eq('role', 'admin')
    expect(count, 'a refusal must leave behind neither an admin nor an auth user').toBe(adminsBefore)

    const { data: list } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 })
    const leaked = (list?.users ?? []).find(u => u.email === CANDIDATE_EMAIL)
    expect(leaked, 'auth user created before the gate check = half-written record').toBeUndefined()
  })
})
