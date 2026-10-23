// Repository: what the second-factor gate needs to know about a user, in one query.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Role } from '../utils/rbac'
import type { MfaVerdict } from '../utils/mfa'
import { mfaGate } from '../utils/mfa'

export async function getMfaState(client: SupabaseClient, userId: string) {
  const { data, error } = await client.rpc('mfa_state', { p_user: userId })
  if (error)
    throw new Error(`mfa_state: ${error.message}`)
  const row = (data as { enrolled: boolean, role: Role | null, required_role: Role | null }[])[0]
  return { enrolled: !!row?.enrolled, role: row?.role ?? null, requiredRole: row?.required_role ?? null }
}

export async function mfaVerdict(client: SupabaseClient, userId: string, aal: string | undefined): Promise<MfaVerdict> {
  return mfaGate({ aal, ...(await getMfaState(client, userId)) })
}
