<script setup lang="ts">
import type { Device, DeviceCommand, DeviceType, Point, PointContact } from '~/types/board'
import { searchBoard } from '~/utils/boardSearch'
import { resolveDeviceAction } from '~/utils/device-action'

const { t, locale, locales, setLocale } = useI18n()
const localeItems = computed(() =>
  (locales.value as { code: string, name: string }[]).map(l => ({ label: l.name, value: l.code })),
)

const supabase = useSupabaseClient()
const session = useSupabaseSession()
// RBAC UX gate: admin nav + connect/exec for operator+. Real enforcement is
// server-side (requireRole/RLS); here we only hide/block.
const { isAdmin, canOperate } = useRole()
// Drift-inbox unacked count — badge on the admin menu entry.
const inboxCount = ref(0)
async function loadInboxCount() {
  if (!isAdmin.value || !session.value)
    return
  try {
    const rows = await $fetch<{ total: number }[]>('/api/discovery/inbox', {
      headers: { Authorization: `Bearer ${session.value.access_token}` },
    })
    inboxCount.value = rows.reduce((s, p) => s + p.total, 0)
  }
  catch { /* non-fatal: badge just stays 0 */ }
}
onMounted(loadInboxCount)

// Running version + the latest release (server checks GitHub daily) — admins only.
const version = ref<{ current: string, latest: string | null, url: string | null, newer: boolean } | null>(null)
const updateOpen = ref(false)
async function loadVersion() {
  if (!isAdmin.value || !session.value)
    return
  try {
    version.value = await $fetch('/api/admin/version', { headers: { Authorization: `Bearer ${session.value.access_token}` } })
  }
  catch { /* non-fatal: no version line, no badge */ }
}
onMounted(loadVersion)

const adminMenu = computed(() => [[
  { label: t('rbac.navOnboarding'), icon: 'i-lucide-compass', to: '/admin/onboarding' },
  { label: t('rbac.navInbox'), icon: 'i-lucide-inbox', to: '/admin/discovery-inbox', badge: inboxCount.value || undefined },
  { label: t('rbac.navUsers'), icon: 'i-lucide-users', to: '/admin/users' },
  { label: t('rbac.navCredentials'), icon: 'i-lucide-key-round', to: '/admin/credentials' },
  { label: t('rbac.navCommands'), icon: 'i-lucide-terminal', to: '/admin/commands' },
  { label: t('rbac.navTasks'), icon: 'i-lucide-calendar-clock', to: '/admin/tasks' },
  { label: t('rbac.navRunbooks'), icon: 'i-lucide-book-text', to: '/admin/runbooks' },
  { label: t('rbac.navTeach'), icon: 'i-lucide-graduation-cap', to: '/admin/teach' },
  { label: t('rbac.navSignatures'), icon: 'i-lucide-sliders-horizontal', to: '/admin/signatures' },
  { label: t('rbac.navDeviceTypes'), icon: 'i-lucide-box', to: '/admin/device-types' },
  { label: t('rbac.navDevices'), icon: 'i-lucide-hard-drive', to: '/admin/devices' },
  { label: t('rbac.navPoints'), icon: 'i-lucide-map-pin', to: '/admin/points' },
  { label: t('rbac.navImport'), icon: 'i-lucide-upload', to: '/admin/import' },
], version.value
  ? [
      { type: 'label' as const, label: t('update.running', { version: version.value.current }) },
      ...(version.value.newer ? [{ label: t('update.available', { version: version.value.latest }), icon: 'i-lucide-circle-arrow-up', onSelect: () => { updateOpen.value = true } }] : []),
    ]
  : []])

