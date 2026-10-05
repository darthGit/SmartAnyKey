// RBAC gates of the task routes — a source scan (same pattern as
// tests/points/guard.spec.ts): `requireRole` needs an H3Event, so we check the
// controller's decision instead of bringing up HTTP.
// ADR-013: task authoring = admin; running is gated by the task's own `min_role`;
// the webhook is an external call, authenticated by the trigger token, NOT a user session.
// Written RED: the routes did not exist yet → readFileSync throws → the suite fails.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const gate = (p: string, role: string) =>
  new RegExp(`requireRole\\([\\s\\S]*?['"]${role}['"]`).test(src(p))

const ADMIN_ROUTES = [
  'server/api/admin/tasks/index.post.ts',
  'server/api/admin/tasks/[id].patch.ts',
  'server/api/admin/tasks/[id].delete.ts',
  'server/api/admin/tasks/[id]/rebuild-env.post.ts',
]

const HOOK_ROUTE = 'server/api/tasks/hook/[token].post.ts'
const RUN_ROUTE = 'server/api/tasks/[id]/run.post.ts'

describe('admin task routes gate (ADR-013)', () => {
  it.each(ADMIN_ROUTES)('%s calls requireRole(..., "admin")', (route) => {
    expect(gate(route, 'admin')).toBe(true)
  })
})

describe('run route (AC-16)', () => {
  it('run_route_gates_min_role: running is gated by the task min_role, not a constant', () => {
    const s = src(RUN_ROUTE)
    expect(/min_role/.test(s)).toBe(true)
    expect(/requireRole\(/.test(s)).toBe(true)
  })

  it('NOT hard admin-only — a task with min_role=operator must be runnable by an operator', () => {
    expect(gate(RUN_ROUTE, 'admin')).toBe(false)
  })
})

describe('runs routes (AC-16)', () => {
  it('run list and run detail — behind an authenticated user', () => {
    for (const route of ['server/api/tasks/runs/index.get.ts', 'server/api/tasks/runs/[runId].get.ts'])
      expect(/require(User|Role)\(/.test(src(route)), route).toBe(true)
  })
})

describe('webhook route (AC-13)', () => {
  it('hook is NOT behind requireUser/requireRole — an external call (an external caller has no session)', () => {
    const s = src(HOOK_ROUTE)
    expect(/requireUser\(|requireRole\(/.test(s)).toBe(false)
  })

  // Token/idempotency/limiter mechanisms are scanned where they live: the
  // controller stays thin (3-tier), so demanding the word `createHash` from the
  // route file would encode my file layout in the test, not the contract
  // (a test must not encode your model).
  it('the token is compared by hash — no raw value in the DB', () => {
    const repo = src('server/repositories/tasks.ts')
    expect(/token_hash/.test(repo)).toBe(true)
    expect(/createHash\(['"]sha256/.test(repo)).toBe(true)
  })

  it('the webhook has an idempotency key and a 429 rate limit (AC-13/AC-15)', () => {
    const service = src('server/services/tasks.ts')
    expect(/idempotenc/i.test(service)).toBe(true)
    expect(/429/.test(service)).toBe(true)
    // The route must read the key from the request — otherwise the service check is dead.
    expect(/idempotency-key/i.test(src(HOOK_ROUTE))).toBe(true)
  })
})
