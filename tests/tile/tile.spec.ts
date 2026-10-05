// RED: pure tile-tree logic of the session mosaic. Module
// app/utils/tile does not exist yet → fails. Node env, no Nuxt runtime.
import { describe, expect, it } from 'vitest'
import {
  computeLayout,
  insertLeaf,
  moveLeaf,
  removeLeaf,
  resizeSplit,
  type Split,
  type TileNode,
} from '../../app/utils/tile'

// Fixture helpers
const leaf = (paneId: number): TileNode => ({ type: 'leaf', paneId })
const rowAB = (): Split => ({
  type: 'split',
  dir: 'row',
  children: [leaf(1), leaf(2)],
  sizes: [0.5, 0.5],
})
const colAB = (): Split => ({
  type: 'split',
  dir: 'col',
  children: [leaf(1), leaf(2)],
  sizes: [0.5, 0.5],
})

const paneIds = (n: TileNode): number[] =>
  n.type === 'leaf' ? [n.paneId] : n.children.flatMap(paneIds)

describe('resizeSplit', () => {
  it('resize_row_split_shifts_widths', () => {
    const out = resizeSplit(rowAB(), [], 0, 0.2) as Split
    expect(out.dir).toBe('row')
    expect(out.sizes[0]).toBeCloseTo(0.7)
    expect(out.sizes[1]).toBeCloseTo(0.3)
    expect(out.sizes[0]! + out.sizes[1]!).toBeCloseTo(1)
  })

  it('resize_col_split_shifts_heights', () => {
    const out = resizeSplit(colAB(), [], 0, 0.2) as Split
    expect(out.dir).toBe('col') // axis preserved
    expect(out.sizes[0]).toBeCloseTo(0.7)
    expect(out.sizes[1]).toBeCloseTo(0.3)
  })

  it('resize_clamped_at_min_fraction', () => {
    // +0.9 to the first: the second would drop to -0.4 → clamp both ≥ 0.12
    const out = resizeSplit(rowAB(), [], 0, 0.9) as Split
    expect(out.sizes[1]).toBeCloseTo(0.12)
    expect(out.sizes[0]).toBeCloseTo(0.88)
  })
})

describe('moveLeaf', () => {
  it('move_to_edge_creates_split', () => {
    // row[a,b]; drag a onto the bottom edge of b → col-split [b, a]
    const out = moveLeaf(rowAB(), 1, 2, 'bottom')
    expect(out.type).toBe('split')
    const s = out as Split
    expect(s.dir).toBe('col')
    expect(paneIds(s)).toEqual([2, 1])
    // pane a is no longer duplicated
    expect(paneIds(out).filter(id => id === 1)).toHaveLength(1)
  })

  it('move_to_center_swaps_panes', () => {
    const out = moveLeaf(rowAB(), 1, 2, 'center') as Split
    expect(out.type).toBe('split')
    expect(paneIds(out)).toEqual([2, 1]) // positions swapped
  })
})

describe('removeLeaf', () => {
  it('remove_leaf_collapses_parent_split', () => {
    // row[a,b] → remove b → split collapses into leaf a
    const out = removeLeaf(rowAB(), 2)
    expect(out).toEqual(leaf(1))
    // nested: row[a, col[b,c]] → remove c → row[a, b]
    const nested: Split = {
      type: 'split',
      dir: 'row',
      children: [
        leaf(1),
        { type: 'split', dir: 'col', children: [leaf(2), leaf(3)], sizes: [0.5, 0.5] },
      ],
      sizes: [0.5, 0.5],
    }
    const out2 = removeLeaf(nested, 3) as Split
    expect(out2.type).toBe('split')
    expect(paneIds(out2)).toEqual([1, 2])
    // inner split dissolved into leaf b
    expect(out2.children[1]).toEqual(leaf(2))
    expect(out2.sizes[0]! + out2.sizes[1]!).toBeCloseTo(1)
  })
})

describe('computeLayout', () => {
  it('flat_rects_and_splitters_for_row', () => {
    const { panes, splitters } = computeLayout(rowAB())
    expect(panes).toHaveLength(2)
    expect(panes[0]).toMatchObject({ paneId: 1, x: 0, y: 0, w: 50, h: 100 })
    expect(panes[1]).toMatchObject({ paneId: 2, x: 50, y: 0, w: 50, h: 100 })
    expect(splitters).toHaveLength(1)
    expect(splitters[0]).toMatchObject({ path: [], boundary: 0, dir: 'row' })
  })

  it('nested_layout_positions_leaves_absolutely', () => {
    // row[a, col[b,c]] → a on the left (w50), b/c stacked on the right (each h50)
    const tree: Split = {
      type: 'split',
      dir: 'row',
      children: [
        leaf(1),
        { type: 'split', dir: 'col', children: [leaf(2), leaf(3)], sizes: [0.5, 0.5] },
      ],
      sizes: [0.5, 0.5],
    }
    const { panes } = computeLayout(tree)
    const byId = Object.fromEntries(panes.map(p => [p.paneId, p]))
    expect(byId[1]).toMatchObject({ x: 0, w: 50, h: 100 })
    expect(byId[2]).toMatchObject({ x: 50, y: 0, w: 50, h: 50 })
    expect(byId[3]).toMatchObject({ x: 50, y: 50, w: 50, h: 50 })
  })
})

describe('insertLeaf', () => {
  it('insert_into_empty_makes_root_leaf', () => {
    expect(insertLeaf(null, 1)).toEqual(leaf(1))
  })

  it('insert_at_edge_splits_target', () => {
    // leaf a; insert b on the right → row[a,b]
    const out = insertLeaf(leaf(1), 2, { paneId: 1, edge: 'right' }) as Split
    expect(out.type).toBe('split')
    expect(out.dir).toBe('row')
    expect(paneIds(out)).toEqual([1, 2])
    expect(out.sizes[0]! + out.sizes[1]!).toBeCloseTo(1)
  })
})