// PostgREST cuts the result at PGRST_DB_MAX_ROWS (self-host = 1000). There are
// already 2101 devices (300 points × 7) → without paging PC/RPi/MikroTik (sort>40) dropped.
// Page through .range() while a page is full. Ordering by sort+id is stable
// across pages (sort alone has duplicates → pages would shift).
async function fetchAllDevices(): Promise<Device[]> {
  const PAGE = 1000
  const cols = 'id,point_id,type_id,label,host,actions,default_action,sort,hostname'
  const all: Device[] = []
  // Ceiling of 50 pages (50k devices) — guards against an endless
  // loop if the server always returns exactly PAGE; raise if needed.
  for (let from = 0; from < 50 * PAGE; from += PAGE) {
    const { data, error } = await supabase
      .from('devices').select(cols).order('sort').order('id')
      .range(from, from + PAGE - 1)
    if (error)
      throw createError({ statusMessage: error.message })
    all.push(...(data ?? []) as Device[])
    if (!data || data.length < PAGE)
      break
  }
  return all
}

const { data: board, refresh } = await useAsyncData('board', async () => {
  // points (301) and device_types (5) — under the 1000 ceiling, a single query is fine.
  // Points will also hit this ceiling at >1000 points — then wrap them
  // in the same paginator (YAGNI for now).
  const [pts, types, devices] = await Promise.all([
    supabase.from('points').select('id,number,address,subnet,note,scan_cadence_minutes,next_scan_at').order('number'),
    supabase.from('device_types').select('id,slug,name,icon,color,default_action,sort'),
    fetchAllDevices(),
  ])
  const firstError = pts.error ?? types.error
  if (firstError)
    throw createError({ statusMessage: firstError.message })
  return {
    points: (pts.data ?? []) as Point[],
    devices,
    types: (types.data ?? []) as DeviceType[],
  }
})

// SPA: the first fetch in setup can outrun session restore (RLS → empty).
// Refetch as soon as the token appears.
watch(session, (s, prev) => {
  if (s && !prev) {
    refresh()
    loadInboxCount()
    loadVersion()
  }
})

const typeById = computed(() => new Map(board.value?.types.map(t => [t.id, t]) ?? []))
const devicesByPoint = computed(() => {
  const types = typeById.value
  const map = new Map<string, Device[]>()
  for (const d of board.value?.devices ?? []) {
    const list = map.get(d.point_id) ?? []
    list.push(d)
    map.set(d.point_id, list)
  }
  // Button order = type sort (edited on /admin/device-types), tie-break by
  // label numeric-aware ("Till 2" before "Till 10"). device.sort=0 for all
  // imported/discovered devices → it does not group by type on its own.
  for (const list of map.values()) {
    list.sort((a, b) =>
      (types.get(a.type_id)?.sort ?? 0) - (types.get(b.type_id)?.sort ?? 0)
      || a.label.localeCompare(b.label, undefined, { numeric: true }))
  }
  return map
})

// --- Search-first ------------------------------------------------------
// Runbooks for search — lazily on the first non-empty query (not in the
// board fetch: most lookups are by №/address, runbooks are not needed then).
const runbooks = ref<{ type_id: string | null, point_id: string | null, title: string, body: string }[] | null>(null)
async function ensureRunbooks() {
  if (runbooks.value)
    return
  const { data } = await supabase.from('runbooks').select('type_id,point_id,title,body')
  runbooks.value = data ?? []
}

// runbook → points for search. Scope as services/runbooks.applicableRunbooks
// (0014), but global runbooks (both fk null) are deliberately excluded: they
// apply to every point → as a search signal they single out nothing (a query
// on a global runbook would highlight all 300 points = noise). Only point- and
// type-specific ones discriminate. The card (PointHealthCard) shows global ones
// for reading — a different goal, so the scope mismatch is intentional.
const runbooksByPoint = computed(() => {
  const map = new Map<string, { title: string, body: string }[]>()
  if (!runbooks.value)
    return map
  const pointsByType = new Map<string, Set<string>>()
  for (const [pid, devs] of devicesByPoint.value) {
    for (const d of devs) {
      const s = pointsByType.get(d.type_id) ?? new Set<string>()
      s.add(pid)
      pointsByType.set(d.type_id, s)
    }
  }
  const add = (pid: string, r: { title: string, body: string }) => {
    const l = map.get(pid) ?? []
    l.push(r)
    map.set(pid, l)
  }
  for (const r of runbooks.value) {
    if (r.point_id)
      add(r.point_id, r)
    else if (r.type_id)
      for (const pid of pointsByType.get(r.type_id) ?? [])
        add(pid, r)
    // global (both null) — do not discriminate, skip (see comment above)
  }
  return map
})

