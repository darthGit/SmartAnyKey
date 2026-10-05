// RED: POST /api/points/[pointId]/probe requires the operator role. The gate is
// checked by a source scan (like tests/unit/rbac.spec.ts enforcement wiring) —
// no-HTTP harness; a missed guard = a hole in the source.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROUTE = 'server/api/points/[pointId]/probe.post.ts'

function guardsAt(file: string, level: string): boolean {
  const src = readFileSync(join(process.cwd(), file), 'utf8')
  return new RegExp(`requireRole\\([\\s\\S]*?['"]${level}['"]`).test(src)
}

describe('probe route gate (AC-6)', () => {
  it('requires_operator_role: the probe route calls requireRole(..., "operator")', () => {
    expect(guardsAt(ROUTE, 'operator')).toBe(true)
  })
})
