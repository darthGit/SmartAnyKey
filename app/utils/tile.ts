// Recursive tile tree of the session mosaic.
// Pure logic, no Vue/Nuxt — testable in a node env. The UI (SessionTile/
// SessionGrid) renders this tree and calls these functions; the session engine
// (xterm/ws) is not here (ADR-007).

export type Leaf = { type: 'leaf'; paneId: number }
export interface Split {
  type: 'split'
  dir: 'row' | 'col' // row = columns (splits along X), col = rows (along Y)
  children: TileNode[]
  sizes: number[] // fractions per split level, sum = 1
}
export type TileNode = Leaf | Split
export type Edge = 'top' | 'right' | 'bottom' | 'left'
export type DropZone = Edge | 'center'

export const MIN_FRACTION = 0.12

const leaf = (paneId: number): Leaf => ({ type: 'leaf', paneId })

// Rescales fractions so the sum = 1 (after removing/adding a child).
function renormalize(sizes: number[]): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0)
  return sum === 0 ? sizes.map(() => 1 / sizes.length) : sizes.map(s => s / sum)
}

// Insert a new pane. Empty → root leaf. With target+edge → split the target
// pane in the edge direction. Without target → split the root (append).
export function insertLeaf(
  tree: TileNode | null,
  paneId: number,
  target?: { paneId: number; edge: Edge },
): TileNode {
  if (tree === null)
    return leaf(paneId)
  if (!target)
    return { type: 'split', dir: 'row', children: [tree, leaf(paneId)], sizes: [0.5, 0.5] }

  const splitAtTarget = (node: TileNode): TileNode => {
    if (node.type === 'leaf') {
      if (node.paneId !== target.paneId)
        return node
      const dir = target.edge === 'left' || target.edge === 'right' ? 'row' : 'col'
      const fresh = leaf(paneId)
      const children = target.edge === 'right' || target.edge === 'bottom'
        ? [node, fresh]
        : [fresh, node]
      return { type: 'split', dir, children, sizes: [0.5, 0.5] }
    }
    return { ...node, children: node.children.map(splitAtTarget) }
  }
  return splitAtTarget(tree)
}

// Remove a pane. A split left with one child collapses into that child.
// null = the last leaf was removed (the tree is empty).
export function removeLeaf(tree: TileNode, paneId: number): TileNode | null {
  if (tree.type === 'leaf')
    return tree.paneId === paneId ? null : tree

  const kept: TileNode[] = []
  const keptSizes: number[] = []
  tree.children.forEach((child, i) => {
    const r = removeLeaf(child, paneId)
    if (r !== null) {
      kept.push(r)
      keptSizes.push(tree.sizes[i]!)
    }
  })
  if (kept.length === 0)
    return null
  if (kept.length === 1)
    return kept[0]! // collapse
  return { ...tree, children: kept, sizes: renormalize(keptSizes) }
}

function updateAtPath(
  tree: TileNode,
  path: number[],
  fn: (node: TileNode) => TileNode,
): TileNode {
  if (path.length === 0)
    return fn(tree)
  if (tree.type === 'leaf')
    return tree
  const [i, ...rest] = path
  return {
    ...tree,
    children: tree.children.map((c, idx) => (idx === i ? updateAtPath(c, rest, fn) : c)),
  }
}

// Shift the fraction at `boundary` (between children[i] and [i+1]) of the split node
// at `path` ([] = root). Clamp: both neighbouring fractions ≥ MIN_FRACTION.
export function resizeSplit(
  tree: TileNode,
  path: number[],
  boundary: number,
  deltaFrac: number,
  clampMin: number = MIN_FRACTION,
): TileNode {
  return updateAtPath(tree, path, (node) => {
    if (node.type !== 'split')
      return node
    const sizes = [...node.sizes]
    const a = sizes[boundary]!
    const b = sizes[boundary + 1]!
    let d = deltaFrac
    d = Math.min(d, b - clampMin) // b - d ≥ min
    d = Math.max(d, -(a - clampMin)) // a + d ≥ min
    sizes[boundary] = a + d
    sizes[boundary + 1] = b - d
    return { ...node, sizes }
  })
}

// Move a pane. 'center' → swap the two panes; edge → docking:
// remove `from` (with collapse) and insert it at the matching edge of `to`.
export function moveLeaf(
  tree: TileNode,
  fromPaneId: number,
  toPaneId: number,
  zone: DropZone,
): TileNode {
  if (fromPaneId === toPaneId)
    return tree
  if (zone === 'center') {
    const swap = (node: TileNode): TileNode => {
      if (node.type === 'leaf') {
        if (node.paneId === fromPaneId)
          return leaf(toPaneId)
        if (node.paneId === toPaneId)
          return leaf(fromPaneId)
        return node
      }
      return { ...node, children: node.children.map(swap) }
    }
    return swap(tree)
  }
  const without = removeLeaf(tree, fromPaneId)
  if (without === null)
    return tree
  return insertLeaf(without, fromPaneId, { paneId: toPaneId, edge: zone })
}

// ── Flat geometry (for rendering without remounting sessions) ──
// Computes absolute rects (in %) of every leaf and every splitter. The UI
// renders panes as a flat list keyed by pane.id (stable DOM → the session
// survives any move), not recursively over the tree.
export interface PaneRect { paneId: number, x: number, y: number, w: number, h: number }
export interface SplitterRect {
  path: number[] // path to the split node in the tree
  boundary: number // boundary between children[boundary] and [boundary+1]
  dir: 'row' | 'col'
  x: number, y: number, w: number, h: number // line position in %
  spanFrac: number // fraction of the split container size along the axis (for px conversion)
}
export interface Layout { panes: PaneRect[], splitters: SplitterRect[] }

export function computeLayout(
  tree: TileNode,
  rect: { x: number, y: number, w: number, h: number } = { x: 0, y: 0, w: 100, h: 100 },
  path: number[] = [],
  out: Layout = { panes: [], splitters: [] },
): Layout {
  if (tree.type === 'leaf') {
    out.panes.push({ paneId: tree.paneId, ...rect })
    return out
  }
  const isRow = tree.dir === 'row'
  const along = isRow ? rect.w : rect.h
  let acc = isRow ? rect.x : rect.y
  tree.children.forEach((child, i) => {
    const size = tree.sizes[i]! * along
    const childRect = isRow
      ? { x: acc, y: rect.y, w: size, h: rect.h }
      : { x: rect.x, y: acc, w: rect.w, h: size }
    computeLayout(child, childRect, [...path, i], out)
    acc += size
    if (i < tree.children.length - 1) {
      out.splitters.push({
        path,
        boundary: i,
        dir: tree.dir,
        x: isRow ? acc : rect.x,
        y: isRow ? rect.y : acc,
        w: isRow ? 0 : rect.w,
        h: isRow ? rect.h : 0,
        spanFrac: along / 100,
      })
    }
  })
  return out
}
