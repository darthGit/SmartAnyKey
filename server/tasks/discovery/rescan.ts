// Nitro scheduled task (ADR-005 L1 / ADR-015): every minute, dispatch a rescan for
// each point whose per-point cadence is due. In-process cron in the BFF — zero new
// containers, scan stays in Node where nmap lives. No H3 event here → event-free
// service-role client (adminClient), same as the stale-run reaper plugin.
import { adminClient } from '../../repositories/supabase-admin'
import { dispatchDueScans } from '../../services/discovery-scan'

export default defineTask({
  meta: { name: 'discovery:rescan', description: 'Rescan points whose schedule is due (drift detection)' },
  async run() {
    const n = await dispatchDueScans(adminClient())
    if (n)
      console.warn(`[discovery:rescan] dispatched ${n} scheduled scan(s)`)
    return { result: n }
  },
})
