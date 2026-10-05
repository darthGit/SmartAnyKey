// Flat model of the point tree for the virtualizer: a point is always a node;
// devices are emitted only when the point is expanded → only what is visible is
// in the DOM/array. Pure function — unit test tests/board/tree.spec.ts.
import type { Device, Point } from '~/types/board'

export interface PointRow { kind: 'point', point: Point }
export interface DevicesRow { kind: 'devices', pointId: string, devices: Device[] }
export type TreeNode = PointRow | DevicesRow

export function visibleNodes(
  points: Point[],
  devicesByPoint: Map<string, Device[]>,
  expanded: Set<string>,
): TreeNode[] {
  const out: TreeNode[] = []
  for (const p of points) {
    out.push({ kind: 'point', point: p })
    if (expanded.has(p.id))
      out.push({ kind: 'devices', pointId: p.id, devices: devicesByPoint.get(p.id) ?? [] })
  }
  return out
}