// Contacts for search — lazily, same as runbooks: most lookups are by
// №/address. ~300 points × a few contacts — under the PGRST 1000 ceiling,
// no paginator needed (unlike devices).
const contacts = ref<PointContact[] | null>(null)
async function ensureContacts() {
  if (contacts.value)
    return
  const { data } = await supabase.from('point_contacts').select('id,point_id,kind,value,value_norm,label,sort')
  contacts.value = (data ?? []) as PointContact[]
}

const contactsByPoint = computed(() => {
  const map = new Map<string, PointContact[]>()
  for (const c of contacts.value ?? []) {
    const list = map.get(c.point_id) ?? []
    list.push(c)
    map.set(c.point_id, list)
  }
  return map
})

// Phone-match tail — the same value the BFF lookup reads
// (runtimeConfig.public). Empty = exact match only (no domain default).
const phoneMatchTail = computed(() => {
  const raw = useRuntimeConfig().public.phoneMatchTail as string | undefined
  const n = Number(raw)
  return raw && Number.isInteger(n) && n > 0 ? n : undefined
})

const query = ref('')
watch(query, (q) => { // runbooks and contacts — both lazy
  if (q.trim()) {
    ensureRunbooks()
    ensureContacts()
  }
})
const results = computed(() => searchBoard(query.value, {
  points: board.value?.points ?? [],
  devicesByPoint: devicesByPoint.value,
  runbooksByPoint: runbooksByPoint.value,
  contactsByPoint: contactsByPoint.value,
  phoneMatchTail: phoneMatchTail.value,
}))
const filteredPoints = computed(() => results.value.map(r => r.point))
const matchReasonById = computed(() => new Map(results.value.map(r => [r.point.id, r.matchReason])))

// Keyboard navigation: ↑↓ through results, Enter expands the highlighted one
// (or the only one), Esc clears. Highlight scroll/expand — imperatively in PointTree.
const treeRef = useTemplateRef<{ expand: (id: string) => void }>('treeRef')
const searchInput = useTemplateRef<{ $el: HTMLElement }>('searchInput')
const highlightedIndex = ref(-1)
watch(results, (r) => {
  highlightedIndex.value = r.length ? 0 : -1
  if (r.length === 1) // single match → auto-expand
    nextTick(() => treeRef.value?.expand(r[0]!.point.id))
})
const highlightedId = computed(() => results.value[highlightedIndex.value]?.point.id ?? null)

function focusSearch() {
  if (railed.value)
    toggleRail() // hotkey from the collapsed sidebar — expand first
  nextTick(() => searchInput.value?.$el?.querySelector('input')?.focus())
}
function isEditable(target: EventTarget | null) {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
function onGlobalKey(e: KeyboardEvent) { // / and Ctrl+K focus, guarded against fields
  if ((e.key === '/' && !isEditable(e.target)) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
    e.preventDefault()
    focusSearch()
  }
}
function onSearchKeydown(e: KeyboardEvent) {
  const n = results.value.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    highlightedIndex.value = n ? (highlightedIndex.value + 1) % n : -1
  }
  else if (e.key === 'ArrowUp') {
    e.preventDefault()
    highlightedIndex.value = n ? (highlightedIndex.value - 1 + n) % n : -1
  }
  else if (e.key === 'Enter') {
    e.preventDefault()
    const target = results.value[highlightedIndex.value]
    if (target)
      treeRef.value?.expand(target.point.id)
  }
  else if (e.key === 'Escape') {
    query.value = ''
  }
}
onMounted(() => {
  document.addEventListener('keydown', onGlobalKey)
  focusSearch() // autofocus on mount (not behind RLS — nothing to wait for)
})
onBeforeUnmount(() => document.removeEventListener('keydown', onGlobalKey))

