// Controller: create a type command (admin). service_role (write deny-all for the client).
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { createCommand } from '../../../repositories/device-commands'

const paramSchema = z.object({ key: z.string().min(1), label: z.string().min(1), type: z.string().optional() })
const credRefSchema = z.object({ set_id: z.string().uuid(), env: z.string().min(1) })

const schema = z.object({
  type_id: z.string().uuid(),
  name: z.string().min(1),
  body: z.string().min(1),
  interpreter: z.enum(['raw', 'bash', 'python', 'node']),
  confirm: z.boolean().default(false),
  timeout_s: z.number().int().positive().max(3600).default(45),
  sort: z.number().int().default(0),
  purpose: z.enum(['action', 'probe']).default('action'),
  stable: z.boolean().default(false),
  // Phase 2
  target: z.enum(['ssh', 'local']).default('ssh'),
  params: z.array(paramSchema).default([]),
  cred_refs: z.array(credRefSchema).default([]),
  min_role: z.enum(['operator', 'admin']).default('operator'),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const input = await readValidatedBody(event, schema.parse)
  return createCommand(serverSupabaseServiceRole(event), input)
})
