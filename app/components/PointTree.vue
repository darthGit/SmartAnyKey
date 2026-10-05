<script setup lang="ts">
// Point tree: a point = a disclosure row, expanding →
// devices chip grid (Tailwind arbitrary value, reflows with the sidebar width).
// Virtualisation over the flat visibleNodes with measureElement (variable
// height: expansion + resize reflow). Reuses DeviceButton/DeviceContextMenu
// at device level (click=default, right click=menu — the home page contract).
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { Device, DeviceType, Point } from '~/types/board'
import type { MatchReason } from '~/utils/boardSearch'
import type { DevicesRow, PointRow } from '~/utils/tree'
import { visibleNodes } from '~/utils/tree'

const props = defineProps<{
  points: Point[]
  typeById: Map<string, DeviceType>
  devicesByPoint: Map<string, Device[]>
  highlightedId?: string | null // search-first: keyboard highlight
  matchReasonById?: Map<string, MatchReason> // why the point is in the results (shown to the user)
}>()
const emit = defineEmits<{
  open: [device: Device]
  menu: [payload: { device: Device, x: number, y: number }]
  discover: [point: Point]
  card: [point: Point]
}>()

const { t } = useI18n()

const expanded = ref<Set<string>>(new Set())
function toggle(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id))
    next.delete(id)
  else
    next.add(id)
  expanded.value = next
}

const nodes = computed(() => visibleNodes(props.points, props.devicesByPoint, expanded.value))

const scrollEl = ref<HTMLElement | null>(null)
const virtualizer = useVirtualizer(computed(() => ({
  count: nodes.value.length,
  getScrollElement: () => scrollEl.value,
  estimateSize: () => 40,
  overscan: 8,
})))

// search-first: expand a point from the keyboard (Enter / auto-single)
// + scroll to the highlighted one. Imperative API for index.vue.
function scrollToPoint(id: string) {
  const idx = nodes.value.findIndex(n => n.kind === 'point' && (n as PointRow).point.id === id)
  if (idx >= 0)
    virtualizer.value.scrollToIndex(idx, { align: 'center' })
}
function expand(id: string) {
  if (!expanded.value.has(id)) {
    const next = new Set(expanded.value)
    next.add(id)
    expanded.value = next
  }
  nextTick(() => scrollToPoint(id))
}
defineExpose({ expand })
watch(() => props.highlightedId, (id) => { if (id) scrollToPoint(id) })
</script>

<template>
  <div ref="scrollEl" class="h-full overflow-y-auto">
    <div :style="{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }">
      <div
        v-for="row in virtualizer.getVirtualItems()"
        :key="String(row.key)"
        :ref="el => el && virtualizer.measureElement(el as Element)"
        :data-index="row.index"
        class="absolute top-0 left-0 right-0"
        :style="{ transform: `translateY(${row.start}px)` }"
      >
        <div
          v-if="nodes[row.index]!.kind === 'point'"
          class="group flex w-full items-center border-b border-default hover:bg-elevated"
          :class="{ 'bg-primary/10': (nodes[row.index] as PointRow).point.id === highlightedId }"
        >
          <button
            class="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
            @click="toggle((nodes[row.index] as PointRow).point.id)"
          >
            <UIcon
              :name="expanded.has((nodes[row.index] as PointRow).point.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
              class="shrink-0 text-muted"
            />
            <span class="shrink-0 font-semibold">№{{ (nodes[row.index] as PointRow).point.number }}</span>
            <span class="truncate">{{ (nodes[row.index] as PointRow).point.address }}</span>
            <!-- why the point is in the search results: a chip
                 when the match is NOT on №/address (device/note/runbook). -->
            <span
              v-if="matchReasonById?.get((nodes[row.index] as PointRow).point.id) && matchReasonById.get((nodes[row.index] as PointRow).point.id) !== 'point'"
              class="shrink-0 rounded bg-elevated px-1.5 py-0.5 text-[10px] text-muted"
            >
              {{ t(`board.match.${matchReasonById.get((nodes[row.index] as PointRow).point.id)}`) }}
            </span>
          </button>
          <!-- subnet ↔ action buttons swap on hover via display
               (not opacity — opacity keeps the reserved space → on a narrow
               row №+subnet+2 icons do not fit and overlap). Only one of
               {subnet, buttons} takes space at a time → never a collision. -->
          <span class="shrink-0 px-2 text-muted font-mono text-xs group-hover:hidden">{{ (nodes[row.index] as PointRow).point.subnet }}</span>
          <UButton
            icon="i-lucide-heart-pulse"
            size="xs"
            variant="ghost"
            color="neutral"
            class="hidden shrink-0 group-hover:inline-flex"
            :aria-label="t('board.health.open')"
            :title="t('board.health.open')"
            @click.stop="emit('card', (nodes[row.index] as PointRow).point)"
          />
          <UButton
            icon="i-lucide-radar"
            size="xs"
            variant="ghost"
            color="neutral"
            class="mr-1 hidden shrink-0 group-hover:inline-flex"
            :aria-label="t('discovery.discover')"
            :title="t('discovery.discover')"
            @click.stop="emit('discover', (nodes[row.index] as PointRow).point)"
          />
        </div>
        <div
          v-else
          class="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-1 px-2 py-1.5 border-b border-default bg-elevated"
        >
          <DeviceButton
            v-for="d in (nodes[row.index] as DevicesRow).devices"
            :key="d.id"
            :device="d"
            :type="typeById.get(d.type_id)!"
            @open="emit('open', $event)"
            @menu="emit('menu', $event)"
          />
        </div>
      </div>
    </div>
  </div>
</template>
