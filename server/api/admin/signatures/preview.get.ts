// Controller: preview of a type's rules — how many recently scanned hosts would be
// proposed as this type (analysis of "will it fire / is it too broad").
import { z } from 'zod'
import { serverSupabaseServiceRole } from '#supabase/server'
import { previewType } from '../../../services/discovery-scan'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const typeId = z.string().uuid().parse(getQuery(event).typeId)
  return previewType(serverSupabaseServiceRole(event), typeId)
})
