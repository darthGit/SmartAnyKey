// Service: creating the first admin (ADR-021).
// Orchestrates; touches neither HTTP nor the DB directly (3-tier).
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { claimFirstAdmin, hasAnyAdmin } from '../repositories/setup'

export const firstAdminSchema = z.object({
  email: z.string().email(),
  // GoTrue minimum is 6; we take 12, because this account owns the whole install, and
  // the screen that creates it is open without authentication.
  password: z.string().min(12),
})

export type FirstAdminInput = z.infer<typeof firstAdminSchema>

export class SetupClosedError extends Error {
  constructor() {
    super('This installation already has an admin — the first-run screen is closed')
  }
}

/**
 * The order of steps here is not cosmetic:
 *   1. cheap check (the usual case — a repeat visit to a closed /setup);
 *   2. auth user (the profile references `auth.users` via a foreign key, so
 *      without the user there is nothing to claim);
 *   3. atomic claim — the real gate;
 *   4. lost the race → remove the auth user.
 * Step 4 is mandatory: without it a failed attempt leaves behind a user who
 * can log in but has no profile — and deny-by-default (ADR-013) makes
 * them an invisible ghost nobody will look for.
 */
export async function createFirstAdmin(service: SupabaseClient, input: FirstAdminInput): Promise<string> {
  const { email, password } = firstAdminSchema.parse(input)

  if (await hasAnyAdmin(service))
    throw new SetupClosedError()

  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error || !data.user)
    throw new Error(`createUser: ${error?.message ?? 'empty response'}`)

  const userId = data.user.id
  let claimed = false
  try {
    claimed = await claimFirstAdmin(service, userId)
  }
  finally {
    if (!claimed)
      await service.auth.admin.deleteUser(userId).catch(() => {})
  }

  if (!claimed)
    throw new SetupClosedError()

  return userId
}
