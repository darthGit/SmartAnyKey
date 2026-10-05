// `requireUser` proves only a session, and sessions are cheap: anyone who reaches the
// auth service can hold one without a profile. Routes read through the service role,
// which skips RLS, so a route without a role gate hands its data to such a session
// (ADR-013: no profile → no access). Every route either gates a role or says why not.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROLE_GATE = /\b(requireRole|resolveSftpFromEvent|getRoleForUser)\(/

// Session-only on purpose — each with the reason it is safe without a role.
const SESSION_ONLY: Record<string, string> = {
  'server/api/auth/change-password.post.ts': 'acts only on the caller (requireUser().id)',
  'server/api/tasks/runs/index.get.ts': 'filters to the caller\'s own runs unless admin',
  'server/api/tasks/runs/[runId].get.ts': 'own run, or admin',
  'server/api/tasks/runs/[runId]/artifact.get.ts': 'same visibility as the run detail',
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('BFF route guards', () => {
  it('every_requireUser_route_has_a_role_gate_or_a_reason', () => {
    const ungated = [...files('server/api'), ...files('server/routes')]
      .filter(f => /\brequireUser\(/.test(readFileSync(f, 'utf8')))
      .filter(f => !ROLE_GATE.test(readFileSync(f, 'utf8')))
      .filter(f => !(f in SESSION_ONLY))
    expect(ungated).toEqual([])
  })

  it('the_exemption_list_names_only_live_session_only_routes', () => {
    for (const f of Object.keys(SESSION_ONLY)) {
      const src = readFileSync(f, 'utf8')
      expect(ROLE_GATE.test(src), `${f} has a role gate now — drop it from SESSION_ONLY`).toBe(false)
    }
  })
})
