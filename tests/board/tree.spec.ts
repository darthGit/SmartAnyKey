// RED: flat tree helper — a point is always a node; devices only when the
// point is expanded (a collapsed one does NOT emit a device node → only the visible is in the DOM).
// Module app/utils/tree does not exist yet → fails. Pure logic, node env.
import { describe, expect, it } from 'vitest'
import { visibleNodes } from '../../app/utils/tree'

const points = [
  { id: 'p1', number: 1, address: 'a', subnet: 's1' },
  { id: 'p2', number: 2, address: 'b', subnet: 's2' },
]
const devicesByPoint = new Map<string, { id: string }[]>([
  ['p1', [{ id: 'd1' }, { id: 'd2' }]],
  ['p2', [{ id: 'd3' }]],
])

describe('visibleNodes', () => {
  it('collapsed_point_emits_no_device_node', () => {
    const nodes = visibleNodes(points, devicesByPoint, new Set())
    expect(nodes).toHaveLength(2)
    expect(nodes.every(n => n.kind === 'point')).toBe(true)
  })

  it('expand_collapse_toggles_device_node', () => {
    const nodes = visibleNodes(points, devicesByPoint, new Set(['p1']))
    // p1 → point + devices; p2 (collapsed) → point only
    expect(nodes).toHaveLength(3)
    expect(nodes[0]!.kind).toBe('point')
    expect(nodes[1]!.kind).toBe('devices')
    expect(nodes[1]).toMatchObject({ pointId: 'p1' })
    expect((nodes[1] as { devices: unknown[] }).devices).toHaveLength(2)
    expect(nodes.filter(n => n.kind === 'devices')).toHaveLength(1)
  })
})
