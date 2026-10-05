// Controller: confirm a New host into a point's device (type + optional cred binding).
// The only path by which a scan result becomes a row in devices — the scan itself does not write.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { getPoint } from '../../../repositories/discovered'
import { confirmDevice } from '../../../services/discovery-scan'

const ACTION = z.enum(['vnc', 'rdp', 'ssh', 'web'])
const schema = z.object({
  ip: z.string().min(1),
  typeId: z.string().uuid(),
  label: z.string().min(1),
  defaultAction: ACTION.nullable().optional(),
  actions: z.array(ACTION).optional(),
  bindings: z.array(z.object({
    action: z.enum(['vnc', 'rdp', 'ssh']),
    credSetId: z.string().uuid(),
  })).optional(),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const pointId = z.string().uuid().parse(getRouterParam(event, 'pointId'))
  const body = await readValidatedBody(event, schema.parse)
  const sr = serverSupabaseServiceRole(event)

  const point = await getPoint(sr, pointId)
  if (!point)
    throw createError({ statusCode: 404, statusMessage: 'Point not found' })

  const device = await confirmDevice(sr, pointId, body)
  setResponseStatus(event, 201)
  return device
})
