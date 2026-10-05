// Controller: CSV template per kind (headers + sample row) for download.
import { z } from 'zod'
import { csvTemplate } from '../../services/import'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const kind = z.enum(['points', 'devices', 'contacts']).parse(getQuery(event).kind)
  setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="import-${kind}-template.csv"`)
  return csvTemplate(kind)
})
