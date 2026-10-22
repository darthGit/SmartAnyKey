// Repository: the single writer of the import path (mirrors the discovery confirm
// route — ADR-012 propose-don't-write). Only this layer touches the DB.
// Scan/preview write nothing; writing happens only here.
import type { SupabaseClient } from '@supabase/supabase-js'
import { createError } from 'h3'
import type { BuildCtx, DiffEntry, Kind } from '../services/import'
import { typeActions } from '../services/device-types'

export interface ImportSummary {
  created: number
  updated: number
  skipped: number
  failed: { key: string, reason: string }[]
}

const empty = (): ImportSummary => ({ created: 0, updated: 0, skipped: 0, failed: [] })
const dbFail = (msg: string): never => {
  throw createError({ statusCode: 502, statusMessage: `DB: ${msg}` })
}

// Existing rows for the reconcile diff. Paginate with .range() — devices
// (2101) > PGRST_DB_MAX_ROWS (1000, self-host); otherwise >1000 are invisible → false
// "new" duplicates (pattern of index.vue::fetchAllDevices).
const PAGE = 1000
async function fetchAll<T>(sr: SupabaseClient, table: string, cols: string): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sr.from(table).select(cols).range(from, from + PAGE - 1)
    if (error) dbFail(error.message)
    const page = (data ?? []) as T[]
    out.push(...page)
    if (page.length < PAGE) break
  }
  return out
}

export async function existingPoints(sr: SupabaseClient): Promise<Record<string, string>[]> {
  const rows = await fetchAll<{ id: string, number: number, address: string | null, subnet: string | null }>(
    sr, 'points', 'id,number,address,subnet')
  return rows.map(r => ({ id: r.id, number: String(r.number), address: r.address ?? '', subnet: r.subnet ?? '' }))
}

export async function existingDevices(sr: SupabaseClient): Promise<Record<string, string>[]> {
  const rows = await fetchAll<{ id: string, host: string, label: string, type_id: string, points: { number: number } | null }>(
    sr, 'devices', 'id,host,label,type_id,points(number)')
  return rows.map(r => ({
    id: r.id, host: r.host, label: r.label, type_id: r.type_id,
    point: r.points ? String(r.points.number) : '',
  }))
}

// Valid type ids — for value-mapping validation (buildImport ctx.typeIds).
export async function knownTypeIds(sr: SupabaseClient): Promise<Set<string>> {
  const rows = await fetchAll<{ id: string }>(sr, 'device_types', 'id')
  return new Set(rows.map(r => r.id))
}

// Context for buildImport — preview and confirm build it identically (both from here).
export async function importContext(sr: SupabaseClient, kind: Kind, valueMap?: Record<string, string>): Promise<BuildCtx> {
  if (kind === 'points')
    return { existing: await existingPoints(sr) }
  if (kind === 'contacts') {
    // A contact needs only existing contacts (reconcile) + point numbers
    // (the only FK dependency). device_types are irrelevant — a contact's `kind`
    // does not resolve into any of our dictionaries.
    const [existing, points] = await Promise.all([existingContacts(sr), existingPoints(sr)])
    return { existing, pointNumbers: new Set(points.map(p => p.number)) }
  }
  const [existing, points, typeIds] = await Promise.all([existingDevices(sr), existingPoints(sr), knownTypeIds(sr)])
  return { existing, valueMap, typeIds, pointNumbers: new Set(points.map(p => p.number)) }
}

export async function existingContacts(sr: SupabaseClient): Promise<Record<string, string>[]> {
  const rows = await fetchAll<{
    id: string, kind: string, value: string, label: string | null, points: { number: number } | null
  }>(sr, 'point_contacts', 'id,kind,value,label,points(number)')
  return rows.map(r => ({
    id: r.id, kind: r.kind, value: r.value, label: r.label ?? '',
    point: r.points ? String(r.points.number) : '',
  }))
}

export async function applyImport(sr: SupabaseClient, kind: Kind, entries: DiffEntry[]): Promise<ImportSummary> {
  if (kind === 'points') return applyPoints(sr, entries)
  if (kind === 'contacts') return applyContacts(sr, entries)
  return applyDevices(sr, entries)
}

