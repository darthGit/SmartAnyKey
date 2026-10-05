// At-rest credential encryption (ADR-009). AES-256-GCM, app-level:
// key — 32 bytes (64 hex) from env CRED_ENCRYPTION_KEY, NEVER in the DB.
// bytea format: iv(12) | authTag(16) | ciphertext. Decryption only in BFF RAM.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_LEN = 12
const TAG_LEN = 16

function keyBuf(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex')
  if (key.length !== 32)
    throw new Error('CRED_ENCRYPTION_KEY must be 64 hex characters (256 bits)')
  return key
}

export function encryptSecret(plain: string, keyHex: string): Buffer {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', keyBuf(keyHex), iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct])
}

export function decryptSecret(buf: Buffer, keyHex: string): string {
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', keyBuf(keyHex), iv)
  decipher.setAuthTag(tag)
  // final() throws if the authTag does not match (tampering / foreign key)
  return decipher.update(ct, undefined, 'utf8') + decipher.final('utf8')
}
