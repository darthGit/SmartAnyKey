// Daily release check (ADR-015 Nitro task); the boot check lives in plugins/update-check.ts.
import { checkLatest } from '../../services/update-check'

export default defineTask({
  meta: { name: 'update:check', description: 'Ask GitHub for the latest release of NUXT_UPDATE_REPO' },
  async run() {
    await checkLatest(useRuntimeConfig().updateRepo)
    return { result: true }
  },
})
