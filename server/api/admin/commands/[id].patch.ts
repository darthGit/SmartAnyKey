// Controller: edit a type's command (admin). Partial update.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { updateCommand } from '../../../repositories/device-commands'

const paramSchema = z.object({ key: z.string().min(1), label: z.string().min(1), type: z.string().optional() })
const credRefSchema = z.object({ set_id: z.string().uuid(), env: z.string().min(1) })

const schema = z.object({
  name: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  interpreter: z.enum(['raw', 'bash', 'python', 'node']).optional(),
  confirm: z.boolean().optional(),
  timeout_s: z.number().int().positive().max(3600).optional(),
  sort: z.number().int().optional(),
  purpose: z.enum(['action', 'probe']).optional(),
  stable: z.boolean().optional(),
  // Phase 2
  target: z.enum(['ssh', 'local']).optional(),
  params: z.array(paramSchema).optional(),
  cred_refs: z.array(credRefSchema).optional(),
  min_role: z.enum(['operator', 'admin']).optional(),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  const patch = await readValidatedBody(event, schema.parse)
  return updateCommand(serverSupabaseServiceRole(event), id, patch)
})
