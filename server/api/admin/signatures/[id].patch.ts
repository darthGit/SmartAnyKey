// Controller: edit a signature rule (admin). Partial update.
// If pattern changes, signal_type must be in the body (context for validation).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { updateSignature } from '../../../repositories/discovered'
import { validatePattern } from '../../../services/discovery'

const schema = z.object({
  type_id: z.string().uuid().optional(),
  signal_type: z.enum(['ip_range', 'port', 'banner', 'cert', 'os']).optional(),
  pattern: z.string().min(1).optional(),
  capture_target: z.enum(['hostname', 'point_number']).nullable().optional(),
  weight: z.number().int().min(1).max(100).optional(),
}).refine(s => s.pattern === undefined || (s.signal_type !== undefined && validatePattern(s.signal_type, s.pattern)), {
  message: 'changing pattern requires signal_type; pattern must be valid for it', path: ['pattern'],
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  const patch = await readValidatedBody(event, schema.parse)
  return updateSignature(serverSupabaseServiceRole(event), id, patch)
})