// Sessions in the split grid + sidebar layout
const { openPane } = useSessionGrid()
const { width, railed, mode, setWidth, toggleRail } = useBoardLayout()

const RAIL_PX = 48
const sidebarWidthCss = computed(() => {
  if (mode.value === 'full')
    return '100%'
  if (railed.value)
    return `${RAIL_PX}px`
  return `${width.value}px`
})

// Splitter: drag the edge → setWidth (clamp inside the composable). The sidebar
// is on the left, so width = clientX. While dragging: (1) an overlay on top catches
// pointer events even over a session iframe/terminal (otherwise the drag breaks),
// (2) the width transition is off (no rubber-band lag behind the cursor).
const dragging = ref(false)
function startDrag(e: PointerEvent) {
  e.preventDefault()
  dragging.value = true
  const move = (ev: PointerEvent) => setWidth(ev.clientX)
  const up = () => {
    dragging.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

const menu = ref<{ device: Device, x: number, y: number } | null>(null)

// Auto-discovery: drawer on a point
const discoverPoint = ref<Point | null>(null)
const discoverOpen = ref(false)
function onDiscover(point: Point) {
  discoverPoint.value = point
  discoverOpen.value = true
}

// Point card → 'card' pane in the split grid. The panel auto-probes on
// open; it fetches inventory/status by pointId itself.
function onCard(point: Point) {
  openPane({ kind: 'card', title: t('board.health.paneTitle', { n: point.number }), pointId: point.id })
}

// Default action = data: device override → type default, and the result
// must be among the device's protocols — otherwise a click opened a panel for a
// protocol the device does not support (utils/device-action, found 2026-09-17).
function resolvedAction(device: Device, action?: string): string {
  return resolveDeviceAction(device, action, typeById.value.get(device.type_id)?.default_action)
}

// "No credential" modal: shown instead of opening the panel when no
// binding resolves for (device, action).
const credMissing = ref<{ label: string, action: string } | null>(null)

async function openSession(device: Device, action?: string) {
  menu.value = null
  if (!canOperate.value) { // a viewer does not connect (the server also 403s/closes the ws)
    alert(t('rbac.insufficientRole'))
    return
  }
  const act = resolvedAction(device, action)
  // SSH → xterm panel; vnc/rdp → guac panel — both are
  // common-js ws bridges, opened directly by deviceId+action, no fetch.
  if (act === 'ssh' || act === 'vnc' || act === 'rdp') {
    // Credential pre-check before opening the panel: no resolvable binding →
    // a modal with instructions, the panel is not opened (otherwise guacd/ssh drop
    // the connection with an opaque error). Fail-open: check unavailable → let through
    // (the ws bridge stays the real gate). Bearer is required (gated routes skip the cookie).
    const { hasCred } = await $fetch<{ hasCred: boolean }>(`/api/remote-session/${device.id}/cred-check`, {
      query: { action: act },
      headers: { Authorization: `Bearer ${session.value?.access_token}` },
    }).catch(() => ({ hasCred: true }))
    if (!hasCred) {
      credMissing.value = { label: device.label, action: act }
      return
    }
    if (act === 'ssh')
      openPane({ kind: 'ssh', title: `${device.label} (ssh)`, deviceId: device.id })
    else
      openPane({ kind: 'guac', title: `${device.label} (${act})`, deviceId: device.id, action: act })
    return
  }
  // web → external link (WebFig does not work in an iframe: the router's X-Frame-Options)
  const res = await $fetch<{ kind: string, sessionUrl: string }>('/api/remote-session', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.value?.access_token}` },
    body: { deviceId: device.id, ...(action ? { action } : {}) },
  }).catch((e) => {
    alert(t('board.sessionOpenError', { message: e.data?.statusMessage ?? e.message }))
    return null
  })
  if (res?.kind === 'web')
    window.open(res.sessionUrl, '_blank')
}

// Files (SFTP panel) — the same operator gate as sessions
// (the BFF endpoints require operator).
function openFiles(device: Device) {
  menu.value = null
  if (!canOperate.value) {
    alert(t('rbac.insufficientRole'))
    return
  }
  openPane({ kind: 'sftp', title: `${device.label} (${t('sftp.menuOpen')})`, deviceId: device.id })
}

// --- type commands in the context menu -----------------------------------
const menuCommands = ref<DeviceCommand[]>([])
watch(menu, async (m) => {
  menuCommands.value = []
  if (!m)
    return
  const all = await $fetch<DeviceCommand[]>('/api/commands', {
    query: { typeId: m.device.type_id },
    headers: { Authorization: `Bearer ${session.value?.access_token}` },
  }).catch(() => []) // a menu without commands is not critical
  // Menu = actions; probe commands (Tier-B) are not clickable items
  menuCommands.value = all.filter(c => c.purpose === 'action')
})

interface TaskRun {
  id: string
  label: string
  status: 'running' | 'done' | 'failed'
  error?: string | null
  result?: { stdout?: string, stderr?: string, exitCode?: number | null } | null
  started_at?: string
  finished_at?: string | null
}
const resultRun = ref<TaskRun | null>(null)
const resultOpen = ref(false)
const pendingConfirm = ref<{ device: Device, command: DeviceCommand } | null>(null)
// Pre-exec form: a command with params → collect formValues before running.
// Cancel closes without exec; Submit calls execCommand with formValues.
const pendingParams = ref<{ device: Device, command: DeviceCommand } | null>(null)
const paramValues = ref<Record<string, string>>({})

function onRunCommand(commandId: string) {
  const device = menu.value?.device
  const command = menuCommands.value.find(c => c.id === commandId)
  menu.value = null
  if (!device || !command)
    return
  if (command.params?.length) { // params → form (it is the confirmation point itself)
    paramValues.value = Object.fromEntries(command.params.map(p => [p.key, '']))
    pendingParams.value = { device, command }
  }
  else if (command.confirm) { // destructive → confirm before running
    pendingConfirm.value = { device, command }
  }
  else {
    execCommand(device, command)
  }
}

function submitParams() {
  const p = pendingParams.value
  if (!p)
    return
  pendingParams.value = null
  execCommand(p.device, p.command, { ...paramValues.value })
}

async function execCommand(device: Device, command: DeviceCommand, formValues?: Record<string, string>) {
  pendingConfirm.value = null
  if (!canOperate.value) { // a viewer does not run commands (the server also 403s)
    alert(t('rbac.insufficientRole'))
    return
  }
  try {
    const { executionId } = await $fetch<{ executionId: string }>(`/api/commands/${device.id}/exec`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.value?.access_token}` },
      body: { commandId: command.id, ...(formValues ? { formValues } : {}) },
    })
    resultRun.value = { id: executionId, label: command.name, status: 'running' }
    resultOpen.value = true
    pollRun(executionId) // live update running→done/failed without a reload
  }
  catch (e) {
    alert(t('board.sessionOpenError', { message: (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message }))
  }
}

