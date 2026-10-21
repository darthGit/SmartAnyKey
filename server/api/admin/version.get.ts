// Controller: the running version and the latest release, for the admin menu badge (ADR-013).
import { isNewer, updateState } from '../../services/update-check'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const current = useRuntimeConfig().appVersion
  const { latest, url } = updateState()
  return { current, latest, url, newer: !!latest && isNewer(current, latest) }
})
