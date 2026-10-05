// Domain service: zod validation schemas (controller boundary —
// importable without Nitro globals for tests) + delete guard.
import { createError } from 'h3'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { countDevicesOfType, deleteType } from '../repositories/device-types'

export const ACTION = z.enum(['vnc', 'rdp', 'ssh', 'web'])

export const createSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'lowercase, digits, hyphen'),
  name: z.string().min(1),
  icon: z.string().min(1),
  color: z.string().min(1),
  default_action: ACTION,
  sort: z.number().int().default(0),
})
export const patchSchema = createSchema.partial()

// Delete guard: a type referenced by devices is not deleted —
// a human 409 with the count, not an FK 500. Reassigning devices is out of scope (v1 = block).
export async function removeTypeGuarded(sr: SupabaseClient, id: string): Promise<void> {
  const count = await countDevicesOfType(sr, id)
  if (count > 0) {
    throw createError({
      statusCode: 409,
      statusMessage: `type in use by ${count} device(s)`,
      data: { count },
    })
  }
  await deleteType(sr, id)
}
