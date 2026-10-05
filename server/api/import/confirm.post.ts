// Controller: apply the CSV import. The only writer of the import path.
// The plan is recomputed on the server (we do not trust the client); apply only valid rows (diff),
// blocked rows are not written.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { applyImport, importContext } from '../../repositories/import'
import { buildImport } from '../../services/import'

const schema = z.object({
  kind: z.enum(['points', 'devices', 'contacts']),
  csv: z.string().min(1),
  mapping: z.record(z.string(), z.string()).optional(),
  valueMap: z.record(z.string(), z.string()).optional(),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const { kind, csv, mapping, valueMap } = await readValidatedBody(event, schema.parse)
  const sr = serverSupabaseServiceRole(event)
  const ctx = await importContext(sr, kind, valueMap)
  const { diff } = buildImport(kind, csv, mapping, ctx)
  const summary = await applyImport(sr, kind, diff)
  setResponseStatus(event, 201)
  return summary
})
