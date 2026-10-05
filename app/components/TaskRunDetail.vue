<script setup lang="ts">
// Task run detail.
// View, not edit (interaction convention): nothing is entered
// here — you only read the log, take files and rerun on the same payload.
//
// **The log grows by polling, not Realtime.** The design said "Realtime
// subscription", but this path was observed failing live on
// `task_run`: (1) postgres_changes delivers only changes after the subscription — a short
// run finishes before the channel connects; (2) realtime RLS
// authorization on self-host is fragile. Polling rereads the log tail in full, so
// a "missed event" cannot exist by construction, and visibility comes from the BFF (own run —
// for everyone, someone else's — admin only), not realtime.setAuth.
// ponytail: 2s interval; a ws stream — once the log runs to hundreds of MB.
import { formatBytes, formatDuration, runDurationMs, runStatusColor } from '~/utils/taskFormat'

const props = defineProps<{ runId: string | null, open: boolean }>()
const emit = defineEmits<{ 'update:open': [boolean], 'rerun': [string] }>()

const { t, te } = useI18n()
const session = useSupabaseSession()
const authHeaders = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

interface Artifact { path: string, size: number, content_type: string | null }
interface RunDetail {
  id: string
  task_id: string | null
  label: string
  status: string
  phase: string | null
  attempt: number
  error: string | null
  log: string | null
  started_at: string | null
  finished_at: string | null
  input: Record<string, unknown> | null
  result: Record<string, unknown> | null
  artifacts: Artifact[]
}

const run = ref<RunDetail | null>(null)
const loadErr = ref('')
const busy = ref(false)
const notice = ref('')
// Time tick: the duration of an unfinished run must visibly grow.
const now = ref(new Date())

const logBox = ref<HTMLElement>()
const isRunning = computed(() => run.value?.status === 'running')

