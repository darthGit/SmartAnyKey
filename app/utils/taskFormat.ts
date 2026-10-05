// Pure helpers of the task panel.
// These functions are what gets unit-tested: `/admin/tasks` and `TaskRunDetail` fetch
// their own data through the BFF, so the decisions "when is the next run / how long /
// how much space" live here, not in the component.
//
// Numbers and units are literals, not i18n: "2m 05s" and "1.4 GB" read the same in
// both languages, and `t()` here would only add a chance to diverge (the same choice
// as in `CommandResultModal` for duration).

export interface TriggerLike {
  kind: 'cron' | 'webhook'
  next_run_at?: string | null
  enabled?: boolean
}

export interface RunLike {
  status?: string
  started_at?: string | null
  finished_at?: string | null
  result?: { durationMs?: number, late?: boolean, lateByMs?: number, attempt?: number } | null
}

/**
 * The nearest run among enabled cron triggers. `inMs < 0` = the slot is
 * overdue (BFF downtime) — the panel must show it, otherwise "the backup did not
 * run for three days and nobody noticed".
 */
export function nextCronRun(
  triggers: TriggerLike[] | null | undefined,
  now: Date = new Date(),
): { at: string, inMs: number } | null {
  const times = (triggers ?? [])
    .filter(t => t.kind === 'cron' && t.enabled !== false && t.next_run_at)
    .map(t => t.next_run_at as string)
    .sort()
  const at = times[0]
  if (!at)
    return null
  return { at, inMs: new Date(at).getTime() - now.getTime() }
}

/** `1.4s` / `2m 05s` / `1h 02m`. Negative/NaN → empty (nothing to show). */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0)
    return ''
  if (ms < 60_000)
    return `${+(ms / 1000).toFixed(1)}s`
  const totalMin = Math.floor(ms / 60_000)
  const sec = Math.floor((ms % 60_000) / 1000)
  if (totalMin < 60)
    return `${totalMin}m ${String(sec).padStart(2, '0')}s`
  return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, '0')}m`
}

/**
 * Run duration. An unfinished run is counted up to `now`, so the panel timer ticks
 * (`result.durationMs` appears only at the end). The runner-measured duration wins:
 * it excludes the round-trip to the DB.
 */
export function runDurationMs(run: RunLike | null | undefined, now: Date = new Date()): number | null {
  if (!run)
    return null
  const measured = run.result?.durationMs
  if (typeof measured === 'number' && measured > 0)
    return measured
  if (!run.started_at)
    return null
  const end = run.finished_at ? new Date(run.finished_at).getTime() : now.getTime()
  return Math.max(0, end - new Date(run.started_at).getTime())
}

/** `0 B` / `912 kB` / `1.4 GB` — decimal units (as `du -h --si` shows them). */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0)
    return ''
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000
    i++
  }
  // Bytes are whole, the rest one decimal (912.3 kB reads better than 912.34 kB).
  return i === 0 ? `${n} B` : `${+n.toFixed(1)} ${units[i]}`
}

/** Status badge color (Nuxt UI). `skipped` is not an error, hence neutral. */
export function runStatusColor(status: string | null | undefined): 'success' | 'error' | 'info' | 'neutral' {
  switch (status) {
    case 'done': return 'success'
    case 'failed': return 'error'
    case 'running': return 'info'
    default: return 'neutral' // skipped / unknown
  }
}