async function applyContacts(sr: SupabaseClient, entries: DiffEntry[]): Promise<ImportSummary> {
  const summary = empty()
  summary.skipped = entries.filter(e => e.status === 'skip').length
  const work = entries.filter(e => e.status === 'new' || e.status === 'update')
  if (!work.length) return summary

  const numbers = [...new Set(work.map(e => e.row.point))]
  const { data: pts, error: pErr } = await sr.from('points').select('id,number').in('number', numbers)
  if (pErr) dbFail(pErr.message)
  const pointId = new Map((pts ?? []).map((p: { id: string, number: number }) => [String(p.number), p.id]))

  const toInsert: Record<string, unknown>[] = []
  for (const e of work) {
    const pid = pointId.get(String(e.row.point))
    if (!pid) { summary.failed.push({ key: e.key, reason: `unresolved point ${e.row.point}` }); continue }
    if (e.status === 'update') {
      // The key (point,kind,value) is immutable — only the label is updated.
      const { error } = await sr.from('point_contacts')
        .update({ label: e.row.label || null, updated_at: new Date().toISOString() })
        .eq('id', e.existingId)
      if (error) dbFail(error.message)
      summary.updated++
      continue
    }
    toInsert.push({ point_id: pid, kind: e.row.kind, value: e.row.value, label: e.row.label || null })
  }
  if (toInsert.length) {
    // `value_norm` is generated: not put in the payload. unique(point_id,kind,
    // value_norm) guards against duplicates reconcile did not see (different
    // formatting of the same number in one file) — ignoreDuplicates, so such
    // a row does not fail the whole import.
    const { data, error } = await sr.from('point_contacts')
      .upsert(toInsert, { onConflict: 'point_id,kind,value_norm', ignoreDuplicates: true })
      .select('id')
    if (error) dbFail(error.message)
    summary.created = (data ?? []).length
    summary.skipped += toInsert.length - (data ?? []).length
  }
  return summary
}

async function applyPoints(sr: SupabaseClient, entries: DiffEntry[]): Promise<ImportSummary> {
  const summary = empty()
  summary.skipped = entries.filter(e => e.status === 'skip').length

  const news = entries.filter(e => e.status === 'new')
  if (news.length) {
    const rows = news.map(e => ({
      number: e.row.number, address: e.row.address ?? null, subnet: e.row.subnet ?? null,
    }))
    const { error } = await sr.from('points').insert(rows).select('id')
    if (error) dbFail(error.message)
    summary.created = rows.length
  }

  for (const e of entries.filter(e => e.status === 'update')) {
    const { error } = await sr.from('points')
      .update({ address: e.row.address ?? null, subnet: e.row.subnet ?? null })
      .eq('id', e.existingId)
    if (error) dbFail(error.message)
    summary.updated++
  }
  return summary
}

async function applyDevices(sr: SupabaseClient, entries: DiffEntry[]): Promise<ImportSummary> {
  const summary = empty()
  summary.skipped = entries.filter(e => e.status === 'skip').length
  const work = entries.filter(e => e.status === 'new' || e.status === 'update')
  if (!work.length) return summary

  // type_id is already resolved by value-mapping (row.type_id) — no resolve-by-name.
  // What remains is resolving point.number→id (existing points; validity checked in preview).
  const numbers = [...new Set(work.map(e => e.row.point))]
  const { data: pts, error: pErr } = await sr.from('points').select('id,number').in('number', numbers)
  if (pErr) dbFail(pErr.message)
  const pointId = new Map((pts ?? []).map((p: { id: string, number: number }) => [String(p.number), p.id]))

  // Import has no protocols column → the device gets its type's protocols (otherwise the
  // context menu is empty). Mirrors the discovery confirm route. Only READs device_types.
  const typeIds = [...new Set(work.map(e => e.row.type_id))]
  const { data: types, error: tErr } = await sr.from('device_types').select('id,default_action,actions').in('id', typeIds)
  if (tErr) dbFail(tErr.message)
  const typeSet = new Map((types ?? []).map((t: { id: string, default_action: string, actions: string[] }) => [t.id, typeActions(t)]))

  const toInsert: Record<string, unknown>[] = []
  for (const e of work) {
    const pid = pointId.get(String(e.row.point))
    const tid = e.row.type_id
    if (!pid || !tid) { summary.failed.push({ key: e.key, reason: `unresolved point/type` }); continue }
    if (e.status === 'update') {
      const { error } = await sr.from('devices')
        .update({ type_id: tid, label: e.row.label ?? e.row.host }).eq('id', e.existingId)
      if (error) dbFail(error.message)
      summary.updated++
      continue
    }
    toInsert.push({ point_id: pid, type_id: tid, label: e.row.label ?? e.row.host, host: e.row.host, actions: typeSet.get(tid) ?? [] })
  }
  if (toInsert.length) {
    const { error } = await sr.from('devices').insert(toInsert).select('id')
    if (error) dbFail(error.message)
    summary.created = toInsert.length
  }
  return summary
}
