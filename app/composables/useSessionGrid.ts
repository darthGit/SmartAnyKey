// Multi-session surface: panes are a flat registry of live sessions; the layout
// is a recursive tile tree `layout` (utils/tile). The board (index.vue) adds a
// pane, the layout reacts by itself (no route — home-tree on `/`). A pane is
// type-agnostic: ssh (xterm) or guac (iframe). State is in-memory (sessions do
// not survive a reload → no persistence needed).
import type { DropZone, TileNode } from '~/utils/tile'

export interface Pane {
  id: number
  kind: 'ssh' | 'guac' | 'card' | 'sftp'
  title: string
  deviceId?: string
  action?: 'vnc' | 'rdp' // guac: the pane's protocol (ADR-010, no sessionUrl)
  pointId?: string // card: the point's card
}

export function useSessionGrid() {
  const panes = useState<Pane[]>('session-grid-panes', () => [])
  const seq = useState<number>('session-grid-seq', () => 0)
  const focusedId = useState<number | null>('session-grid-focused', () => null)
  const layout = useState<TileNode | null>('session-grid-layout', () => null)
  const draggingId = useState<number | null>('session-grid-dragging', () => null)

  function openPane(p: Omit<Pane, 'id'>): number {
    const id = ++seq.value
    panes.value = [...panes.value, { ...p, id }]
    // A new pane splits the focused one to the right; with no focus — split the root.
    const target = focusedId.value != null
      ? { paneId: focusedId.value, edge: 'right' as const }
      : undefined
    layout.value = insertLeaf(layout.value, id, target)
    focusedId.value = id
    return id
  }

  function closePane(id: number): void {
    panes.value = panes.value.filter(p => p.id !== id)
    layout.value = layout.value ? removeLeaf(layout.value, id) : null
    if (focusedId.value === id)
      focusedId.value = panes.value.at(-1)?.id ?? null
  }

  // Move a pane by docking (edge) or swap (center).
  function movePane(from: number, to: number, zone: DropZone): void {
    if (layout.value)
      layout.value = moveLeaf(layout.value, from, to, zone)
  }

  // Resize a split node's boundary at `path` in the tree.
  function resizePane(path: number[], boundary: number, deltaFrac: number): void {
    if (layout.value)
      layout.value = resizeSplit(layout.value, path, boundary, deltaFrac)
  }

  return { panes, focusedId, layout, draggingId, openPane, closePane, movePane, resizePane }
}
