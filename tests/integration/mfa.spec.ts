// Integration — the second factor is required by the server, not only by the sign-in form:
// a password-only token of a user who has a factor (or whose role is under the policy) reads
// no board rows and cannot open a session; resetting a factor brings the user back to a
// password. Precondition: stack up, migrations applied, psql in PATH.
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { psql } from '../../scripts/lib/pg.mjs'
import { getUserByToken } from '../../server/repositories/supabase-admin'
import { resetMfa } from '../../server/services/user-admin'
import { totp } from '../helpers/totp'

const url = process.env.SUPABASE_URL!
const anonKey = process.env.SUPABASE_KEY!
const service = createClient(url, process.env.SUPABASE_SERVICE_KEY!)
const PASSWORD = 'mfa-test-pass-123'

const created: string[] = []
let savedPolicy: string | null = null

async function makeUser(tag: string, role: 'viewer' | 'operator' | 'admin') {
  const email = `mfa-${tag}-${process.pid}@test.local`
  const { data, error } = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })
  if (error) throw new Error(`createUser ${email}: ${error.message}`)
  created.push(data.user.id)
  await service.from('profiles').upsert({ user_id: data.user.id, role })
  return { id: data.user.id, email }
}

async function signIn(email: string) {
  const client = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`signIn ${email}: ${error.message}`)
  return { client, token: data.session!.access_token }
}

// Enroll and verify a TOTP factor the way the profile page does; returns the aal2 session.
async function enroll(client: SupabaseClient) {
  const { data: f, error } = await client.auth.mfa.enroll({ factorType: 'totp' })
  if (error) throw new Error(`enroll: ${error.message}`)
  const { data: v, error: vErr } = await client.auth.mfa.challengeAndVerify({ factorId: f.id, code: totp(f.totp.secret) })
  if (vErr) throw new Error(`verify: ${vErr.message}`)
  return { factorId: f.id, secret: f.totp.secret, token: v.access_token }
}

const boardRows = async (client: SupabaseClient) => (await client.from('points').select('id').limit(1)).data ?? []
const setPolicy = (role: string | null) => service.from('app_settings').update({ mfa_required_role: role }).eq('id', true)

beforeAll(async () => {
  const { data } = await service.from('app_settings').select('mfa_required_role').single()
  savedPolicy = data?.mfa_required_role ?? null
  await setPolicy(null)
})

afterAll(async () => {
  await setPolicy(savedPolicy)
  for (const id of created) await service.auth.admin.deleteUser(id).catch(() => {})
})

describe('a user with a verified factor', () => {
  let email: string
  let aal2Token: string

  beforeAll(async () => {
    ({ email } = await makeUser('enrolled', 'operator'))
    const { client } = await signIn(email)
    aal2Token = (await enroll(client)).token
  })

  it('at aal2 reads the board and the session token is accepted', async () => {
    const client = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${aal2Token}` } } })
    expect(await boardRows(client)).toHaveLength(1)
    expect((await getUserByToken(aal2Token))?.email).toBe(email)
  })

  it('a password-only (aal1) session reads no board rows and its token opens no session', async () => {
    const { client, token } = await signIn(email)
    expect(await boardRows(client)).toEqual([])
    expect(await getUserByToken(token)).toBeNull()
  })
})

describe('policy by role', () => {
  it('a role under the policy without a factor is refused until it enrolls', async () => {
    const { email } = await makeUser('forced', 'operator')
    await setPolicy('operator')
    try {
      const { client, token } = await signIn(email)
      expect(await boardRows(client)).toEqual([])
      expect(await getUserByToken(token)).toBeNull()
    }
    finally { await setPolicy(null) }
  })

  it('a role below the policy works with a password, as before', async () => {
    const { email } = await makeUser('below', 'viewer')
    await setPolicy('admin')
    try {
      const { client, token } = await signIn(email)
      expect(await boardRows(client)).toHaveLength(1)
      expect((await getUserByToken(token))?.email).toBe(email)
    }
    finally { await setPolicy(null) }
  })

  it('a fresh install requires 2FA for admins', () => {
    const def = psql(['-At', '-c', `select column_default from information_schema.columns
      where table_schema='public' and table_name='app_settings' and column_name='mfa_required_role'`]).trim()
    expect(def).toMatch(/^'admin'/)
  })
})

describe('every table the browser reads is behind the second factor', () => {
  it('each table with a select policy for authenticated has a restrictive mfa_ok policy', () => {
    const rows = psql(['-At', '-F', '|', '-c', `
      select tablename, bool_or(permissive = 'RESTRICTIVE' and qual like '%mfa_ok%')
      from pg_policies
      where schemaname = 'public' and cmd in ('SELECT', 'ALL') and 'authenticated' = any(roles)
      group by tablename order by tablename`]).trim().split('\n').map(l => l.split('|'))
    // Exempt on purpose: a user must read their own profile and the policy before aal2.
    const exempt = ['profiles', 'app_settings']
    const open = rows.filter(([t, ok]) => ok !== 't' && !exempt.includes(t!)).map(([t]) => t)
    expect(rows.length).toBeGreaterThan(10)
    expect(open).toEqual([])
  })
})

describe('getting back a lost factor', () => {
  it('an admin reset removes the factor; the next sign-in works with a password', async () => {
    const { id, email } = await makeUser('reset', 'operator')
    await enroll((await signIn(email)).client)
    await resetMfa(service, id, 'mfa-test-admin@test.local')
    const { data } = await service.auth.admin.mfa.listFactors({ userId: id })
    expect(data?.factors ?? []).toEqual([])
    const { client } = await signIn(email)
    expect(await boardRows(client)).toHaveLength(1)
  })

  it('scripts/reset-mfa.mjs <email> removes the factor from the command line', async () => {
    const { id, email } = await makeUser('script', 'admin')
    await enroll((await signIn(email)).client)
    const res = spawnSync('node', ['scripts/reset-mfa.mjs', email], { encoding: 'utf8', env: process.env })
    expect(res.status, res.stderr).toBe(0)
    const { data } = await service.auth.admin.mfa.listFactors({ userId: id })
    expect(data?.factors ?? []).toEqual([])
  })
})
