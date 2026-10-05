// Integration of per-protocol resolve.
// Preconditions: stack up, 0004 applied.
// resolveCredentials(client, deviceId, action, keyHex, audit?) is the new signature.
// The "mint fetches the vnc set via POST" check was removed with json-auth (ADR-010):
// the endpoint no longer mints a token; "action → right set" is guarded by the ssh/vnc test.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { encryptToBytea, resolveCredentials } from '../../server/services/credentials'
import { createDeviceFixture, type DeviceFixture } from '../helpers/fixtures'

const url = process.env.SUPABASE_URL!
const service = createClient(url, process.env.SUPABASE_SERVICE_KEY!)
const KEY = process.env.NUXT_CRED_ENCRYPTION_KEY!

// Own "point→type→device" branch, not a seed device: the live DB has 300 devices
// labelled "PC", any of them already has a vnc set at the type level, and that
// overrides the point level the fallback test creates (measured 2026-09-17).
let fx: DeviceFixture
let pc = { id: '', type_id: '', point_id: '' }
const createdSets: string[] = []

async function mkSet(name: string, password: string, port: number | null = null) {
  const { data, error } = await service.from('credential_sets')
    .insert({ name, username: 'u_' + name, password_enc: encryptToBytea(password, KEY), port })
    .select('id').single()
  if (error) throw new Error(error.message)
  createdSets.push(data!.id)
  return data!.id as string
}
async function bind(level: string, targetId: string | null, action: string, credSetId: string) {
  const { error } = await service.from('credential_bindings')
    .insert({ level, target_id: targetId, action, cred_set_id: credSetId })
  if (error) throw new Error(error.message)
}

beforeAll(async () => {
  fx = await createDeviceFixture(service, '__cpp')
  pc = { id: fx.deviceId, type_id: fx.typeId, point_id: fx.pointId }
})

afterAll(async () => { await fx.cleanup() })

afterEach(async () => {
  // cred_set_id ON DELETE CASCADE removes bindings together with the sets
  if (createdSets.length) await service.from('credential_sets').delete().in('id', createdSets)
  createdSets.length = 0
})

describe('per-protocol resolve', () => {
  it('AC-1: device level for the action wins over type', async () => {
    const d = await mkSet('__cpp_dev', 'dev-pass')
    const t = await mkSet('__cpp_type', 'type-pass')
    await bind('device', pc.id, 'ssh', d)
    await bind('type', pc.type_id, 'ssh', t)
    const cred = await resolveCredentials(service, pc.id, 'ssh', KEY)
    expect(cred!.password).toBe('dev-pass')
  })

  it('AC-2: fallback type → point → global for the action', async () => {
    const t = await mkSet('__cpp_t', 'type-pass')
    await bind('type', pc.type_id, 'rdp', t)
    expect((await resolveCredentials(service, pc.id, 'rdp', KEY))!.password).toBe('type-pass')

    const p = await mkSet('__cpp_p', 'point-pass')
    await bind('point', pc.point_id, 'vnc', p)
    expect((await resolveCredentials(service, pc.id, 'vnc', KEY))!.password).toBe('point-pass')

    const g = await mkSet('__cpp_g', 'global-pass')
    await bind('global', null, 'ssh', g)
    expect((await resolveCredentials(service, pc.id, 'ssh', KEY))!.password).toBe('global-pass')
  })

  it('AC-3: ssh and vnc on one device → different sets', async () => {
    const s = await mkSet('__cpp_ssh', 'ssh-secret')
    const v = await mkSet('__cpp_vnc', 'vnc-secret')
    await bind('device', pc.id, 'ssh', s)
    await bind('device', pc.id, 'vnc', v)
    expect((await resolveCredentials(service, pc.id, 'ssh', KEY))!.password).toBe('ssh-secret')
    expect((await resolveCredentials(service, pc.id, 'vnc', KEY))!.password).toBe('vnc-secret')
  })

  it('AC-4: no binding for the action → null', async () => {
    const cred = await resolveCredentials(service, pc.id, 'rdp', KEY)
    expect(cred).toBeNull()
  })

  it('AC-5: unique(level,target,action) — a second binding is rejected', async () => {
    const a = await mkSet('__cpp_a', 'a')
    const b = await mkSet('__cpp_b', 'b')
    await bind('device', pc.id, 'ssh', a)
    await expect(bind('device', pc.id, 'ssh', b)).rejects.toThrow()
  })

  // The only test in the file that deliberately relies on seed data: it checks
  // the `pnpm dev:seed` contract — the testbox device + a set encrypted with the real
  // key from env resolves end to end. A fixture here would destroy the very subject
  // (encrypt and decrypt within one test is the cred-crypto.spec.ts unit).
  it('AC-6: testbox after 0004 resolves under ssh; no cred_set_id columns', async () => {
    const { data: tb } = await service.from('devices').select('id').eq('label', 'Testbox SSH').single()
    const cred = await resolveCredentials(service, tb!.id, 'ssh', KEY)
    expect(cred).toEqual({ username: 'smartanykey', password: 'testbox-secret-pass', port: 2222 })
    // column removed → select cred_set_id must return an error
    const { error } = await service.from('devices').select('cred_set_id').limit(1)
    expect(error).not.toBeNull()
  })
})
