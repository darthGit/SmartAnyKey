// RED: hasCredential — boolean presence of a resolvable binding for
// (device, action), without decrypt/audit. Same priority as in resolveCredentials
// (device>type>point>global) — so it is enough to check "present/absent" + that
// a fallback level counts too.
// Prerequisite: the stack is up, like the other integration specs.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { encryptToBytea, hasCredential } from '../../server/services/credentials'
import { createDeviceFixture, type DeviceFixture } from '../helpers/fixtures'

const service = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const KEY = process.env.NUXT_CRED_ENCRYPTION_KEY!

// Own device, not a seeded one: no seed creates a device to rely on (red on a clean DB).
let fx: DeviceFixture
let pc = { id: '' }
const createdSets: string[] = []

async function mkSet(name: string) {
  const { data, error } = await service.from('credential_sets')
    .insert({ name, username: 'u_' + name, password_enc: encryptToBytea('p', KEY), port: null })
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
  fx = await createDeviceFixture(service, '__hc')
  pc = { id: fx.deviceId }
})
afterAll(async () => {
  await fx?.cleanup()
})
afterEach(async () => {
  if (createdSets.length) await service.from('credential_sets').delete().in('id', createdSets)
  createdSets.length = 0
})

describe('hasCredential (AC-1)', () => {
  it('no binding for the action → false', async () => {
    expect(await hasCredential(service, pc.id, 'rdp')).toBe(false)
  })

  it('device binding for the action → true', async () => {
    await bind('device', pc.id, 'vnc', await mkSet('__hc_dev'))
    expect(await hasCredential(service, pc.id, 'vnc')).toBe(true)
  })

  it('binding only at global level → true for the device (fallback counts)', async () => {
    await bind('global', null, 'ssh', await mkSet('__hc_glob'))
    expect(await hasCredential(service, pc.id, 'ssh')).toBe(true)
  })
})
