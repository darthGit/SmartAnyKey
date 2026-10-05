// Controller: delete a device. Admin-only (ADR-013).
// The repo cleans orphaned device-level credential_bindings before delete.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { deleteDevice } from '../../../repositories/devices'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  await deleteDevice(serverSupabaseServiceRole(event), id)
  setResponseStatus(event, 204)
  return null
})
