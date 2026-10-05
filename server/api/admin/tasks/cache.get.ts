// Controller ("the environment cache eats the disk"): space used per runner.
// Admin-only — the list of environment keys is a list of deps.
//
// Several runtimes can live on ONE image (current state, amended), so we
// aggregate by URL, not by runtime: otherwise the same cache would be
// counted twice.
import { runnersFromConfig } from '../../../utils/task-runners'

interface CacheStats {
  bytes: number
  limitBytes: number
  envs: { key: string, bytes: number, usedAt: number, ready: boolean }[]
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const { registry, secret } = runnersFromConfig(event)

  const byUrl = new Map<string, string[]>()
  for (const [runtime, url] of Object.entries(registry)) {
    const cacheUrl = new URL(url)
    cacheUrl.pathname = '/cache'
    const key = cacheUrl.toString()
    byUrl.set(key, [...(byUrl.get(key) ?? []), runtime])
  }

  const runners = await Promise.all([...byUrl].map(async ([url, runtimes]) => {
    try {
      const stats = await $fetch<CacheStats>(url, {
        headers: { 'x-executor-secret': secret },
        timeout: 5_000,
      })
      return { runtimes, ...stats, error: null }
    }
    catch (ex: unknown) {
      // A runner may not be up — that is a state the panel must show,
      // not a 500 for the whole page.
      return { runtimes, bytes: 0, limitBytes: 0, envs: [], error: (ex as Error).message }
    }
  }))

  return { runners }
})
