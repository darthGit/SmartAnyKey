// Domain service: a point's contact.
// One row = one contact (phone / email / anything) — not "a person with
// channels". `kind` is free: the list of kinds is client data (no domain defaults).
//
// normalizeValue/matchesValue are pure, and they are exactly what the PBX webhook
// handler will later call without any changes (a seam).
import { z } from 'zod'

export const CONTACT_VALUE_MAX = 200
export const CONTACT_KIND_MAX = 30
export const CONTACT_LABEL_MAX = 100

// Kinds for which the platform has a link scheme — that is why the code knows them.
// This is NOT the list of allowed kinds (that belongs to the client).
export const KIND_PHONE = 'phone'
export const KIND_EMAIL = 'email'

// Mirrors the generated column `value_norm` (0017_point_contacts.sql).
// A mismatch between this function and the SQL would break lookup — change only together.
export function normalizeValue(kind: string, raw: string): string {
  return kind === KIND_PHONE
    ? raw.replace(/\D/g, '')
    : raw.trim().toLowerCase()
}

// Match of two already normalized values.
//
// `tail` (PHONE_MATCH_TAIL from env) — how many trailing digits are enough
// for a phone match. There is no default in code (deployment-specific): without env only
// exact equality works. A pure suffix match does not work — `380671234567` does not
// end with `0671234567` because of the leading trunk zero, and that is exactly the country
// convention that must not be hardcoded.
export function matchesValue(a: string, b: string, kind: string, tail?: number): boolean {
  if (a === b)
    return true
  if (kind !== KIND_PHONE || !tail)
    return false
  if (a.length < tail || b.length < tail)
    return false
  return a.slice(-tail) === b.slice(-tail)
}

// Tail from runtimeConfig.public.phoneMatchTail — one source for server and
// client (the server lookup and the client board search must match the same
// numbers). A malformed/empty value → undefined = exact match only.
export function phoneMatchTail(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === '')
    return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

export const contactCreateSchema = z.object({
  kind: z.string().min(1).max(CONTACT_KIND_MAX),
  value: z.string().min(1).max(CONTACT_VALUE_MAX),
  label: z.string().max(CONTACT_LABEL_MAX).optional(),
  sort: z.number().int().optional(),
})

export const contactPatchSchema = z.object({
  kind: z.string().min(1).max(CONTACT_KIND_MAX).optional(),
  value: z.string().min(1).max(CONTACT_VALUE_MAX).optional(),
  label: z.string().max(CONTACT_LABEL_MAX).nullable().optional(),
  sort: z.number().int().optional(),
})

export type ContactCreate = z.infer<typeof contactCreateSchema>
export type ContactPatch = z.infer<typeof contactPatchSchema>

export interface PointHit {
  point_id: string
  number: number
  address: string
  label: string | null
}
