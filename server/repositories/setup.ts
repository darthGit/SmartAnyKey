// Repository: initial setup state (ADR-021).
// The only layer that touches the DB.
import type { SupabaseClient } from '@supabase/supabase-js'

/** Whether the installation has at least one admin. This is the whole `/setup` gate. */
export async function hasAnyAdmin(service: SupabaseClient): Promise<boolean> {
  const { count, error } = await service
    .from('profiles')
    .select('user_id', { count: 'exact', head: true })
    .eq('role', 'admin')
  if (error)
    throw new Error(`profiles count: ${error.message}`)
  return (count ?? 0) > 0
}

/**
 * Claim the first-admin slot. The conditional write lives in the DB
 * (`supabase/migrations/0019_first_admin_claim.sql`): `insert … where not
 * exists` under `pg_advisory_xact_lock`, because `not exists` alone under
 * READ COMMITTED cannot tell two concurrent calls apart.
 * @returns true — claimed; false — someone got there first.
 */
export async function claimFirstAdmin(service: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await service.rpc('claim_first_admin', { p_user_id: userId })
  if (error)
    throw new Error(`claim_first_admin: ${error.message}`)
  return Number(data) === 1
}
