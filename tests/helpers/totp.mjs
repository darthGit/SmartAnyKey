// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) on node:crypto — what an authenticator app computes,
// so tests and drives can pass the second factor without a phone.
import { createHmac } from 'node:crypto'

function base32(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of secret.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0')
  return Buffer.from(bits.match(/.{8}/g).map(b => Number.parseInt(b, 2)))
}

export function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', key).update(msg).digest()
  const off = h[h.length - 1] & 0xF
  const n = (h.readUInt32BE(off) & 0x7FFFFFFF) % 10 ** digits
  return String(n).padStart(digits, '0')
}

export function totp(secretBase32, at = Date.now()) {
  return hotp(base32(secretBase32), Math.floor(at / 30_000))
}
