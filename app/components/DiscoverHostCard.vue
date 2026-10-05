<script setup lang="ts">
// Structured host card for the auto-discovery diff. Shared
// by DiscoverDrawer and TeachStep (the same look of a sample). Presentational:
// the type is recognisable at a glance (type icon+colour — reuses the DeviceButton
// pattern; colour comes from data, not hardcoded) + status/conf/port chips.
// Rogue/unknown is a separate state (warning), not an "empty type". Action buttons stay
// in the parent (confirm in the drawer, use-sample in teach). ADR-012/004/006.
import type { DeviceType, DiscoveredHost, ReconcileStatus } from '~/types/board'

const props = defineProps<{ host: DiscoveredHost, types: DeviceType[] }>()

const { t } = useI18n()

// rogue/unknown = unclassified (no proposed type) → a separate state in the template.
const type = computed(() => props.types.find(ty => ty.id === props.host.proposed_type_id) ?? null)

const STATUS_COLOR: Record<ReconcileStatus, 'info' | 'success' | 'warning' | 'error'> = {
  new: 'info', matched: 'success', changed: 'warning', rogue: 'error',
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <!-- identity: type (icon+colour) or rogue marker + ip + hostname -->
    <div class="flex items-center gap-2">
      <span
        v-if="type"
        data-testid="type-icon"
        class="inline-flex items-center gap-1.5 font-medium leading-none"
        :style="{ color: type.color }"
      >
        <span class="text-base leading-none">{{ resolveDeviceIcon(type.icon) }}</span>
        <span class="text-sm">{{ type.name }}</span>
      </span>
      <span v-else data-testid="rogue" class="inline-flex items-center gap-1 text-sm text-error">
        <UIcon name="i-lucide-alert-triangle" />
        {{ t('discovery.unknown') }}
      </span>

      <span class="font-mono text-sm text-highlighted">{{ host.ip }}</span>
      <span v-if="host.hostname" class="truncate text-xs text-muted">{{ host.hostname }}</span>
      <!-- The name the machine reported itself (NSE) — a different signal from the PTR above:
           in a mixed-up inventory it is what catches
           "this IP is not what we thought". -->
      <UBadge
        v-if="host.nse_hostname"
        data-testid="chip-nse-hostname"
        size="xs"
        color="neutral"
        variant="subtle"
        class="font-mono"
        :title="t('board.hostname.source.nse')"
      >
        {{ host.nse_hostname }}
      </UBadge>
    </div>

    <!-- chips: status · confidence · ports · os -->
    <div class="flex flex-wrap items-center gap-1.5">
      <UBadge data-testid="chip-status" size="xs" :color="STATUS_COLOR[host.reconcile_status]" variant="subtle">
        {{ t(`discovery.status.${host.reconcile_status}`) }}
      </UBadge>
      <UBadge
        v-if="host.confidence != null"
        data-testid="chip-confidence"
        size="xs"
        :color="host.confidence < 100 ? 'warning' : 'success'"
        variant="subtle"
      >
        {{ t('discovery.confidenceShort', { value: host.confidence }) }}
      </UBadge>
      <UBadge
        v-for="p in host.open_ports ?? []"
        :key="p.port"
        data-testid="chip-port"
        size="xs"
        color="neutral"
        variant="subtle"
        class="font-mono"
      >
        {{ p.port }}/{{ p.service ?? p.proto }}
      </UBadge>
      <UBadge v-if="host.os_guess" size="xs" color="neutral" variant="outline">
        {{ host.os_guess }}
      </UBadge>
    </div>
  </div>
</template>