// The client reads its own task_run row (RLS actor=self). Polling, NOT realtime
// postgres_changes: a command often finishes (~200ms) before the realtime channel
// connects → the update event is missed (race). Polling has no race.
// Cap ~10 min; long commands would need live streaming over ws, not built yet.
async function pollRun(id: string) {
  for (let i = 0; i < 1000 && resultOpen.value; i++) {
    const { data } = await supabase.from('task_run')
      .select('id,label,status,error,result,started_at,finished_at').eq('id', id).maybeSingle()
    if (data) {
      resultRun.value = data as TaskRun
      if (data.status !== 'running')
        return
    }
    await new Promise(r => setTimeout(r, 600))
  }
}

async function signOut() {
  await supabase.auth.signOut()
  await navigateTo('/login')
}
</script>

<template>
  <div class="flex flex-col h-screen bg-default">
    <header class="flex items-center gap-4 px-5 py-2.5 bg-muted border-b border-default">
      <h1 class="m-0 text-[17px] font-semibold text-highlighted">SmartAnyKey</h1>
      <UDropdownMenu v-if="isAdmin" :items="adminMenu">
        <UButton
          variant="ghost"
          color="neutral"
          size="sm"
          icon="i-lucide-shield"
          :label="t('rbac.adminMenu')"
          trailing-icon="i-lucide-chevron-down"
        />
      </UDropdownMenu>
      <UButton
        v-if="isAdmin && version?.newer"
        size="xs"
        color="warning"
        variant="soft"
        icon="i-lucide-circle-arrow-up"
        data-action="update-badge"
        @click="updateOpen = true"
      >
        {{ t('update.available', { version: version.latest }) }}
      </UButton>
      <USelect
        :model-value="locale"
        :items="localeItems"
        :aria-label="t('board.language')"
        class="ml-auto w-36"
        @update:model-value="setLocale($event)"
      />
      <UButton color="neutral" variant="ghost" to="/account" icon="i-lucide-shield">
        {{ t('mfa.title') }}
      </UButton>
      <UButton color="neutral" variant="ghost" @click="signOut">
        {{ t('board.signOut') }}
      </UButton>
    </header>

    <!-- Onboarding banner: empty board (no points) → guided wizard. -->
    <div
      v-if="isAdmin && board && !board.points.length"
      class="flex flex-wrap items-center gap-3 border-b border-default bg-elevated px-5 py-2.5"
    >
      <UIcon name="i-lucide-compass" class="text-primary" />
      <span class="text-sm text-muted">{{ t('onboarding.banner.body') }}</span>
      <UButton size="sm" color="primary" icon="i-lucide-arrow-right" class="ml-auto" to="/admin/onboarding">
        {{ t('onboarding.banner.start') }}
      </UButton>
    </div>

    <div class="flex-1 flex min-h-0">
      <aside
        class="shrink-0 flex flex-col overflow-hidden border-r border-default"
        :class="{ 'transition-[width] duration-200 ease-out': !dragging }"
        :style="{ width: sidebarWidthCss }"
      >
        <!-- rail: collapsed sidebar (mode split) -->
        <template v-if="mode === 'split' && railed">
          <UButton
            icon="i-lucide-panel-left-open"
            variant="ghost"
            color="neutral"
            :aria-label="t('board.railExpand')"
            class="m-1"
            @click="toggleRail"
          />
          <span class="text-muted text-[11px] font-mono text-center">{{ results.length }}</span>
        </template>

        <!-- expanded sidebar: search + tree -->
        <template v-else>
          <div class="flex items-center gap-2 px-2 py-2 border-b border-default">
            <UInput
              ref="searchInput"
              v-model="query"
              type="search"
              :placeholder="t('board.searchPlaceholder')"
              icon="i-lucide-search"
              class="flex-1 min-w-0"
              @keydown="onSearchKeydown"
            />
            <span class="shrink-0 text-muted text-[13px] font-mono">{{ t('board.pointsCount', results.length) }}</span>
            <UButton
              v-if="mode === 'split'"
              icon="i-lucide-panel-left-close"
              size="sm"
              variant="ghost"
              color="neutral"
              :aria-label="t('board.railCollapse')"
              @click="toggleRail"
            />
          </div>
          <PointTree
            ref="treeRef"
            :points="filteredPoints"
            :type-by-id="typeById"
            :devices-by-point="devicesByPoint"
            :highlighted-id="highlightedId"
            :match-reason-by-id="matchReasonById"
            class="flex-1 min-h-0"
            @open="openSession"
            @menu="menu = $event"
            @discover="onDiscover"
            @card="onCard"
          />
        </template>
      </aside>

      <!-- splitter (split & not rail only): a thin visible line + a wider grab
           zone (padding via px-1, -mx-1 so it does not eat the layout) -->
      <div
        v-if="mode === 'split' && !railed"
        class="group shrink-0 -mx-1 px-1 cursor-col-resize touch-none z-10"
        @pointerdown="startDrag"
      >
        <div class="w-0.5 h-full bg-border group-hover:bg-primary" :class="{ 'bg-primary': dragging }" />
      </div>

      <!-- overlay while dragging: catches the pointer over an iframe/terminal -->
      <div v-if="dragging" class="fixed inset-0 z-50 cursor-col-resize select-none" />

      <!-- session area — only when a session is open (mode split); in full the
           sidebar is full-screen, the grid is not in the DOM (not "off-screen") -->
      <div v-if="mode === 'split'" class="flex-1 min-w-0">
        <SessionGrid />
      </div>
    </div>

    <DeviceContextMenu
      v-if="menu"
      v-bind="menu"
      :commands="menuCommands"
      @select="openSession(menu!.device, $event)"
      @files="openFiles(menu!.device)"
      @run-command="onRunCommand"
      @close="menu = null"
    />

    <!-- confirmation for confirm commands -->
    <UModal
      :open="!!pendingConfirm"
      :title="t('commands.confirmTitle')"
      @update:open="v => { if (!v) pendingConfirm = null }"
    >
      <template #body>
        <p>{{ t('commands.confirmBody', { name: pendingConfirm?.command.name, device: pendingConfirm?.device.label }) }}</p>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="pendingConfirm = null">{{ t('commands.cancel') }}</UButton>
        <UButton color="primary" @click="execCommand(pendingConfirm!.device, pendingConfirm!.command)">{{ t('commands.run') }}</UButton>
      </template>
    </UModal>

    <UModal v-model:open="updateOpen" :title="t('update.title', { version: version?.latest })">
      <template #body>
        <div class="flex flex-col gap-3 text-sm" data-testid="update-modal">
          <p>{{ t('update.current', { version: version?.current }) }}</p>
          <ULink v-if="version?.url" :to="version.url" target="_blank" class="text-primary underline">{{ t('update.notes') }}</ULink>
          <p>{{ t('update.how') }}</p>
          <pre class="rounded bg-elevated p-3 font-mono text-xs">git pull
