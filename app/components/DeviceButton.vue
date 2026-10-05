<script setup lang="ts">
import type { Device, DeviceType } from '~/types/board'

const props = defineProps<{ device: Device, type: DeviceType }>()
const { t } = useI18n()
const emit = defineEmits<{
  open: [device: Device]
  menu: [payload: { device: Device, x: number, y: number }]
}>()

// Type icon = emoji (client-owned); the resolver is shared with admin CRUD and keeps
// back-compat for legacy seed keys (utils/device-icon.ts).

// Native href → middle-click opens the session in a new tab without JS;
// left click is intercepted into the modal.
const href = computed(() => `/api/remote-session/${props.device.id}`)

// The tooltip carries both the label and the observed name: the tree shows
// only `label`, so a mismatch "we call it Till 3, the machine says kasa-7"
// is otherwise invisible without opening the card.
const title = computed(() => {
  const base = `${props.type.name} — ${props.device.label}`
  const hn = props.device.hostname
  if (!hn)
    return base
  const mark = hostnameMismatch(props.device.label, hn) ? ` ⚠ ${t('board.hostname.mismatch')}` : ''
  return `${base}\n${t('board.hostname.label')}: ${hn}${mark}`
})
</script>

<template>
  <UButton
    :to="href"
    external
    variant="outline"
    color="neutral"
    size="sm"
    :style="{ '--c': type.color, color: type.color, '--ui-border-accented': type.color }"
    :title="title"
    class="w-full min-w-0 whitespace-nowrap bg-[color-mix(in_oklab,var(--c)_10%,transparent)] hover:bg-[color-mix(in_oklab,var(--c)_20%,transparent)]"
    @click.exact.prevent="emit('open', device)"
    @contextmenu.prevent="emit('menu', { device, x: $event.clientX, y: $event.clientY })"
  >
    <span class="text-sm leading-none">{{ resolveDeviceIcon(type.icon) }}</span>
    <!-- min-w-0+truncate: otherwise the label (whitespace-nowrap) stretches the grid cell and
         runs onto the neighbouring chip; the full name stays in title (hover). -->
    <span class="min-w-0 truncate">{{ device.label }}</span>
  </UButton>
</template>
