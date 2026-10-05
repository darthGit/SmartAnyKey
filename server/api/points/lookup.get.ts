// Controller: reverse lookup
// "contact value → point". This is the seam the future PBX webhook plugs into
// (planned phase 2) — which is why it exists and is tested already
// now, separately from the webhook itself (signature/idempotency — out of scope).
//
// Gate — ≥viewer: the service-role read skips RLS, so a session without a profile
// must not get here (ADR-013). Not admin — an operator on a call needs this the most.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { findPointsByValue } from '../../repositories/point-contacts'
import { phoneMatchTail } from '../../services/point-contacts'

const querySchema = z.object({
  value: z.string().min(1).max(200),
  kind: z.string().min(1).max(30).optional(),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'viewer')
  const { value, kind } = await getValidatedQuery(event, querySchema.parse)
  // Tail — from runtimeConfig.public (the client board search reads the same
  // value). No default in code (deployment-specific): without NUXT_PUBLIC_PHONE_MATCH_TAIL
  // only an exact match works.
  const tail = phoneMatchTail(useRuntimeConfig(event).public.phoneMatchTail as string | undefined)
  return findPointsByValue(serverSupabaseServiceRole(event), value, kind, tail)
})
