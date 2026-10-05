// Domain service: resolving applicable runbooks + zod validation for CRUD.
// applicableRunbooks is a pure function (unit-tested without a DB).
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { listAll, type Runbook, type RunbookInput } from '../repositories/runbooks'

export type { Runbook }

// Applicable to a point:
//   • point-specific (point_id = the point) — always on its own point;
//   • per-type (point_id null, type_id among the point's device types);
//   • global (point_id null + type_id null) — on every point.
// Sorted sort→title.
export function applicableRunbooks(all: Runbook[], deviceTypeIds: string[], pointId: string): Runbook[] {
  const types = new Set(deviceTypeIds)
  return all
    .filter(r => r.point_id === pointId
      || (r.point_id === null && (r.type_id === null || types.has(r.type_id))))
    .sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title))
}

// A point's runbooks: type ids of its devices + all runbooks → pure resolve.
export async function runbooksForPoint(client: SupabaseClient, pointId: string): Promise<Runbook[]> {
  const { data: devs, error } = await client.from('devices').select('type_id').eq('point_id', pointId)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  const typeIds = [...new Set((devs ?? []).map(d => (d as { type_id: string }).type_id).filter(Boolean))]
  return applicableRunbooks(await listAll(client), typeIds, pointId)
}

// Validation at the trust boundary. type_id/point_id are
// nullable — a runbook can be per-type, per-point, or narrowed (both).
export const runbookCreateSchema = z.object({
  type_id: z.string().uuid().nullable().default(null),
  point_id: z.string().uuid().nullable().default(null),
  title: z.string().min(1),
  body: z.string().min(1),
  sort: z.number().int().default(0),
})
export const runbookPatchSchema = runbookCreateSchema.partial()

export type { RunbookInput }