async function load() {
  if (!props.runId)
    return
  try {
    const wasAtBottom = atBottom()
    run.value = await $fetch<RunDetail>(`/api/tasks/runs/${props.runId}`, { headers: authHeaders.value })
    loadErr.value = ''
    // Autoscroll only if the reader was already at the bottom — otherwise polling would
    // throw them out of the place they are reading.
    if (wasAtBottom)
      await nextTick(() => scrollToBottom())
  }
  catch (e) {
    loadErr.value = (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message
  }
}

function atBottom(): boolean {
  const el = logBox.value
  if (!el)
    return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40
}
function scrollToBottom() {
  const el = logBox.value
  if (el)
    el.scrollTop = el.scrollHeight
}

let timer: ReturnType<typeof setInterval> | null = null
function stopPolling() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
function startPolling() {
  stopPolling()
  timer = setInterval(async () => {
    now.value = new Date()
    if (!props.open) {
      stopPolling()
      return
    }
    await load()
    // The run has finished — nothing more to reread.
    if (!isRunning.value)
      stopPolling()
  }, 2000)
}

watch(() => [props.open, props.runId], async ([open]) => {
  if (!open) {
    stopPolling()
    return
  }
  run.value = null
  notice.value = ''
  await load()
  if (isRunning.value)
    startPolling()
}, { immediate: true })

onBeforeUnmount(stopPolling)

const durationText = computed(() => formatDuration(runDurationMs(run.value, now.value)))
const exitCode = computed(() => (run.value?.result as { exitCode?: number | null } | null)?.exitCode ?? null)
const lateByMs = computed(() => Number((run.value?.result as { lateByMs?: number } | null)?.lateByMs ?? 0))
const skipped = computed(() => (run.value?.result as { skippedArtifacts?: string[] } | null)?.skippedArtifacts ?? [])
const payload = computed(() => (run.value?.input as { payload?: string | null } | null)?.payload ?? null)

function statusLabel(status?: string | null): string {
  const key = `tasks.status.${status}`
  return status && te(key) ? t(key) : (status ?? '—')
}
function phaseLabel(phase?: string | null): string {
  const key = `tasks.phase.${phase}`
  return phase && te(key) ? t(key) : (phase ?? '')
}
function errorLabel(code?: string | null): string {
  const key = `tasks.error.${code}`
  return code && te(key) ? t(key) : (code ?? '')
}

async function download(a: Artifact) {
  try {
    const { url } = await $fetch<{ url: string }>(`/api/tasks/runs/${props.runId}/artifact`, {
      query: { path: a.path },
      headers: authHeaders.value,
    })
    // A signed Storage URL carries its own token in the query — native navigation
    // works without an Authorization header (unlike our BFF routes).
    window.open(url, '_blank')
  }
  catch (e) {
    notice.value = t('tasks.run.downloadError', { message: (e as Error).message })
  }
}

async function rerun() {
  busy.value = true
  try {
    const res = await $fetch<{ runId: string }>(`/api/tasks/runs/${props.runId}/rerun`, {
      method: 'POST',
      headers: authHeaders.value,
    })
    notice.value = t('tasks.run.rerunQueued', { id: res.runId.slice(0, 8) })
    emit('rerun', res.runId)
  }
  catch (e) {
    notice.value = (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal
    :open="open"
    :title="run?.label ?? t('tasks.run.title')"
    :ui="{ content: 'max-w-3xl' }"
    @update:open="v => emit('update:open', v)"
  >
    <template #body>
      <p v-if="loadErr" class="text-sm text-error">{{ loadErr }}</p>

      <div v-else-if="run" class="flex flex-col gap-3">
        <!-- Run state: status, phase, attempt, duration -->
        <div class="flex flex-wrap items-center gap-2">
          <UBadge :color="runStatusColor(run.status)" variant="subtle" data-testid="run-status">
            {{ statusLabel(run.status) }}
          </UBadge>
          <UBadge v-if="isRunning && run.phase" color="info" variant="soft">{{ phaseLabel(run.phase) }}</UBadge>
          <span v-if="exitCode !== null" class="font-mono text-xs text-muted">{{ t('tasks.run.exit', { code: exitCode }) }}</span>
          <span v-if="run.error" class="text-xs text-error">{{ errorLabel(run.error) }}</span>
          <UBadge v-if="run.attempt > 1" color="warning" variant="subtle">
            {{ t('tasks.runs.attempt', { n: run.attempt }) }}
          </UBadge>
          <span v-if="durationText" class="text-xs text-muted">{{ durationText }}</span>
          <span v-if="run.started_at" class="text-xs text-muted">{{ new Date(run.started_at).toLocaleString() }}</span>
        </div>

        <!-- lateness after downtime — explicit, not silent -->
        <p v-if="lateByMs > 0" class="text-xs text-warning">
          {{ t('tasks.run.lateBy', { duration: formatDuration(lateByMs) }) }}
        </p>

        <!-- Log: grows by polling while the run is going -->
        <div>
          <div class="mb-1 flex items-center gap-2">
            <span class="text-sm font-medium text-highlighted">{{ t('tasks.run.log') }}</span>
            <span v-if="isRunning" class="text-xs text-muted">{{ t('tasks.run.liveHint') }}</span>
          </div>
          <pre
            ref="logBox"
            data-testid="run-log"
            class="max-h-80 overflow-auto rounded bg-elevated p-3 text-xs whitespace-pre-wrap"
          >{{ run.log || t('tasks.run.noLog') }}</pre>
        </div>

        <!-- Artifacts -->
        <div>
          <span class="text-sm font-medium text-highlighted">{{ t('tasks.run.artifacts') }}</span>
          <p v-if="!run.artifacts?.length" class="text-sm text-muted">{{ t('tasks.run.noArtifacts') }}</p>
          <ul v-else class="mt-1 divide-y divide-default rounded ring ring-default">
            <li v-for="a in run.artifacts" :key="a.path" class="flex items-center gap-3 p-2">
              <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ a.path.split('/').pop() }}</span>
              <span class="text-xs text-muted">{{ formatBytes(a.size) }}</span>
              <UButton size="xs" variant="ghost" icon="i-lucide-download" data-action="artifact-download" @click="download(a)">
                {{ t('tasks.run.download') }}
              </UButton>
            </li>
          </ul>
          <p v-if="skipped.length" class="mt-1 text-xs text-warning">
            {{ t('tasks.run.skippedArtifacts', { files: skipped.join(', ') }) }}
          </p>
        </div>

        <!-- Incoming payload: exactly what came from the external system -->
        <div v-if="payload">
          <span class="text-sm font-medium text-highlighted">{{ t('tasks.run.payload') }}</span>
          <pre class="mt-1 max-h-40 overflow-auto rounded bg-elevated p-3 text-xs whitespace-pre-wrap">{{ payload }}</pre>
        </div>

        <p v-if="notice" class="text-sm text-muted">{{ notice }}</p>
      </div>
    </template>

    <!-- Footer without its own justify-*: the kit provides the layout -->
    <template #footer>
      <UButton color="neutral" variant="ghost" @click="emit('update:open', false)">
        {{ t('tasks.run.close') }}
      </UButton>
      <UButton
        v-if="run && run.task_id && !isRunning"
        color="primary"
        variant="soft"
        icon="i-lucide-rotate-ccw"
        :loading="busy"
        data-action="run-rerun"
        @click="rerun"
      >
        {{ payload ? t('tasks.run.rerun') : t('tasks.run.rerunPlain') }}
      </UButton>
    </template>
  </UModal>
</template>
