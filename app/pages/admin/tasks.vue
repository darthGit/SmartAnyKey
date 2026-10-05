<script setup lang="ts">
// Admin UI for scheduled tasks.
// CSR, Nuxt UI, i18n (ADR-006). All data goes through the BFF under `requireRole(admin)` with
// Bearer: the client does not read `tasks` directly, because the definition holds `env`
// (non-secret, but not for a viewer either) and the `cred_refs` list.
//
// Interaction canon: a click anywhere on the row opens the task;
// view ≠ edit (the definition starts readonly, "Edit" switches);
// in-row actions (toggle, "Run now") do not open it.
import { formatBytes, formatDuration, nextCronRun, runStatusColor } from '~/utils/taskFormat'

const { t, te } = useI18n()
const session = useSupabaseSession()
const authHeaders = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

interface Trigger {
  id: string
  task_id: string
  kind: 'cron' | 'webhook'
  cron: string | null
  next_run_at: string | null
  misfire_policy: 'run' | 'skip'
  sync: boolean
  enabled: boolean
}
interface Task {
  id: string
  name: string
  /** Built-in action (ADR-018 amendment 4): the product defines the body, admin only the settings. */
  builtin: string | null
  runtime: string
  entrypoint: string
  files: Record<string, string>
  deps: string
  deps_lock: string
  env: Record<string, string>
  cred_refs: { set_id: string, env: string }[]
  timeout_s: number
  retries: number
  backoff_s: number
  overlap_policy: 'skip' | 'queue'
  min_role: 'operator' | 'admin'
  enabled: boolean
  sink_url: string
  sink_on: 'failed' | 'always'
  triggers: Trigger[]
}
interface RunRow {
  id: string
  task_id: string | null
  label: string
  status: string
  phase: string | null
  attempt: number
  error: string | null
  result: { durationMs?: number, late?: boolean } | null
  started_at: string
  finished_at: string | null
}
interface RunnerCache {
  runtimes: string[]
  bytes: number
  limitBytes: number
  envs: { key: string, bytes: number }[]
  error: string | null
}

const tasks = ref<Task[]>([])
const runtimes = ref<string[]>([])
const cache = ref<RunnerCache[]>([])
const credSets = ref<{ label: string, value: string }[]>([])
const loadErr = ref('')
const notice = ref('')
// Time tick — "next run in 4 min" must count down by itself.
const now = ref(new Date())
let clock: ReturnType<typeof setInterval> | null = null

