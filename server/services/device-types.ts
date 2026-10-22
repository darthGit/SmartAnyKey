// Domain service: zod validation schemas (controller boundary —
// importable without Nitro globals for tests) + delete guard.
import { createError } from 'h3'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { countDevicesOfType, deleteType } from '../repositories/device-types'

export const ACTION = z.enum(['vnc', 'rdp', 'ssh', 'web'])

const base = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'lowercase, digits, hyphen'),
  name: z.string().min(1),
  icon: z.string().min(1),
  color: z.string().min(1),
  default_action: ACTION,
  // every protocol new devices of this type get; empty = just default_action
  actions: z.array(ACTION).default([]),
  sort: z.number().int().default(0),
})
const defaultAmongActions = (t: { default_action?: string, actions?: string[] }) =>
  !t.default_action || !t.actions?.length || t.actions.includes(t.default_action)
const NOT_AMONG = { message: 'default_action must be one of actions', path: ['actions'] }

export const createSchema = base.refine(defaultAmongActions, NOT_AMONG)
// A patch that sends only one of the two is checked against the stored row by the DB constraint.
export const patchSchema = base.partial().refine(defaultAmongActions, NOT_AMONG)

// The protocols a new device of this type gets (the DB twin: type_effective_actions).
export function typeActions(t: { default_action: string, actions?: string[] | null }): string[] {
  return t.actions?.length ? t.actions : [t.default_action]
}

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
