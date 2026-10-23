// Who must have passed the second factor. The gate is one pure function so the HTTP path,
// the WebSocket path and the tests all answer the same way.
import { describe, expect, it } from 'vitest'
import { mfaGate } from '../../server/utils/mfa'
import { hotp } from '../helpers/totp'

describe('mfaGate', () => {
  it('a user with a verified factor must be at aal2', () => {
    expect(mfaGate({ aal: 'aal1', enrolled: true, role: 'viewer', requiredRole: null })).toBe('mfa_required')
    expect(mfaGate({ aal: 'aal2', enrolled: true, role: 'viewer', requiredRole: null })).toBe('ok')
  })

  it('a role at or above the policy without a factor must enroll first', () => {
    expect(mfaGate({ aal: 'aal1', enrolled: false, role: 'admin', requiredRole: 'admin' })).toBe('mfa_enroll_required')
    expect(mfaGate({ aal: 'aal1', enrolled: false, role: 'admin', requiredRole: 'operator' })).toBe('mfa_enroll_required')
    expect(mfaGate({ aal: 'aal1', enrolled: false, role: 'operator', requiredRole: 'viewer' })).toBe('mfa_enroll_required')
  })

  it('a role below the policy, or no policy, works with a password alone', () => {
    expect(mfaGate({ aal: 'aal1', enrolled: false, role: 'operator', requiredRole: 'admin' })).toBe('ok')
    expect(mfaGate({ aal: 'aal1', enrolled: false, role: 'admin', requiredRole: null })).toBe('ok')
  })

  it('no profile is not a reason to skip the policy', () => {
    expect(mfaGate({ aal: 'aal1', enrolled: true, role: null, requiredRole: null })).toBe('mfa_required')
  })
})

describe('test TOTP helper', () => {
  it('matches the RFC 6238 SHA-1 vector (T=59 s)', () => {
    expect(hotp(Buffer.from('12345678901234567890'), 1, 8)).toBe('94287082')
  })
})
