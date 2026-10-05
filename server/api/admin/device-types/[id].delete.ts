// Controller: delete a device type. Admin-only. Guard: a type in use
// (referenced from devices) → 409 with count (service), not an FK-500.
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { removeTypeGuarded } from '../../../services/device-types'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  await removeTypeGuarded(serverSupabaseServiceRole(event), id)
  setResponseStatus(event, 204)
  return null
})
