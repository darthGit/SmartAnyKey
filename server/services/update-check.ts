// Release check: a daily request for the latest GitHub release of `updateRepo`. State lives in
// the process (a restart re-checks at boot), so nothing is stored. The browser cannot ask
// GitHub itself — CSP connect-src allows only this origin and Supabase.
const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/

// Only exact release tags compare: `dev`, `unknown` or a `git describe` build is never "outdated".
export function isNewer(current: string, latest: string): boolean {
  const a = SEMVER.exec(current)
  const b = SEMVER.exec(latest)
  if (!a || !b)
    return false
  for (let i = 1; i <= 3; i++)
    if (Number(a[i]) !== Number(b[i]))
      return Number(b[i]) > Number(a[i])
  return false
}

let state: { latest: string | null, url: string | null } = { latest: null, url: null }
export const updateState = () => state

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export async function checkLatest(repo: string, f: Fetch = fetch): Promise<void> {
  if (!repo)
    return
  try {
    const res = await f(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok)
      throw new Error(`HTTP ${res.status}`)
    const body = await res.json() as { tag_name?: string, html_url?: string }
    if (body.tag_name)
      state = { latest: body.tag_name, url: body.html_url ?? null }
  }
  catch (e) {
    console.warn(`[update-check] ${repo}: ${(e as Error).message}`)
  }
}
