// Custom tasks, phase 2 integration.
// Prerequisite: the stack is up, migration 0012 is applied. Harness — a service-role
// client against the live DB (like the rbac/credentials integration), no HTTP to :3000.
import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { encryptToBytea, resolveSetById } from '../../server/services/credentials'
import { createCommand, removeCommand } from '../../server/repositories/device-commands'
import { hasRole } from '../../server/utils/rbac'

const url = process.env.SUPABASE_URL!
const service = createClient(url, process.env.SUPABASE_SERVICE_KEY!)
const KEY = process.env.NUXT_CRED_ENCRYPTION_KEY!

const SET_NAME = '__task_cred_test__'
const cleanupCmds: string[] = []

afterAll(async () => {
  try {
    for (const id of cleanupCmds) await removeCommand(service, id)
    await service.from('credential_sets').delete().eq('name', SET_NAME)
  }
  catch { /* best-effort cleanup */ }
})

describe('custom-tasks: task credentials (AC-11)', () => {
  it('AC-11: an unbound set resolves BY ID (bypassing bindings) → decrypt + audit', async () => {
    // A set without any binding — shows that unbound is valid.
    await service.from('credential_sets').delete().eq('name', SET_NAME)
    const { data: set, error } = await service.from('credential_sets')
      .insert({ name: SET_NAME, username: 'api', password_enc: encryptToBytea('super-secret-xyz', KEY), port: null })
      .select('id').single()
    expect(error).toBeNull()
    const setId = set!.id

    // No binding on this set (unbound).
    const { data: bindings } = await service.from('credential_bindings').select('id').eq('cred_set_id', setId)
    expect(bindings).toEqual([])

    // A real device for audit.device_id.
    const { data: dev } = await service.from('devices').select('id').limit(1).single()

    const set2 = await resolveSetById(service, setId, KEY, { actor: '__task_test__', deviceId: dev!.id })
    expect(set2).toMatchObject({ username: 'api', password: 'super-secret-xyz' }) // login+password, not only the password

    // The resolve left an audit row.
    const { data: log } = await service.from('credential_access_log')
      .select('id,action').eq('cred_set_id', setId).eq('action', 'resolve')
    expect((log ?? []).length).toBeGreaterThan(0)
  })
})

describe('custom-tasks: min_role run gate (AC-9)', () => {
  it('AC-9: a command carries min_role (round-trip) and the gate = hasRole', async () => {
    const { data: type } = await service.from('device_types').select('id').limit(1).single()
    const base = {
      type_id: type!.id, name: '__task_test_cmd__', body: 'echo hi', interpreter: 'raw' as const,
      confirm: false, timeout_s: 30, sort: 0, purpose: 'action' as const, stable: false,
      target: 'local' as const, params: [], cred_refs: [],
    }
    const adminCmd = await createCommand(service, { ...base, min_role: 'admin' })
    cleanupCmds.push(adminCmd.id)
    const opCmd = await createCommand(service, { ...base, name: '__task_test_cmd2__', min_role: 'operator' })
    cleanupCmds.push(opCmd.id)

    expect(adminCmd.min_role).toBe('admin')
    expect(opCmd.min_role).toBe('operator')

    // Gate (exec.post): the operator role runs an operator command, NOT an admin command.
    expect(hasRole('operator', opCmd.min_role)).toBe(true)
    expect(hasRole('operator', adminCmd.min_role)).toBe(false)
    expect(hasRole('admin', adminCmd.min_role)).toBe(true)
  })
})

describe('custom-tasks: audit without secrets (AC-10)', () => {
  it('AC-10: the exec.post input snapshot does NOT contain env/secret/meta values', () => {
    const src = readFileSync(new URL('../../server/api/commands/[deviceId]/exec.post.ts', import.meta.url), 'utf8')
    const i = src.indexOf('input:')
    const block = src.slice(i, i + 140)
    expect(block).toContain('body')
    expect(block).toContain('interpreter')
    expect(block).not.toMatch(/\benv\b|formValues|meta|secret|cred_refs/)
  })
})