async function loadTasks() {
  try {
    const res = await $fetch<{ tasks: Task[], runtimes: string[] }>('/api/admin/tasks', { headers: authHeaders.value })
    tasks.value = res.tasks
    runtimes.value = res.runtimes
    loadErr.value = ''
  }
  catch (e) {
    loadErr.value = t('tasks.admin.loadError', { message: (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message })
  }
}
async function loadCache() {
  const res = await $fetch<{ runners: RunnerCache[] }>('/api/admin/tasks/cache', { headers: authHeaders.value }).catch(() => null)
  cache.value = res?.runners ?? []
}
async function loadCredSets() {
  const sets = await $fetch<{ id: string, name: string }[]>('/api/credentials', { headers: authHeaders.value }).catch(() => [])
  credSets.value = sets.map(s => ({ label: s.name, value: s.id }))
}

// Deep link from a notification: `?run=<id>` opens the run detail at once. Without
// it, `runUrl` in the sink body would be a promise the UI does not keep.
const route = useRoute()

onMounted(async () => {
  await Promise.all([loadTasks(), loadCache(), loadCredSets(), loadRuns()])
  const deepLink = route.query.run
  if (typeof deepLink === 'string' && deepLink)
    openRun(deepLink)
  clock = setInterval(() => {
    now.value = new Date()
    // While the log has an unfinished run, re-read it: otherwise the row
    // would stick on `running` until a manual "Refresh" (same as the detail view
    // requires, only cheaper — the list does not show the log).
    if (runs.value.some(r => r.status === 'running'))
      void loadRuns('refresh')
  }, 5000)
})
onBeforeUnmount(() => { if (clock) clearInterval(clock) })

// --- run log -----------------------------------------------------------------

const runs = ref<RunRow[]>([])
// Sentinel `ALL`, not an empty string: `USelect` (Reka `SelectItem`) throws
// "must have a value prop that is not an empty string" — the kit reserves the empty
// string for "nothing selected" (same trap as cadence in
// /admin/points).
const ALL = 'all'
const filterTask = ref<string>(ALL)
const filterStatus = ref<string>(ALL)
const runsOffset = ref(0)
const PAGE = 50
/** Ceiling of the server `limit` (server/api/tasks/runs/index.get.ts). */
const SERVER_MAX = 200
const runsHasMore = ref(false)

const statusItems = computed(() => [
  { label: t('tasks.runs.allStatuses'), value: ALL },
  ...['done', 'failed', 'running', 'skipped'].map(s => ({ label: t(`tasks.status.${s}`), value: s })),
])
const taskFilterItems = computed(() => [
  { label: t('tasks.runs.allTasks'), value: ALL },
  ...tasks.value.map(x => ({ label: x.name, value: x.id })),
])

/**
 * The log in pages of `PAGE` (server ceiling — 200, `.range()` bypasses the
 * PGRST cap of 1000): even with thousands of runs a page fetches 50 rows, the rest
 * via the "Show more" button.
 * `refresh=true` (polling) re-reads the already loaded window, not the first page:
 * otherwise an active run collapsed the list back to 50 rows for whoever
 * had scrolled down the log.
 */
async function loadRuns(mode: 'reset' | 'append' | 'refresh' = 'reset') {
  if (mode === 'reset')
    runsOffset.value = 0
  const limit = mode === 'refresh'
    ? Math.min(Math.max(runs.value.length, PAGE), SERVER_MAX)
    : PAGE
  const page = await $fetch<RunRow[]>('/api/tasks/runs', {
    headers: authHeaders.value,
    query: {
      taskId: filterTask.value === ALL ? undefined : filterTask.value,
      status: filterStatus.value === ALL ? undefined : filterStatus.value,
      limit,
      offset: mode === 'refresh' ? 0 : runsOffset.value,
    },
  }).catch(() => null)
  if (!page)
    return
  if (mode === 'append') {
    // Dedup by id: the log is live, so a new run shifts rows and the same
    // page can bring a row already shown (duplicate `:key` in v-for).
    const seen = new Set(runs.value.map(r => r.id))
    runs.value = [...runs.value, ...page.filter(r => !seen.has(r.id))]
  }
  else {
    runs.value = page
  }
  runsHasMore.value = page.length === limit
}
watch([filterTask, filterStatus], () => loadRuns())
async function loadMoreRuns() {
  runsOffset.value = runs.value.length
  await loadRuns('append')
}

const detailRunId = ref<string | null>(null)
const detailOpen = ref(false)
function openRun(id: string) {
  detailRunId.value = id
  detailOpen.value = true
}

// --- definition: view / edit -------------------------------------------------

const formOpen = ref(false)
const editing = ref<Task | null>(null)
const readonlyView = ref(true) // view ≠ edit
// Built-in task: it has no body (runtime/files/dependencies) — the BFF itself
// runs it. Admin configures schedule, env and ceilings, so the body editor is hidden
// instead of showing an empty, unsaveable one.
const isBuiltin = computed(() => !!editing.value?.builtin)
const saveErr = ref('')
// A message inside the modal (not an error): "saved — now you can add a trigger".
const formNotice = ref('')
const busy = ref('')

interface FormState {
  name: string
  runtime: string
  entrypoint: string
  files: { name: string, body: string }[]
  deps: string
  deps_lock: string
  env: { key: string, value: string }[]
  cred_refs: { set_id: string, env: string }[]
  timeout_s: number
  retries: number
  backoff_s: number
  overlap_policy: 'skip' | 'queue'
  min_role: 'operator' | 'admin'
  enabled: boolean
  sink_url: string
  sink_on: 'failed' | 'always'
}

const emptyForm = (): FormState => ({
  name: '',
  runtime: runtimes.value[0] ?? '',
  entrypoint: 'main.py',
  files: [{ name: 'main.py', body: '' }],
  deps: '',
  deps_lock: '',
  env: [],
  cred_refs: [],
  timeout_s: 600,
  retries: 0,
  backoff_s: 0,
  overlap_policy: 'skip',
  min_role: 'operator',
  enabled: true,
  sink_url: '',
  sink_on: 'failed',
})
const form = reactive<FormState>(emptyForm())
const activeFile = ref(0)

const overlapItems = computed(() => [
  { label: t('tasks.admin.overlapSkip'), value: 'skip' },
  { label: t('tasks.admin.overlapQueue'), value: 'queue' },
])
const minRoleItems = computed(() => [
  { label: t('tasks.admin.minRoleOperator'), value: 'operator' },
  { label: t('tasks.admin.minRoleAdmin'), value: 'admin' },
])
const sinkOnItems = computed(() => [
  { label: t('tasks.admin.sinkOnFailed'), value: 'failed' },
  { label: t('tasks.admin.sinkOnAlways'), value: 'always' },
])
const runtimeItems = computed(() => runtimes.value.map(r => ({ label: r, value: r })))

/** Highlight language — by file extension, not by runtime: a node task may
 *  hold a .json, a python task a .sh. */
function fileLanguage(name: string): string {
  if (name.endsWith('.py'))
    return 'python'
  if (/\.(m?js|cjs|ts|json)$/.test(name))
    return 'node'
  return 'raw'
}

function openNew() {
  editing.value = null
  Object.assign(form, emptyForm())
  activeFile.value = 0
  readonlyView.value = false // a new one is always in edit mode
  saveErr.value = ''
  formNotice.value = ''
  formOpen.value = true
}
function openTask(task: Task) {
  editing.value = task
  Object.assign(form, {
    name: task.name,
    runtime: task.runtime,
    entrypoint: task.entrypoint,
    files: Object.entries(task.files ?? {}).map(([name, body]) => ({ name, body })),
    deps: task.deps ?? '',
    deps_lock: task.deps_lock ?? '',
    env: Object.entries(task.env ?? {}).map(([key, value]) => ({ key, value: String(value) })),
    cred_refs: (task.cred_refs ?? []).map(r => ({ ...r })),
    timeout_s: task.timeout_s,
    retries: task.retries,
    backoff_s: task.backoff_s,
    overlap_policy: task.overlap_policy,
    min_role: task.min_role,
    enabled: task.enabled,
    sink_url: task.sink_url ?? '',
    sink_on: task.sink_on ?? 'failed',
  } satisfies FormState)
  activeFile.value = Math.max(0, form.files.findIndex(f => f.name === task.entrypoint))
  readonlyView.value = true
  saveErr.value = ''
  formNotice.value = ''
  newToken.value = ''
  formOpen.value = true
}

function addFile() {
  form.files.push({ name: `file${form.files.length + 1}.py`, body: '' })
  activeFile.value = form.files.length - 1
}
function removeFile(i: number) {
  form.files.splice(i, 1)
  activeFile.value = Math.min(activeFile.value, form.files.length - 1)
}

const filesPayload = computed(() => Object.fromEntries(
  form.files.filter(f => f.name.trim()).map(f => [f.name.trim(), f.body]),
))
const entrypointValid = computed(() => form.entrypoint.trim() in filesPayload.value)
const canSave = computed(() => !!form.name.trim() && (isBuiltin.value || (!!form.runtime && entrypointValid.value)))

async function save() {
  saveErr.value = ''
  busy.value = 'save'
  const body = {
    name: form.name.trim(),
    runtime: form.runtime,
    entrypoint: form.entrypoint.trim(),
    files: filesPayload.value,
    deps: form.deps,
    deps_lock: form.deps_lock,
    env: Object.fromEntries(form.env.filter(e => e.key.trim()).map(e => [e.key.trim(), e.value])),
    cred_refs: form.cred_refs.filter(r => r.set_id && r.env.trim()).map(r => ({ set_id: r.set_id, env: r.env.trim() })),
    timeout_s: form.timeout_s,
    retries: form.retries,
    backoff_s: form.backoff_s,
    overlap_policy: form.overlap_policy,
    min_role: form.min_role,
    enabled: form.enabled,
    sink_url: form.sink_url.trim(),
    sink_on: form.sink_on,
  }
  try {
    if (editing.value) {
      await $fetch(`/api/admin/tasks/${editing.value.id}`, { method: 'PATCH', headers: authHeaders.value, body })
      formOpen.value = false
      await loadTasks()
    }
    else {
      // Triggers need the task id, so the empty form has none. But closing
      // the modal is no option either: then "add a schedule" = find the task in
      // the list and reopen it (the typical task must not require a
      // second search). Stay in the same modal, now as the view of the
      // created task — the triggers section appears at once.
      const created = await $fetch<{ id: string }>('/api/admin/tasks', { method: 'POST', headers: authHeaders.value, body })
      await loadTasks()
      const fresh = tasks.value.find(x => x.id === created.id)
      if (fresh) {
        openTask(fresh)
        formNotice.value = t('tasks.admin.createdAddTrigger')
      }
      else {
        formOpen.value = false
      }
    }
  }
  catch (e) {
    saveErr.value = t('tasks.admin.saveError', { message: (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message })
  }
  finally {
    busy.value = ''
  }
}

async function removeTask(task: Task) {
  if (!confirm(t('tasks.admin.deleteConfirm', { name: task.name })))
    return
  await $fetch(`/api/admin/tasks/${task.id}`, { method: 'DELETE', headers: authHeaders.value })
  formOpen.value = false
  await Promise.all([loadTasks(), loadRuns()])
}

/** In-row toggle: patch one field (the patch schema leaves the rest of the definition alone). */
async function toggleEnabled(task: Task, value: boolean) {
  task.enabled = value
  try {
    await $fetch(`/api/admin/tasks/${task.id}`, { method: 'PATCH', headers: authHeaders.value, body: { enabled: value } })
  }
  catch (e) {
    task.enabled = !value
    notice.value = t('tasks.admin.saveError', { message: (e as Error).message })
  }
}

// --- run / rebuild environment -----------------------------------------------

async function runNow(task: Task) {
  busy.value = task.id
  notice.value = ''
  try {
    const res = await $fetch<{ runId: string }>(`/api/tasks/${task.id}/run`, { method: 'POST', headers: authHeaders.value })
    notice.value = t('tasks.admin.runQueued', { id: res.runId.slice(0, 8) })
    await loadRuns()
    // Open the detail at once — otherwise "I ran it and nothing happened".
    openRun(res.runId)
  }
  catch (e) {
    notice.value = (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message
  }
  finally {
    busy.value = ''
  }
}

async function rebuildEnv(task: Task) {
  busy.value = `rebuild-${task.id}`
  notice.value = ''
  try {
    const res = await $fetch<{ envKey: string | null }>(`/api/admin/tasks/${task.id}/rebuild-env`, {
      method: 'POST',
      headers: authHeaders.value,
    })
    notice.value = t('tasks.admin.rebuildDone', { key: res.envKey ?? '—' })
    await Promise.all([loadCache(), loadRuns()])
  }
  catch (e) {
    notice.value = (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message
  }
  finally {
    busy.value = ''
  }
}

// --- triggers ----------------------------------------------------------------

const cronDraft = reactive({ cron: '*/5 * * * *', misfire_policy: 'run' as 'run' | 'skip' })
const hookDraft = reactive({ sync: false })
const newToken = ref('')
const triggerErr = ref('')

const misfireItems = computed(() => [
  { label: t('tasks.admin.misfireRun'), value: 'run' },
  { label: t('tasks.admin.misfireSkip'), value: 'skip' },
])

async function addTrigger(kind: 'cron' | 'webhook') {
  if (!editing.value)
    return
  triggerErr.value = ''
  busy.value = `trigger-${kind}`
  try {
    const body = kind === 'cron'
      ? { kind, cron: cronDraft.cron.trim(), misfire_policy: cronDraft.misfire_policy }
      : { kind, sync: hookDraft.sync }
    const row = await $fetch<Trigger & { token?: string }>(`/api/admin/tasks/${editing.value.id}/triggers`, {
      method: 'POST',
      headers: authHeaders.value,
      body,
    })
    // The raw token arrives only here (the DB keeps a hash) — shown once.
    if (row.token)
      newToken.value = `${window.location.origin}/api/tasks/hook/${row.token}`
    await loadTasks()
    editing.value = tasks.value.find(x => x.id === editing.value?.id) ?? editing.value
  }
  catch (e) {
    triggerErr.value = (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message
  }
  finally {
    busy.value = ''
  }
}

async function toggleTrigger(trigger: Trigger, value: boolean) {
  trigger.enabled = value
  await $fetch(`/api/admin/tasks/triggers/${trigger.id}`, {
    method: 'PATCH',
    headers: authHeaders.value,
    body: { enabled: value },
  }).catch(() => { trigger.enabled = !value })
  await loadTasks()
}

async function removeTrigger(trigger: Trigger) {
  await $fetch(`/api/admin/tasks/triggers/${trigger.id}`, { method: 'DELETE', headers: authHeaders.value })
  await loadTasks()
  editing.value = tasks.value.find(x => x.id === editing.value?.id) ?? null
}

const copied = ref(false)
async function copyToken() {
  await navigator.clipboard?.writeText(newToken.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

// --- presentation ------------------------------------------------------------

/** "in 4 min" / "overdue by 2 h" / "manual only" — one line in the list. */
function nextRunText(task: Task): string {
  const next = nextCronRun(task.triggers, now.value)
  if (!next)
    return t('tasks.admin.nextRunNone')
  return next.inMs >= 0
    ? t('tasks.admin.inTime', { duration: formatDuration(next.inMs) })
    : t('tasks.admin.overdue', { duration: formatDuration(-next.inMs) })
}
const isOverdue = (task: Task) => (nextCronRun(task.triggers, now.value)?.inMs ?? 0) < 0

function statusLabel(status: string): string {
  const key = `tasks.status.${status}`
  return te(key) ? t(key) : status
}
function errorLabel(code?: string | null): string {
  const key = `tasks.error.${code}`
  return code && te(key) ? t(key) : (code ?? '')
}
function runDurationText(run: RunRow): string {
  if (run.result?.durationMs)
    return formatDuration(run.result.durationMs)
  if (!run.finished_at)
    return ''
  return formatDuration(new Date(run.finished_at).getTime() - new Date(run.started_at).getTime())
}
</script>

<template>
  <AdminPage :title="t('tasks.admin.title')" :subtitle="t('tasks.admin.subtitle')">
    <template #actions>
      <UButton icon="i-lucide-plus" :disabled="!runtimes.length" data-action="task-new" @click="openNew">
        {{ t('tasks.admin.new') }}
      </UButton>
    </template>

    <p v-if="loadErr" class="mb-3 text-sm text-error">{{ loadErr }}</p>
    <UAlert
      v-if="!runtimes.length && !loadErr"
      class="mb-3"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('tasks.admin.noRuntimesTitle')"
      :description="t('tasks.admin.noRuntimes')"
    />

    <!-- Environment cache: "the cache eats disk" — the space must be visible -->
    <div v-if="cache.length" class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      <span class="font-medium">{{ t('tasks.admin.cache') }}:</span>
      <span v-for="c in cache" :key="c.runtimes.join(',')" data-testid="cache-line">
        <span class="font-mono">{{ c.runtimes.join(', ') }}</span>
        —
        <template v-if="c.error">
          <span class="text-warning">{{ t('tasks.admin.cacheRunnerDown') }}</span>
        </template>
        <template v-else>
          {{ t('tasks.admin.cacheOf', { used: formatBytes(c.bytes), limit: formatBytes(c.limitBytes) }) }}
          ({{ t('tasks.admin.cacheEnvs', { count: c.envs.length }) }})
        </template>
      </span>
    </div>

    <!-- Definition list: a click anywhere on the row opens the task -->
    <div v-if="!tasks.length && !loadErr" class="rounded ring ring-default p-6 text-center">
      <p class="text-muted">{{ t('tasks.admin.empty') }}</p>
      <p class="mx-auto mt-2 max-w-xl text-sm text-dimmed">{{ t('tasks.admin.emptyHint') }}</p>
    </div>
    <ul v-else class="divide-y divide-default rounded ring ring-default">
      <li
        v-for="task in tasks"
        :key="task.id"
        class="flex cursor-pointer items-center gap-3 p-3 hover:bg-elevated/50"
        data-testid="task-row"
        @click="openTask(task)"
      >
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium text-highlighted">{{ task.name }}</span>
            <!-- For a built-in task the runtime is "builtin" — two badges about the same
                 thing are just noise, so the runtime is shown only for regular ones. -->
            <UBadge v-if="!task.builtin" size="xs" color="neutral" variant="subtle" class="font-mono">{{ task.runtime }}</UBadge>
            <UBadge v-else size="xs" color="primary" variant="subtle" data-testid="builtin-badge">
              {{ t('tasks.admin.builtin') }}
            </UBadge>
            <UBadge v-if="task.min_role === 'admin'" size="xs" color="warning" variant="subtle">
              {{ t('tasks.admin.minRoleAdmin') }}
            </UBadge>
            <UBadge
              v-for="tr in task.triggers.filter(x => x.kind === 'webhook')"
              :key="tr.id"
              size="xs"
              color="info"
              variant="subtle"
            >
              {{ t('tasks.admin.webhookTrigger') }}
            </UBadge>
            <span v-if="!task.enabled" class="text-xs text-dimmed">{{ t('tasks.status.skipped') }}</span>
          </div>
          <div class="flex items-center gap-2 text-xs" :class="isOverdue(task) ? 'text-warning' : 'text-muted'">
            <span v-if="task.entrypoint" class="font-mono">{{ task.entrypoint }}</span>
            <span v-else class="truncate">{{ t('tasks.admin.builtinHint') }}</span>
            <span>·</span>
            <span data-testid="next-run">{{ t('tasks.admin.nextRun') }}: {{ nextRunText(task) }}</span>
          </div>
        </div>

        <!-- In-row actions do not open the task (@click.stop) -->
        <USwitch
          :model-value="task.enabled"
          :aria-label="t('tasks.admin.enabled')"
          data-action="task-toggle"
          @click.stop
          @update:model-value="v => toggleEnabled(task, v)"
        />
        <UButton
          size="xs"
          variant="soft"
          icon="i-lucide-play"
          :loading="busy === task.id"
          :disabled="!task.enabled"
          data-action="task-run"
          @click.stop="runNow(task)"
        >
          {{ t('tasks.admin.runNow') }}
        </UButton>
      </li>
    </ul>

    <p v-if="notice" class="mt-3 text-sm text-muted" data-testid="notice">{{ notice }}</p>

    <!-- Run log -->
    <section class="mt-8">
      <div class="mb-3 flex flex-wrap items-end gap-3">
        <h2 class="text-lg font-medium text-highlighted">{{ t('tasks.runs.title') }}</h2>
        <USelect v-model="filterTask" :items="taskFilterItems" value-key="value" class="ml-auto w-52" />
        <USelect v-model="filterStatus" :items="statusItems" value-key="value" class="w-48" />
        <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" @click="loadRuns()">
          {{ t('tasks.runs.refresh') }}
        </UButton>
      </div>

      <p v-if="!runs.length" class="text-muted">{{ t('tasks.runs.empty') }}</p>
      <ul v-else class="divide-y divide-default rounded ring ring-default">
        <li
          v-for="run in runs"
          :key="run.id"
          class="flex cursor-pointer items-center gap-3 p-3 hover:bg-elevated/50"
          data-testid="run-row"
          @click="openRun(run.id)"
        >
          <UBadge :color="runStatusColor(run.status)" variant="subtle" size="xs">{{ statusLabel(run.status) }}</UBadge>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="truncate text-highlighted">{{ run.label }}</span>
              <span v-if="!run.task_id" class="text-xs text-dimmed">({{ t('tasks.runs.deletedTask') }})</span>
              <UBadge v-if="run.attempt > 1" size="xs" color="warning" variant="subtle">
                {{ t('tasks.runs.attempt', { n: run.attempt }) }}
              </UBadge>
              <UBadge v-if="run.result?.late" size="xs" color="warning" variant="soft">{{ t('tasks.runs.late') }}</UBadge>
            </div>
            <div class="text-xs text-muted">
              {{ new Date(run.started_at).toLocaleString() }}
              <template v-if="runDurationText(run)"> · {{ runDurationText(run) }}</template>
              <template v-if="run.error"> · <span class="text-error">{{ errorLabel(run.error) }}</span></template>
            </div>
          </div>
        </li>
      </ul>
      <UButton v-if="runsHasMore" size="xs" variant="ghost" class="mt-2" @click="loadMoreRuns">
        {{ t('tasks.runs.more') }}
      </UButton>
    </section>

    <!-- Definition: a view that switches to edit -->
    <UModal
      v-model:open="formOpen"
      :title="editing ? editing.name : t('tasks.admin.new')"
      :description="editing && readonlyView ? t('tasks.admin.view') : t('tasks.admin.editing')"
      :ui="{ content: 'w-[56rem] max-w-[94vw] min-w-80 max-h-[92vh] resize overflow-hidden' }"
    >
      <template #body>
        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap gap-3">
            <UFormField :label="t('tasks.admin.name')" class="min-w-64 flex-1">
              <UInput v-model="form.name" :disabled="readonlyView" class="w-full" />
            </UFormField>
            <UFormField v-if="!isBuiltin" :label="t('tasks.admin.runtime')" class="w-40">
              <USelect v-model="form.runtime" :items="runtimeItems" value-key="value" :disabled="readonlyView" />
            </UFormField>
            <UFormField v-if="!isBuiltin" :label="t('tasks.admin.entrypoint')" :help="t('tasks.admin.entrypointHint')" class="w-48">
              <UInput v-model="form.entrypoint" :disabled="readonlyView" class="w-full font-mono" />
            </UFormField>
          </div>

          <!-- Built-in action: instead of an empty body editor — what it does
               and where it takes its destination from (without this the toggle is mute). -->
          <UAlert
            v-if="isBuiltin"
            color="primary"
            variant="subtle"
            icon="i-lucide-hard-drive-download"
            :title="t('tasks.admin.builtinTitle')"
            :description="t(`tasks.admin.builtinAbout.${editing!.builtin}`)"
            data-testid="builtin-about"
          />

          <!-- Multi-file editor: file tabs + one CodeEditor -->
          <UFormField v-if="!isBuiltin" :label="t('tasks.admin.files')" :description="t('tasks.admin.outputHint')">
            <div class="mb-2 flex flex-wrap items-center gap-1">
              <UButton
                v-for="(f, i) in form.files"
                :key="i"
                size="xs"
                :variant="activeFile === i ? 'solid' : 'ghost'"
                :color="f.name === form.entrypoint.trim() ? 'primary' : 'neutral'"
                class="font-mono"
                @click="activeFile = i"
              >
                {{ f.name || t('tasks.admin.fileName') }}
              </UButton>
              <UButton
                v-if="!readonlyView"
                size="xs"
                variant="soft"
                icon="i-lucide-plus"
                data-action="file-add"
                @click="addFile"
              >
                {{ t('tasks.admin.addFile') }}
              </UButton>
            </div>
            <div v-if="form.files[activeFile]" class="flex flex-col gap-2">
              <div v-if="!readonlyView" class="flex gap-2">
                <UInput
                  v-model="form.files[activeFile]!.name"
                  :placeholder="t('tasks.admin.fileName')"
                  class="w-64 font-mono"
                />
                <UButton
                  v-if="form.files.length > 1"
                  size="xs"
                  variant="ghost"
                  color="error"
                  icon="i-lucide-x"
                  :aria-label="t('tasks.admin.removeFile')"
                  @click="removeFile(activeFile)"
                />
              </div>
              <CodeEditor
                v-model="form.files[activeFile]!.body"
                :language="fileLanguage(form.files[activeFile]!.name)"
                :readonly="readonlyView"
              />
            </div>
            <p v-if="!entrypointValid" class="mt-1 text-xs text-warning">{{ t('tasks.admin.entrypointHint') }}</p>
          </UFormField>

          <div v-if="!isBuiltin && (!readonlyView || form.deps || form.deps_lock)" class="flex flex-wrap gap-3">
            <UFormField :label="t('tasks.admin.deps')" :description="t('tasks.admin.depsHint')" class="min-w-64 flex-1">
              <UTextarea v-model="form.deps" :rows="4" :disabled="readonlyView" class="w-full font-mono" />
            </UFormField>
            <UFormField :label="t('tasks.admin.depsLock')" :description="t('tasks.admin.depsLockHint')" class="min-w-64 flex-1">
              <UTextarea v-model="form.deps_lock" :rows="4" :disabled="readonlyView" class="w-full font-mono" />
            </UFormField>
          </div>

          <UFormField v-if="!readonlyView || form.env.length" :label="t('tasks.admin.env')" :description="t('tasks.admin.envHint')">
            <div class="flex flex-col gap-2">
              <div v-for="(e, i) in form.env" :key="i" class="flex gap-2">
                <UInput v-model="e.key" :placeholder="t('tasks.admin.envKey')" :disabled="readonlyView" class="w-48 font-mono" />
                <UInput v-model="e.value" :placeholder="t('tasks.admin.envValue')" :disabled="readonlyView" class="flex-1" />
                <UButton
                  v-if="!readonlyView"
                  icon="i-lucide-x"
                  variant="ghost"
                  color="error"
                  :aria-label="t('tasks.admin.remove')"
                  @click="form.env.splice(i, 1)"
                />
              </div>
              <UButton
                v-if="!readonlyView"
                size="xs"
                variant="soft"
                icon="i-lucide-plus"
                class="self-start"
                @click="form.env.push({ key: '', value: '' })"
              >
                {{ t('tasks.admin.addEnv') }}
              </UButton>
            </div>
          </UFormField>

          <UFormField v-if="!isBuiltin && (!readonlyView || form.cred_refs.length)" :label="t('tasks.admin.credRefs')" :description="t('tasks.admin.credRefsHint')">
            <div class="flex flex-col gap-2">
              <div v-for="(r, i) in form.cred_refs" :key="i" class="flex gap-2">
                <USelect v-model="r.set_id" :items="credSets" value-key="value" :disabled="readonlyView" class="flex-1" />
                <UInput v-model="r.env" :placeholder="t('tasks.admin.credRefEnv')" :disabled="readonlyView" class="w-40 font-mono" />
                <UButton
                  v-if="!readonlyView"
                  icon="i-lucide-x"
                  variant="ghost"
                  color="error"
                  :aria-label="t('tasks.admin.remove')"
                  @click="form.cred_refs.splice(i, 1)"
                />
              </div>
              <UButton
                v-if="!readonlyView"
                size="xs"
                variant="soft"
                icon="i-lucide-plus"
                class="self-start"
                :disabled="!credSets.length"
                @click="form.cred_refs.push({ set_id: credSets[0]?.value ?? '', env: '' })"
              >
                {{ t('tasks.admin.addCredRef') }}
              </UButton>
            </div>
          </UFormField>

          <div class="flex flex-wrap gap-3">
            <UFormField :label="t('tasks.admin.timeout')" :help="t('tasks.admin.timeoutHint')" class="w-40">
              <UInput v-model.number="form.timeout_s" type="number" :disabled="readonlyView" />
            </UFormField>
            <UFormField :label="t('tasks.admin.retries')" class="w-28">
              <UInput v-model.number="form.retries" type="number" :disabled="readonlyView" />
            </UFormField>
            <UFormField :label="t('tasks.admin.backoff')" class="w-28">
              <UInput v-model.number="form.backoff_s" type="number" :disabled="readonlyView" />
            </UFormField>
            <UFormField :label="t('tasks.admin.overlap')" class="w-52">
              <USelect v-model="form.overlap_policy" :items="overlapItems" value-key="value" :disabled="readonlyView" />
            </UFormField>
            <UFormField :label="t('tasks.admin.minRole')" class="w-44">
              <USelect v-model="form.min_role" :items="minRoleItems" value-key="value" :disabled="readonlyView" />
            </UFormField>
          </div>

          <div class="flex flex-wrap gap-3">
            <UFormField :label="t('tasks.admin.sinkUrl')" :help="t('tasks.admin.sinkHint')" class="min-w-64 flex-1">
              <UInput v-model="form.sink_url" :disabled="readonlyView" class="w-full font-mono" placeholder="https://" />
            </UFormField>
            <UFormField :label="t('tasks.admin.sinkOn')" class="w-44">
              <USelect v-model="form.sink_on" :items="sinkOnItems" value-key="value" :disabled="readonlyView || !form.sink_url" />
            </UFormField>
          </div>

          <UCheckbox v-model="form.enabled" :label="t('tasks.admin.enabled')" :disabled="readonlyView" />

          <!-- Triggers: only on an existing task (its id is needed) -->
          <template v-if="editing">
            <UFormField :label="t('tasks.admin.triggers')" :description="t('tasks.admin.triggersHint')">
              <ul v-if="editing.triggers.length" class="mb-2 divide-y divide-default rounded ring ring-default">
                <li v-for="tr in editing.triggers" :key="tr.id" class="flex items-center gap-3 p-2 text-sm">
                  <UBadge size="xs" color="neutral" variant="subtle">
                    {{ tr.kind === 'cron' ? 'cron' : t('tasks.admin.webhookTrigger') }}
                  </UBadge>
                  <span v-if="tr.kind === 'cron'" class="font-mono text-xs">{{ tr.cron }}</span>
                  <span v-if="tr.kind === 'webhook' && tr.sync" class="text-xs text-muted">{{ t('tasks.admin.sync') }}</span>
                  <span v-if="tr.next_run_at" class="text-xs text-muted">
                    {{ new Date(tr.next_run_at).toLocaleString() }}
                  </span>
                  <USwitch
                    :model-value="tr.enabled"
                    :aria-label="t('tasks.admin.enabled')"
                    class="ml-auto"
                    data-action="trigger-toggle"
                    @update:model-value="v => toggleTrigger(tr, v)"
                  />
                  <UButton
                    icon="i-lucide-trash-2"
                    size="xs"
                    variant="ghost"
                    color="error"
                    :aria-label="t('tasks.admin.triggerRemove')"
                    data-action="trigger-remove"
                    @click="removeTrigger(tr)"
                  />
                </li>
              </ul>

              <div class="flex flex-wrap items-end gap-2">
                <UFormField :label="t('tasks.admin.cronExpr')" :help="t('tasks.admin.cronHint')" class="min-w-48 flex-1">
                  <UInput v-model="cronDraft.cron" class="w-full font-mono" />
                </UFormField>
                <UFormField :label="t('tasks.admin.misfire')" class="w-64">
                  <USelect v-model="cronDraft.misfire_policy" :items="misfireItems" value-key="value" />
                </UFormField>
                <UButton
                  size="xs"
                  variant="soft"
                  icon="i-lucide-clock"
                  :loading="busy === 'trigger-cron'"
                  data-action="trigger-add-cron"
                  @click="addTrigger('cron')"
                >
                  {{ t('tasks.admin.addCron') }}
                </UButton>
              </div>

              <div class="mt-2 flex flex-wrap items-center gap-3">
                <UCheckbox v-model="hookDraft.sync" :label="t('tasks.admin.sync')" :description="t('tasks.admin.syncHint')" />
                <UButton
                  size="xs"
                  variant="soft"
                  icon="i-lucide-webhook"
                  :loading="busy === 'trigger-webhook'"
                  data-action="trigger-add-webhook"
                  @click="addTrigger('webhook')"
                >
                  {{ t('tasks.admin.addWebhook') }}
                </UButton>
              </div>

              <!-- The raw token exists exactly once — and that is said plainly -->
              <div v-if="newToken" class="mt-2 rounded bg-elevated p-2" data-testid="webhook-url">
                <p class="text-xs text-warning">{{ t('tasks.admin.tokenOnce') }}</p>
                <div class="mt-1 flex items-center gap-2">
                  <UBadge size="xs" color="neutral" variant="subtle" class="font-mono">POST</UBadge>
                  <code class="min-w-0 flex-1 truncate text-xs">{{ newToken }}</code>
                  <UButton size="xs" variant="ghost" icon="i-lucide-copy" @click="copyToken">
                    {{ copied ? t('tasks.admin.copied') : t('tasks.admin.copy') }}
                  </UButton>
                </div>
                <p class="mt-1 text-xs text-muted">{{ t('tasks.admin.hookPostOnly') }}</p>
              </div>
              <p v-if="triggerErr" class="mt-1 text-sm text-error">{{ triggerErr }}</p>
            </UFormField>
          </template>

          <p v-if="formNotice" class="text-sm text-primary" data-testid="form-notice">{{ formNotice }}</p>
          <p v-if="saveErr" class="text-sm text-error">{{ saveErr }}</p>
        </div>
      </template>

      <template #footer>
        <UButton color="neutral" variant="ghost" @click="formOpen = false">{{ t('tasks.admin.cancel') }}</UButton>
        <UButton
          v-if="editing && readonlyView"
          color="primary"
          icon="i-lucide-pencil"
          data-action="task-edit"
          @click="readonlyView = false"
        >
          {{ t('tasks.admin.edit') }}
        </UButton>
        <UButton
          v-else
          color="primary"
          :disabled="!canSave"
          :loading="busy === 'save'"
          data-action="task-save"
          @click="save"
        >
          {{ t('tasks.admin.save') }}
        </UButton>
        <UButton
          v-if="editing && !isBuiltin"
          variant="ghost"
          icon="i-lucide-hammer"
          :loading="busy === `rebuild-${editing.id}`"
          data-action="task-rebuild-env"
          @click="rebuildEnv(editing)"
        >
          {{ t('tasks.admin.rebuildEnv') }}
        </UButton>
        <UButton
          v-if="editing && !isBuiltin"
          color="error"
          variant="ghost"
          icon="i-lucide-trash-2"
          data-action="task-delete"
          @click="removeTask(editing)"
        >
          {{ t('tasks.admin.delete') }}
        </UButton>
      </template>
    </UModal>

    <TaskRunDetail
      v-model:open="detailOpen"
      :run-id="detailRunId"
      @rerun="id => { loadRuns(); openRun(id) }"
    />
  </AdminPage>
</template>
