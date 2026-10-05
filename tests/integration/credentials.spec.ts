// credential-manager integration — model-independent checks (encryption at rest
// + audit record). Per-protocol resolve is covered by credential-bindings.spec.ts.
// Prerequisite: the stack is up, migrations 0003+0004 applied.
//
// The test owns its own rows (`createDeviceFixture` + its own set): the version
// that read the seed set by `username='smartanykey'` broke on a live DB — there
// are two such sets there, and `.single()` returned null (measured 2026-09-17).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { encryptToBytea, resolveCredentials } from '../../server/services/credentials'
import { createDeviceFixture, type DeviceFixture } from '../helpers/fixtures'

const url = process.env.SUPABASE_URL!
const service = createClient(url, process.env.SUPABASE_SERVICE_KEY!)
const KEY = process.env.NUXT_CRED_ENCRYPTION_KEY!

const PLAINTEXT = 'cred-at-rest-plaintext-42'
const ACTOR = '__audit_test__'
let fx: DeviceFixture
let setId = ''

beforeAll(async () => {
  fx = await createDeviceFixture(service, '__cred')
  const { data, error } = await service.from('credential_sets')
    .insert({ name: `__cred_${process.pid}`, username: 'fixture-user', password_enc: encryptToBytea(PLAINTEXT, KEY), port: 2222 })
    .select('id').single()
  if (error) throw new Error(error.message)
  setId = data!.id
  const { error: bindErr } = await service.from('credential_bindings')
    .insert({ level: 'device', target_id: fx.deviceId, action: 'ssh', cred_set_id: setId })
  if (bindErr) throw new Error(bindErr.message)
})

afterAll(async () => {
  await service.from('credential_access_log').delete().eq('actor', ACTOR)
  await service.from('credential_sets').delete().eq('id', setId) // binding — by cascade
  await fx.cleanup()
})

describe('credential-manager integration', () => {
  it('AC-2: password_enc in the DB does not contain the plaintext password', async () => {
    const { data } = await service
      .from('credential_sets')
      .select('password_enc')
      .eq('id', setId)
      .single()
    // Check the decoded bytes: PostgREST returns bytea as a hex string ("\\x…"),
    // and any plaintext is invisible in it — `toContain` on the raw string is
    // green even when the password sits in the DB as is (measured by mutation
    // 2026-09-17).
    const raw = String(data!.password_enc)
    expect(Buffer.from(raw.replace(/^\\x/, ''), 'hex').toString('latin1')).not.toContain(PLAINTEXT)
    // …and it is ciphertext, not corrupt bytes: the same row decrypts back to
    // plaintext with the key from env (otherwise the test would pass on garbage)
    const cred = await resolveCredentials(service, fx.deviceId, 'ssh', KEY)
    expect(cred!.password).toBe(PLAINTEXT)
  })

  it('AC-8: resolve with audit writes a resolve row to credential_access_log', async () => {
    await resolveCredentials(service, fx.deviceId, 'ssh', KEY, { actor: ACTOR, action: 'resolve' })
    const { data: logs } = await service.from('credential_access_log')
      .select('action, device_id').eq('actor', ACTOR).eq('device_id', fx.deviceId)
    expect(logs!.length).toBeGreaterThanOrEqual(1)
    expect(logs![0].action).toBe('resolve')
  })
})
