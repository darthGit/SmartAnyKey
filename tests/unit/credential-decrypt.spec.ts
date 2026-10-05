// A stored password that the install's key cannot decrypt (foreign key, corrupted row)
// must surface as its own error class, so the session routes can say so instead of
// "host unreachable". Namespace import: the test stays valid before the export exists.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as credentials from '../../server/services/credentials'
import { encryptSecret } from '../../server/services/crypto'

const mod = credentials as Record<string, unknown>
const keyA = randomBytes(32).toString('hex')
const keyB = randomBytes(32).toString('hex')
const stored = `\\x${encryptSecret('s3cret', keyA).toString('hex')}`

describe('stored credential decryption', () => {
  it('foreign_key_throws_credential_decrypt_error', () => {
    const Cls = mod.CredentialDecryptError as (new (...a: unknown[]) => Error) | undefined
    const decrypt = mod.decryptStored as ((v: string, k: string) => string) | undefined
    expect(Cls).toBeTypeOf('function')
    expect(decrypt).toBeTypeOf('function')
    let caught: unknown
    try {
      decrypt!(stored, keyB)
    }
    catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Cls!)
    // The message names the cause, never the secret.
    expect(String((caught as Error).message)).not.toContain('s3cret')
  })

  it('own key still decrypts', () => {
    const decrypt = mod.decryptStored as ((v: string, k: string) => string) | undefined
    expect(decrypt).toBeTypeOf('function')
    expect(decrypt!(stored, keyA)).toBe('s3cret')
  })
})
