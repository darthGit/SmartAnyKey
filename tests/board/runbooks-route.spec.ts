// RED.
// Resolving the applicable runbooks is a pure function applicableRunbooks
// (3-tier: the service does not touch the DB; tested without a live database, like services/health).
// Admin gates of the CRUD routes — a source scan (the harness has no HTTP, like probe-route.spec).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applicableRunbooks, type Runbook } from '../../server/services/runbooks'

const R = (over: Partial<Runbook> = {}): Runbook =>
  ({ id: 'r', type_id: null, point_id: null, title: 't', body: 'b', sort: 0, ...over })

function guardsAdmin(file: string): boolean {
  const src = readFileSync(join(process.cwd(), file), 'utf8')
  return /requireRole\([\s\S]*?['"]admin['"]/.test(src)
}

describe('applicableRunbooks (AC-3, AC-6)', () => {
  it('resolves_applicable_for_point: union per-type + point-specific', () => {
    const perType = R({ id: 'a', type_id: 'T1', point_id: null })
    const pointOnly = R({ id: 'b', type_id: null, point_id: 'P1' })
    const out = applicableRunbooks([perType, pointOnly], ['T1'], 'P1')
    expect(out.map(x => x.id).sort()).toEqual(['a', 'b'])
  })

  it('global_both_null_shows_everywhere', () => {
    const global = R({ id: 'g', type_id: null, point_id: null })
    expect(applicableRunbooks([global], [], 'P1').map(x => x.id)).toEqual(['g'])
    expect(applicableRunbooks([global], ['T9'], 'P2').map(x => x.id)).toEqual(['g'])
  })

  it('per_type_scope_and_point_override', () => {
    const perType = R({ id: 'a', type_id: 'T1', point_id: null })
    const otherPoint = R({ id: 'c', type_id: null, point_id: 'P2' })
    const override = R({ id: 'd', type_id: 'T1', point_id: 'P1' })
    // P1 has a device of type T1
    expect(applicableRunbooks([perType, otherPoint, override], ['T1'], 'P1').map(x => x.id).sort())
      .toEqual(['a', 'd'])
    // P3 has no T1 → no per-type; another point's override does not leak
    expect(applicableRunbooks([perType, otherPoint, override], [], 'P3').map(x => x.id))
      .toEqual([])
    // P2 sees only its own point-specific one
    expect(applicableRunbooks([perType, otherPoint, override], [], 'P2').map(x => x.id))
      .toEqual(['c'])
  })
})

describe('admin CRUD gates (AC-4)', () => {
  it('admin_can_crud: the three routes exist and call requireRole(admin)', () => {
    for (const f of [
      'server/api/admin/runbooks/index.post.ts',
      'server/api/admin/runbooks/[id].patch.ts',
      'server/api/admin/runbooks/[id].delete.ts',
    ])
      expect(guardsAdmin(f), f).toBe(true)
  })

  it('non_admin_403: an admin gate (not operator/viewer) on the write routes', () => {
    // requireRole(admin) → any non-admin role gets 403 (ADR-013 deny-by-default)
    const src = readFileSync(join(process.cwd(), 'server/api/admin/runbooks/index.post.ts'), 'utf8')
    expect(/requireRole\([\s\S]*?['"]admin['"]/.test(src)).toBe(true)
  })
})
