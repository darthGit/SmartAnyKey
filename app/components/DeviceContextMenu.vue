<script setup lang="ts">
import type { Device, DeviceCommand } from '~/types/board'

const props = defineProps<{ device: Device, x: number, y: number, commands?: DeviceCommand[] }>()
const emit = defineEmits<{
  select: [action: string]
  files: []
  'run-command': [commandId: string]
  close: []
}>()

const { t, te } = useI18n()
// Unknown slug (no action.<slug> key) → show the raw slug, as before.
function actionLabel(action: string): string {
  const key = `action.${action}`
  return te(key) ? t(key) : action
}

// ssh-target commands — only on an ssh-capable device (they run over SSH);
// a local target (Phase 2, executor) needs no ssh on the device → always shown.
const hasSsh = computed(() => props.device.actions.includes('ssh'))
const visibleCommands = computed<DeviceCommand[]>(() =>
  (props.commands ?? []).filter(c => c.target === 'local' || hasSsh.value),
)

// Position = cursor coordinates, but clamped to the viewport: near the bottom/right
// edge (e.g. a device scrolled to the end of the list) the menu would go off-screen.
// Clamp after render (real sizes needed); re-clamp on x/y change and
// when the height grows as async commands load (sshCommands).
const menuEl = ref<HTMLElement | null>(null)
const pos = reactive({ left: props.x, top: props.y })
const ready = ref(false) // hidden until the first clamp — otherwise a one-frame jump from the raw x/y

function clamp() {
  const el = menuEl.value
  if (!el) return
  const m = 8 // margin from the viewport edge
  const { width, height } = el.getBoundingClientRect()
  pos.left = Math.max(m, Math.min(props.x, window.innerWidth - width - m))
  pos.top = Math.max(m, Math.min(props.y, window.innerHeight - height - m))
  ready.value = true
}

onMounted(() => nextTick(clamp))
watch(() => [props.x, props.y, visibleCommands.value.length], () => nextTick(clamp))

const style = computed(() => ({ left: `${pos.left}px`, top: `${pos.top}px` }))
</script>

<template>
  <!-- ponytail: the kit menu (UContextMenu/UDropdownMenu) is bound to its trigger and
       takes no free x/y — the parent here owns the cursor coordinates
       (index.vue), so positioning stays a custom Teleport (ADR-004 "where
       the kit does not cover"). Action items are already UButton, styling is Tailwind
       utilities. The kit-native alternative (wrap DeviceButton in UContextMenu)
       changes the component's contract → a separate change. -->
  <Teleport to="body">
    <div class="fixed inset-0 z-40 backdrop" @click="emit('close')" @contextmenu.prevent="emit('close')" />
    <ul
      ref="menuEl"
      class="fixed z-50 m-0 min-w-52 list-none p-1 rounded-lg shadow-lg ring ring-default bg-default"
      :class="{ 'opacity-0': !ready }"
      :style="style"
    >
      <li class="px-2.5 py-1.5 font-semibold text-muted">{{ device.label }}</li>
      <li v-for="action in device.actions" :key="action">
        <UButton
          :data-action="action"
          block
          variant="ghost"
          color="neutral"
          class="justify-start"
          @click="emit('select', action)"
        >
          {{ actionLabel(action) }}
        </UButton>
      </li>
      <!-- Files (SFTP): only on an ssh-capable device — access goes through the SSH channel -->
      <li v-if="hasSsh">
        <UButton
          block
          variant="ghost"
          color="neutral"
          icon="i-lucide-folder"
          class="justify-start"
          @click="emit('files')"
        >
          {{ t('sftp.menuOpen') }}
        </UButton>
      </li>
      <template v-if="visibleCommands.length">
        <li class="my-1 border-t border-default" />
        <li class="px-2.5 py-1 text-xs font-semibold uppercase text-muted">{{ t('commands.section') }}</li>
        <li v-for="cmd in visibleCommands" :key="cmd.id">
          <UButton
            :data-command-id="cmd.id"
            block
            variant="ghost"
            color="neutral"
            class="justify-start"
            @click="emit('run-command', cmd.id)"
          >
            {{ cmd.name }}
          </UButton>
        </li>
      </template>
    </ul>
  </Teleport>
</template>
