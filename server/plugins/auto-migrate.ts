// Nitro auto-migration plugin.
// Logic lives in `server/utils/auto-migrate.ts`: `defineNitroPlugin` exists only in
// the Nitro runtime, so testable code must live outside the plugin file (the same
// pattern as `server/utils/rbac.ts` ↔ routes).
import { runMigrations, shouldRun } from '../utils/auto-migrate'

export default defineNitroPlugin(() => {
  if (shouldRun())
    runMigrations()
})
