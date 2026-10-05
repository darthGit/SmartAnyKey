// Domain service: zod validation of a device patch at the controller boundary
// (importable without Nitro globals for tests). The protocol set = `actions[]`
// (per-device, direction B). A default_action override must be in actions,
// otherwise the primary click would lead to an action outside the context menu.
import { z } from 'zod'

export const ACTION = z.enum(['vnc', 'rdp', 'ssh', 'web'])

// host = a valid IPv4 (octets 0-255) OR a hostname.
// IP-shaped (4 numeric groups) is validated strictly as IPv4 — otherwise "10.0.515.103"
// would slip through as a hostname (digits in a label are allowed). Validation at
// the boundary.
const IP_SHAPED = /^\d{1,3}(\.\d{1,3}){3}$/
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i
function isValidHost(h: string): boolean {
  if (IP_SHAPED.test(h))
    return h.split('.').every(o => Number(o) <= 255)
  return HOSTNAME.test(h)
}
export const hostSchema = z.string().min(1).refine(isValidHost, { message: 'host must be a valid IPv4 or hostname' })

export const patchSchema = z.object({
  // optional: a meta-only edit does not have to re-send actions.
  actions: z.array(ACTION).min(1).optional(),
  // type_id is a core attribute (fallback default_action, icon, per-type command menu);
  // edited by the same partial patch.
  type_id: z.string().uuid().optional(),
  label: z.string().min(1).optional(),
  host: hostSchema.optional(),
  default_action: ACTION.nullable().optional(),
  // Free-form device data → env of a local task.
  meta: z.record(z.string(), z.unknown()).optional(),
}).refine(d => d.default_action == null || (!!d.actions && d.actions.includes(d.default_action)), {
  message: 'default_action must be one of actions',
  path: ['default_action'],
})

export type DevicePatch = z.infer<typeof patchSchema>

// Manual device add. The same actions/default_action contract as patch,
// + required point_id/type_id/label/host.
// The 3rd sanctioned writer of `devices` (discovery-confirm/import-confirm/manual-add,
// all human-confirmed) — ADR-012 amendment.
export const createSchema = z.object({
  point_id: z.string().uuid(),
  type_id: z.string().uuid(),
  label: z.string().min(1),
  host: hostSchema,
  actions: z.array(ACTION).min(1),
  default_action: ACTION.nullable().optional(),
}).refine(d => d.default_action == null || d.actions.includes(d.default_action), {
  message: 'default_action must be one of actions',
  path: ['default_action'],
})

export type DeviceCreate = z.infer<typeof createSchema>
