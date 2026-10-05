// Nitro plugin: at BFF boot any task_run in 'running' is an orphan (its
// detached promise died with the previous process). Mark it failed/stale
// (ceiling: an in-process queue without a durable store). A 10s buffer avoids
// catching a row inserted by a parallel worker during startup.
import { adminClient } from '../repositories/supabase-admin'
import { reapStale } from '../repositories/task-runs'

export default defineNitroPlugin(() => {
  reapStale(adminClient(), 10_000)
    .then((n) => { if (n) console.warn(`[task_run] reaped ${n} stale running task(s) on boot`) })
    .catch(err => console.error('[task_run] reap failed:', err))
})
