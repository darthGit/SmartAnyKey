// Who must have passed the second factor. Pure, so the HTTP gate, the WebSocket gate and
// the tests answer the same way; the database policies apply the same rule in SQL.
import type { Role } from './rbac'
import { ROLE_RANK } from './rbac'

export type MfaVerdict = 'ok' | 'mfa_required' | 'mfa_enroll_required'

export interface MfaFacts {
  aal: string | undefined
  enrolled: boolean
  role: Role | null
  requiredRole: Role | null
}

// The role is at or above the policy: 2FA is not optional for this user.
export function roleForced(role: Role | null, requiredRole: Role | null): boolean {
  return !!requiredRole && !!role && ROLE_RANK[role] >= ROLE_RANK[requiredRole]
}

export function mfaGate({ aal, enrolled, role, requiredRole }: MfaFacts): MfaVerdict {
  if (aal === 'aal2')
    return 'ok'
  if (enrolled)
    return 'mfa_required'
  return roleForced(role, requiredRole) ? 'mfa_enroll_required' : 'ok'
}

// `aal` of a token GoTrue has already accepted (getUser), read without a second verification.
export function tokenAal(token: string): string | undefined {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).aal
  }
  catch {
    return undefined
  }
}
