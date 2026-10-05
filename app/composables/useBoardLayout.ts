// Home page layout state: sidebar width (persisted + clamped 220px…50vw), rail
// (persisted), mode from the number of open sessions. Pure helpers are
// unit-tested without Nuxt (tests/board/layout.spec.ts); the composable itself
// is a thin Nuxt wrapper (useState + localStorage).
const WIDTH_KEY = 'board.sidebarWidth'
const RAIL_KEY = 'board.railed'
const MIN_WIDTH = 220

interface KV {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
}

export function computeMode(paneCount: number): 'full' | 'split' {
  return paneCount > 0 ? 'split' : 'full'
}

export function clampWidth(px: number, viewportPx: number): number {
  return Math.min(viewportPx * 0.5, Math.max(MIN_WIDTH, px))
}

export function loadWidth(storage: KV, viewportPx: number, fallback: number): number {
  const raw = storage.getItem(WIDTH_KEY)
  return raw == null ? fallback : clampWidth(Number(raw), viewportPx)
}

export function saveWidth(storage: KV, px: number): void {
  storage.setItem(WIDTH_KEY, String(px))
}

export function loadRailed(storage: KV): boolean {
  return storage.getItem(RAIL_KEY) === '1'
}

export function saveRailed(storage: KV, v: boolean): void {
  storage.setItem(RAIL_KEY, v ? '1' : '0')
}

export function useBoardLayout() {
  const { panes } = useSessionGrid()
  const width = useState<number>('board-sidebar-width', () =>
    import.meta.client
      ? loadWidth(localStorage, window.innerWidth, Math.round(window.innerWidth * 0.25))
      : 320)
  const railed = useState<boolean>('board-railed', () =>
    import.meta.client ? loadRailed(localStorage) : false)

  const mode = computed(() => computeMode(panes.value.length))

  function setWidth(px: number) {
    width.value = clampWidth(px, import.meta.client ? window.innerWidth : 1200)
    if (import.meta.client)
      saveWidth(localStorage, width.value)
  }
  function toggleRail() {
    railed.value = !railed.value
    if (import.meta.client)
      saveRailed(localStorage, railed.value)
  }

  return { width, railed, mode, setWidth, toggleRail }
}
