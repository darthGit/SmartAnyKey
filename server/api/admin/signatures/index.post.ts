// Controller: create a signature rule (admin, service_role). The client's rules on
// its own device_types (the engine is domain-agnostic). pattern is validated by signal_type.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { createSignature } from '../../../repositories/discovered'
import { validatePattern } from '../../../services/discovery'

const schema = z.object({
  type_id: z.string().uuid(),
  signal_type: z.enum(['ip_range', 'port', 'banner', 'cert', 'os']),
  pattern: z.string().min(1),
  capture_target: z.enum(['hostname', 'point_number']).nullable().default(null),
  weight: z.number().int().min(1).max(100).default(50),
}).refine(s => validatePattern(s.signal_type, s.pattern), {
  message: 'pattern is not valid for signal_type (ip_range: CIDR or ^regex / port / regex)', path: ['pattern'],
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const input = await readValidatedBody(event, schema.parse)
  return createSignature(serverSupabaseServiceRole(event), input)
})
