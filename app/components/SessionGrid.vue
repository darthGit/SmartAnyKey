<script setup lang="ts">
// Tiling split grid — flat render: panes
// render as a flat list keyed by `pane.id`, absolutely positioned by the
// rect computed from the tree (`computeLayout`). A pane's DOM does not move when
// the tree is rebuilt → a live SSH session survives any move (unlike
// a recursive render, where the index key remounted the terminal). Splitters and
// drop zones are separate passes. Container-driven (h-full), right column of `/`.
// The engine (ADR-007) is not here. Tailwind, no scoped CSS (ADR-004).
import type { DropZone, SplitterRect } from '~/utils/tile'

const { t } = useI18n()
const { panes, focusedId, layout, draggingId, closePane, movePane, resizePane } = useSessionGrid()

const containerEl = ref<HTMLElement | null>(null)
const computed_ = computed(() =>
  layout.value ? computeLayout(layout.value) : { panes: [], splitters: [] },
)
const rectById = computed(() =>
  Object.fromEntries(computed_.value.panes.map(p => [p.paneId, p])),
)

// ── Splitter resize (reuses the index.vue pattern: overlay + no-transition) ──
const dragging = ref(false)
function startSplit(s: SplitterRect, e: PointerEvent) {
  if (!containerEl.value)
    return
  e.preventDefault()
  dragging.value = true
  const isRow = s.dir === 'row'
  const gridPx = isRow ? containerEl.value.clientWidth : containerEl.value.clientHeight
  const splitPx = gridPx * s.spanFrac
  let last = isRow ? e.clientX : e.clientY
  const move = (ev: PointerEvent) => {
    const cur = isRow ? ev.clientX : ev.clientY
    resizePane(s.path, s.boundary, (cur - last) / splitPx)
    last = cur
  }
  const up = () => {
    dragging.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// ── Docking (drag by the header → drop on a neighbour's zone) ──
const hoverZone = ref<{ paneId: number, zone: DropZone } | null>(null)
const ZONES: DropZone[] = ['top', 'right', 'bottom', 'left', 'center']
function zoneClass(z: DropZone): string {
  return {
    top: 'absolute top-0 inset-x-0 h-1/3',
    bottom: 'absolute bottom-0 inset-x-0 h-1/3',
    left: 'absolute left-0 inset-y-0 w-1/3',
    right: 'absolute right-0 inset-y-0 w-1/3',
    center: 'absolute inset-1/3',
  }[z]
}
function onDrop(paneId: number, z: DropZone) {
  if (draggingId.value != null)
    movePane(draggingId.value, paneId, z)
  hoverZone.value = null
  draggingId.value = null
}
</script>

<template>
  <div ref="containerEl" class="relative h-full">
    <template v-if="panes.length">
      <!-- Panes: flat list, stable key=pane.id, position by rect -->
      <div
        v-for="p in panes"
        :key="p.id"
        class="absolute p-0.5"
        :style="rectById[p.id]
          ? { left: `${rectById[p.id]!.x}%`, top: `${rectById[p.id]!.y}%`, width: `${rectById[p.id]!.w}%`, height: `${rectById[p.id]!.h}%` }
          : { display: 'none' }"
      >
        <div
          class="relative h-full rounded ring-1 transition-colors"
          :class="focusedId === p.id ? 'ring-primary' : 'ring-transparent'"
          @mousedown="focusedId = p.id"
        >
          <SessionPane
            :kind="p.kind"
            :title="p.title"
            :device-id="p.deviceId"
            :action="p.action"
            :point-id="p.pointId"
            @close="closePane(p.id)"
            @dragstart="draggingId = p.id"
            @dragend="draggingId = null"
          />
          <div v-if="draggingId != null && draggingId !== p.id" class="absolute inset-0 z-40">
            <div
              v-for="z in ZONES"
              :key="z"
              :class="[zoneClass(z), hoverZone?.paneId === p.id && hoverZone.zone === z ? 'bg-primary/30' : 'bg-transparent']"
              @dragover.prevent="hoverZone = { paneId: p.id, zone: z }"
              @dragleave="hoverZone = null"
              @drop.prevent="onDrop(p.id, z)"
            />
          </div>
        </div>
      </div>

      <!-- Splitters: thin lines on split-node boundaries -->
      <div
        v-for="(s, i) in computed_.splitters"
        :key="`s${i}`"
        class="group absolute z-30 flex items-center justify-center"
        :class="s.dir === 'row' ? 'cursor-col-resize' : 'cursor-row-resize'"
        :style="s.dir === 'row'
          ? { left: `${s.x}%`, top: `${s.y}%`, height: `${s.h}%`, width: '8px', transform: 'translateX(-50%)' }
          : { left: `${s.x}%`, top: `${s.y}%`, width: `${s.w}%`, height: '8px', transform: 'translateY(-50%)' }"
        :aria-label="t('board.splitterResize')"
        @pointerdown="startSplit(s, $event)"
      >
        <div
          class="bg-border group-hover:bg-primary"
          :class="[s.dir === 'row' ? 'w-0.5 h-full' : 'h-0.5 w-full', dragging ? 'bg-primary' : '']"
        />
      </div>

      <!-- overlay during resize: catches the pointer over an iframe/terminal -->
      <div v-if="dragging" class="fixed inset-0 z-50" />
    </template>

    <div v-else class="h-full grid place-items-center text-muted text-sm">
      {{ t('terminal.closed') }}
    </div>
  </div>
</template>
