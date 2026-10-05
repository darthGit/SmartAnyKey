// Controller: dry-run preview of a CSV import — computes the plan, writes NOTHING.
// Empty mapping → autoMatch. value-mapping (type→our id) + validation here (blocked).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { importContext } from '../../repositories/import'
import { buildImport } from '../../services/import'

const schema = z.object({
  kind: z.enum(['points', 'devices', 'contacts']),
  csv: z.string().min(1),
  mapping: z.record(z.string(), z.string()).optional(),
  valueMap: z.record(z.string(), z.string()).optional(), // CSV type value → our device_type.id
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const { kind, csv, mapping, valueMap } = await readValidatedBody(event, schema.parse)
  const sr = serverSupabaseServiceRole(event)
  const ctx = await importContext(sr, kind, valueMap)
  return buildImport(kind, csv, mapping, ctx)
})
