// Unit tests for at-rest credential encryption.
// AES-256-GCM, bytea format = iv(12) | authTag(16) | ciphertext.
import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret } from '../../server/services/crypto'

// 32 bytes = 64 hex (AES-256)
const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

describe('crypto (AC-1)', () => {
  it('round-trip: decrypt(encrypt(p)) === p', () => {
    const p = 'super-secret-πароль-🔑'
    expect(decryptSecret(encryptSecret(p, KEY), KEY)).toBe(p)
  })

  it('ciphertext does not contain the plaintext and has the iv|tag|ct structure', () => {
    const buf = encryptSecret('hunter2', KEY)
    expect(buf.length).toBeGreaterThan(12 + 16) // iv+tag+at least one byte of ct
    expect(buf.toString('utf8')).not.toContain('hunter2')
  })

  it('the same password twice → different ciphertext (random iv)', () => {
    expect(encryptSecret('x', KEY).equals(encryptSecret('x', KEY))).toBe(false)
  })

  it('a tampered ciphertext byte → decrypt throws (GCM auth fail)', () => {
    const buf = encryptSecret('hunter2', KEY)
    buf[buf.length - 1] ^= 0xff // corrupt the last ciphertext byte
    expect(() => decryptSecret(buf, KEY)).toThrow()
  })

  it('a foreign key → decrypt throws', () => {
    const buf = encryptSecret('hunter2', KEY)
    const other = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100'
    expect(() => decryptSecret(buf, other)).toThrow()
  })
})
