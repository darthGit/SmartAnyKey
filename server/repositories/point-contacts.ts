// Repository: point contacts.
// `point_contacts` under RLS has only a select policy (0017) → writes go through
// the service-role client from the BFF (ADR-013).
import { createError } from 'h3'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContactCreate, ContactPatch, PointHit } from '../services/point-contacts'
import { normalizeValue } from '../services/point-contacts'

// `value_norm` is a generated column: it must NOT go into the payload (PostgREST
// rejects the write), so read and write columns differ.
const COLS = 'id,point_id,kind,value,label,sort'

const dbFail = (msg: string) => {
  throw createError({ statusCode: 502, statusMessage: `DB: ${msg}` })
}
const notFound = () => {
  throw createError({ statusCode: 404, statusMessage: 'contact not found on this point' })
}

function mapWriteError(error: { code?: string, message: string }): never {
  // The same number/email already exists on this point (unique point_id,kind,value_norm) —
  // a user conflict, not a 502.
  if (error.code === '23505')
    throw createError({ statusCode: 409, statusMessage: 'contact already exists on this point' })
  if (error.code === '23503')
    throw createError({ statusCode: 409, statusMessage: `FK: ${error.message}` })
  dbFail(error.message)
}

export async function listByPoint(sr: SupabaseClient, pointId: string) {
  const { data, error } = await sr.from('point_contacts')
    .select(COLS).eq('point_id', pointId).order('sort').order('id')
  if (error)
    dbFail(error.message)
  return data ?? []
}

export async function createContact(sr: SupabaseClient, pointId: string, input: ContactCreate) {
  const { data, error } = await sr.from('point_contacts')
    .insert({ ...input, point_id: pointId }).select(COLS).single()
  if (error)
    mapWriteError(error)
  return data!
}

// Scoped by both point_id and id: someone else's contact cannot be edited via a
// substituted pointId — 404, not a silent edit of a neighbouring point.
export async function updateContact(sr: SupabaseClient, pointId: string, contactId: string, patch: ContactPatch) {
  const { data, error } = await sr.from('point_contacts')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('point_id', pointId).eq('id', contactId).select(COLS)
  if (error)
    mapWriteError(error)
  if (!data?.length)
    notFound()
  return data![0]!
}

export async function deleteContact(sr: SupabaseClient, pointId: string, contactId: string): Promise<void> {
  const { data, error } = await sr.from('point_contacts')
    .delete().eq('point_id', pointId).eq('id', contactId).select('id')
  if (error)
    mapWriteError(error)
  if (!data?.length)
    notFound()
}

interface HitRow {
  label: string | null
  point_id: string
  points: { number: number, address: string } | null
}

const toHits = (rows: HitRow[]): PointHit[] => rows
  .filter(r => r.points)
  .map(r => ({
    point_id: r.point_id,
    number: r.points!.number,
    address: r.points!.address,
    label: r.label,
  }))

// Reverse lookup "value → point" — the seam the PBX webhook plugs into.
//
// Two queries instead of one `.or()`: `.or()` is fragile (it cannot handle
// embedded columns, a comma/parenthesis in a term breaks it), and at a scale
// of ~1-2k contacts a second round-trip costs nothing.
// ponytail: tail match = `like '%<tail>'` (a scan on an indexed column);
// at tens of thousands of contacts → a separate tail column with its own index.
export async function findPointsByValue(
  sr: SupabaseClient,
  rawValue: string,
  kind?: string,
  tail?: number,
): Promise<PointHit[]> {
  const digits = normalizeValue('phone', rawValue)
  const generic = normalizeValue('other', rawValue)
  // Kind not given → try both normalisations (phone and generic).
  const exact = [...new Set([digits, generic].filter(Boolean))]
  const select = `label,point_id,points!inner(number,address)`

  const byId = new Map<string, PointHit>()
  const push = (rows: HitRow[]) => {
    for (const hit of toHits(rows))
      byId.set(hit.point_id, hit)
  }

  if (exact.length) {
    let q = sr.from('point_contacts').select(select).in('value_norm', exact)
    if (kind)
      q = q.eq('kind', kind)
    const { data, error } = await q
    if (error)
      dbFail(error.message)
    push((data ?? []) as unknown as HitRow[])
  }

  if (tail && digits.length >= tail) {
    let q = sr.from('point_contacts').select(select).like('value_norm', `%${digits.slice(-tail)}`)
    // A tail only makes sense for phones — otherwise "an email ending in
    // the same 9 characters" would produce an accidental match.
    q = q.eq('kind', kind ?? 'phone')
    const { data, error } = await q
    if (error)
      dbFail(error.message)
    push((data ?? []) as unknown as HitRow[])
  }

  return [...byId.values()]
}
