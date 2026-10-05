<script setup lang="ts">
// Type-agnostic split-grid pane: ssh → <SshTerminal>, guac → <GuacClient>
// (both are common-js ws bridges to the BFF, ADR-007/010; no iframe). Close
// button — t() (ADR-006). Tailwind, no scoped CSS (ADR-004). The header is the
// drag handle for moving the pane in the mosaic (the body is not draggable — the
// session is not dragged).
defineProps<{ kind: 'ssh' | 'guac' | 'card' | 'sftp', title: string, deviceId?: string, action?: 'vnc' | 'rdp', pointId?: string }>()
const emit = defineEmits<{ close: [], dragstart: [], dragend: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden rounded border border-default bg-default">
    <div
      class="flex items-center gap-2 px-2 py-1 bg-muted border-b border-default cursor-grab active:cursor-grabbing"
      draggable="true"
      :aria-label="t('board.paneDrag')"
      @dragstart="emit('dragstart')"
      @dragend="emit('dragend')"
    >
      <span class="flex-1 truncate text-xs font-mono text-highlighted">{{ title }}</span>
      <UButton
        icon="i-lucide-x"
        size="xs"
        variant="ghost"
        color="neutral"
        :aria-label="t('terminal.closePane')"
        @click="emit('close')"
      />
    </div>
    <div class="flex-1 min-h-0">
      <SshTerminal v-if="kind === 'ssh'" :device-id="deviceId!" />
      <PointHealthCard v-else-if="kind === 'card'" :point-id="pointId!" />
      <FileManager v-else-if="kind === 'sftp'" :device-id="deviceId!" />
      <GuacClient v-else :device-id="deviceId!" :action="action!" />
    </div>
  </div>
</template>
