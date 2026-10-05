<script setup lang="ts">
// Result modal of a command task. Renders from the `run` prop
// (the parent holds the task_run row and updates it via Realtime — live change
// running→done/failed without a reload). Display only here: output (ANSI-strip),
// exit badge, duration, copy. Exit badge and duration are literals (not i18n), so
// the values always read.
interface RunResult { stdout?: string, stderr?: string, exitCode?: number | null, durationMs?: number }
interface TaskRun {
  id: string
  label: string
  status: 'running' | 'done' | 'failed'
  error?: string | null
  result?: RunResult | null
  started_at?: string
  finished_at?: string | null
}

const props = defineProps<{ run: TaskRun | null, open: boolean }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()
const { t, te } = useI18n()

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g
const output = computed(() => {
  const r = props.run?.result
  if (!r)
    return ''
  return [r.stdout, r.stderr].filter(Boolean).join('\n').replace(ANSI, '')
})
const exitCode = computed(() => props.run?.result?.exitCode ?? null)
const ok = computed(() => props.run?.status === 'done' && exitCode.value === 0)

const durationText = computed(() => {
  const r = props.run
  if (!r?.started_at || !r?.finished_at)
    return ''
  const ms = new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()
  return `${+(ms / 1000).toFixed(1)}s`
})

function errorLabel(code?: string | null): string {
  const key = `commands.error.${code}`
  return code && te(key) ? t(key) : (code ?? 'error')
}

async function copyOutput() {
  await navigator.clipboard?.writeText(output.value)
}
</script>

<template>
  <UModal :open="open" :title="run?.label" @update:open="v => emit('update:open', v)">
    <template #body>
      <div v-if="run?.status === 'running'" class="text-muted">{{ t('commands.running') }}</div>
      <template v-else>
        <div class="mb-2 flex items-center gap-2">
          <span
            data-testid="exit-badge"
            class="rounded px-2 py-0.5 font-mono text-xs"
            :class="ok ? 'bg-green-500/15 text-green-500' : 'bg-red-500/15 text-red-500'"
          >
            {{ run?.status === 'failed' ? errorLabel(run.error) : `exit ${exitCode}` }}
          </span>
          <span v-if="durationText" class="text-sm text-muted">{{ durationText }}</span>
          <UButton
            data-testid="copy-output"
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-copy"
            class="ml-auto"
            @click="copyOutput"
          >
            {{ t('commands.copy') }}
          </UButton>
        </div>
        <pre class="max-h-96 overflow-auto rounded bg-elevated p-3 text-xs whitespace-pre-wrap">{{ output }}</pre>
      </template>
    </template>
  </UModal>
</template>
