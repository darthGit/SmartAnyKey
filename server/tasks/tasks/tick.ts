// Nitro scheduled task (ADR-015): every minute we look at due cron triggers of tasks and
// run them serially. In-process cron in the BFF — zero new containers.
// No H3 event → an event-free service-role client (like discovery:rescan).
import { adminClient } from '../../repositories/supabase-admin'
import { dispatchDueTriggers } from '../../services/task-scheduler'
import { credKey, runnersFromConfig } from '../../utils/task-runners'

export default defineTask({
  meta: { name: 'tasks:tick', description: 'Run scheduled tasks whose cron trigger is due' },
  async run() {
    // ⚠ There used to be an early exit here: "empty runtime registry → nothing to
    // run". It also excluded built-in tasks (ADR-018 amendment #4), which by construction
    // need no runner: the BFF itself runs the backup, because `pg_dump` exists only in
    // the `app` image. And `NUXT_TASK_RUNNERS` is empty on a stock install —
    // so the backup NEVER ran, despite the toggle being on and a live trigger
    // (measured in a clean room 2026-09-18: 0 rows in `task_run`, an empty
    // `/backups`). The decision moved into `dispatchDueTriggers`, where the task is already
    // read and it is visible whether it is built-in.
    const runners = runnersFromConfig()

    const n = await dispatchDueTriggers(adminClient(), {
      now: new Date(),
      keyHex: credKey(),
      runners,
    })
    if (n)
      console.warn(`[tasks:tick] dispatched ${n} scheduled task run(s)`)
    return { result: n }
  },
})