SAK_TAG={{ version?.latest }} ./docker/install.sh --update</pre>
          <p class="text-muted">{{ t('update.keeps') }}</p>
        </div>
      </template>
    </UModal>

    <!-- pre-exec parameter form: Cancel → exec is not called -->
    <UModal
      :open="!!pendingParams"
      :title="pendingParams?.command.name"
      @update:open="v => { if (!v) pendingParams = null }"
    >
      <template #body>
        <p class="mb-3 text-sm text-muted">{{ t('commands.paramFormSubtitle') }}</p>
        <div class="flex flex-col gap-3">
          <UFormField
            v-for="p in pendingParams?.command.params ?? []"
            :key="p.key"
            :label="p.label || p.key"
          >
            <UInput v-model="paramValues[p.key]!" :type="p.type === 'number' ? 'number' : 'text'" class="w-full" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="pendingParams = null">{{ t('commands.cancel') }}</UButton>
        <UButton color="primary" @click="submitParams">{{ t('commands.run') }}</UButton>
      </template>
    </UModal>

    <!-- no credential for the action → instructions on how to fix it -->
    <UModal
      :open="!!credMissing"
      :title="t('credMissing.title')"
      @update:open="v => { if (!v) credMissing = null }"
    >
      <template #body>
        <p class="mb-2">{{ t('credMissing.body', { action: credMissing?.action, device: credMissing?.label }) }}</p>
        <ol class="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>{{ t('credMissing.step1') }}</li>
          <li>{{ t('credMissing.step2', { action: credMissing?.action }) }}</li>
        </ol>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="credMissing = null">{{ t('credMissing.close') }}</UButton>
        <UButton color="primary" icon="i-lucide-key-round" to="/admin/credentials">{{ t('credMissing.goto') }}</UButton>
      </template>
    </UModal>

    <CommandResultModal :run="resultRun" :open="resultOpen" @update:open="resultOpen = $event" />

    <DiscoverDrawer
      :point="discoverPoint"
      :open="discoverOpen"
      :types="board?.types ?? []"
      @update:open="discoverOpen = $event"
      @confirmed="refresh"
      @scheduled="refresh"
    />
  </div>
</template>
