// Domain service: zod boundary of point CRUD.
// Importable without Nitro globals (unit test without a live DB, like services/devices).
//
// `subnet` is a `cidr` column: a malformed string would otherwise reach Postgres and
// come back as a raw 22P02. Validation at the boundary,
// strict octets — the same approach as `isValidHost` in services/devices.ts.
import { z } from 'zod'
// NOTE_MAX has one source on the server (services/notes.ts) — re-exported below,
// not a second constant. Do not move it into `shared/`: tests/board/note-route.spec.ts
// imports services/notes in a plain node-env vitest, where `#shared` does not resolve.
import { NOTE_MAX } from './notes'

export { NOTE_MAX }

const CIDR_SHAPED = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/

function isValidCidr(s: string): boolean {
  const m = CIDR_SHAPED.exec(s)
  if (!m)
    return false
  if (Number(m[5]) > 32)
    return false
  return [m[1]!, m[2]!, m[3]!, m[4]!].every(o => Number(o) <= 255)
}

export const cidrSchema = z.string().refine(isValidCidr, {
  message: 'subnet must be IPv4 CIDR (octets 0-255, prefix /0-/32)',
})

export const createSchema = z.object({
  number: z.number().int().positive(),
  address: z.string().min(1),
  subnet: cidrSchema,
})

// Partial patch: a meta edit does not have to resend all fields.
// `number` is editable on purpose (otherwise a wrong number is unfixable) — the consequences
// for CSV import and capture_target='point_number' are explained by the UI.
export const patchSchema = z.object({
  number: z.number().int().positive().optional(),
  address: z.string().min(1).optional(),
  subnet: cidrSchema.optional(),
  note: z.string().max(NOTE_MAX).optional(),
  // null = remove the rescan schedule (0011); 0 is not a schedule but an error.
  scan_cadence_minutes: z.number().int().positive().nullable().optional(),
})

export type PointCreate = z.infer<typeof createSchema>
export type PointPatch = z.infer<typeof patchSchema>

export interface BlastRadius {
  devices: number
  runbooks: number
  contacts: number
  discoveredHosts: number
  driftEvents: number
  bindings: number
}
