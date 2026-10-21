// First release check right after boot, so a fresh container knows before the daily run.
// Not awaited: no network must not delay startup.
import { checkLatest } from '../services/update-check'

export default defineNitroPlugin(() => {
  checkLatest(useRuntimeConfig().updateRepo)
})
