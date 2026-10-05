// Credential encryption round-trip between two .mjs copies of the crypto:
// `scripts/seed-dev-targets.mjs` encrypts, `scripts/restore.mjs` decrypts.
// Both are a deliberately duplicated ADR-009 (`iv|tag|ct`), because .mjs cannot import
// `server/services/crypto.ts`. Duplication without this test = drift that would
// show up only during a restore, i.e. at the worst moment.
//
// The live proof is a restore round-trip.
import { createCipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — .mjs script without types
import { decryptFromBytea } from '../../scripts/restore.mjs'

const KEY = randomBytes(32).toString('hex')

/** Mirror of `encryptHex` from seed-dev-targets.mjs (same ADR-009 format). */
function encryptHex(plain: string, keyHex: string) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('hex')
}

describe('credential crypto round-trip', () => {
  it('decrypts what the seeder encrypted, in both bytea spellings', () => {
    const enc = encryptHex('testbox-secret-pass', KEY)
    // psql returns bytea as `\x<hex>`; raw hex is accepted too.
    expect(decryptFromBytea(`\\x${enc}`, KEY)).toBe('testbox-secret-pass')
    expect(decryptFromBytea(enc, KEY)).toBe('testbox-secret-pass')
  })

  it('survives non-ascii and long secrets', () => {
    const secret = 'пароль-з-юнікодом-🔐-'.repeat(20)
    expect(decryptFromBytea(encryptHex(secret, KEY), KEY)).toBe(secret)
  })

  it('throws on the WRONG key instead of returning garbage', () => {
    // GCM auth tag: an error, not silent garbage. The restore diagnostic
    // "not the key this DB was encrypted with" relies on exactly this.
    const other = randomBytes(32).toString('hex')
    expect(() => decryptFromBytea(encryptHex('x', KEY), other)).toThrow()
  })

  it('rejects a truncated ciphertext with a named error', () => {
    expect(() => decryptFromBytea('\\xdeadbeef', KEY)).toThrow(/too short/)
  })
})
