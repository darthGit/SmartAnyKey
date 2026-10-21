<script setup lang="ts">
// Point card: pane kind 'card' in the split grid. Inventory
// (the point's devices + subnet) + on-demand TCP-probe status (ADR-005 L0). Self-
// sufficient panel: fetches its own inventory/status by pointId (as SshTerminal by
// deviceId), independent of index.vue board reactivity. Tailwind-only (ADR-004).
import { marked } from 'marked'
import type { Runbook } from '~/types/board'

const props = defineProps<{ pointId: string }>()
const { t } = useI18n()
const supabase = useSupabaseClient()
const session = useSupabaseSession()
const { canOperate } = useRole()
const authHeaders = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

interface Dev {
  id: string
  label: string
  host: string
  type_id: string
  actions: string[]
  default_action: string | null
  // Observed name: a fact, not a label — it cannot be
  // edited, only accepted as `label` (admin).
  hostname: string | null
  hostname_source: string | null
  hostname_at: string | null
  device_types: { icon: string, name: string, color: string, default_action: string }
}
type Status = 'up' | 'down' | 'unknown'
interface StatusView { status: Status, latency_ms: number | null, checked_at: number }

const point = ref<{ number: number, subnet: string } | null>(null)
const devices = ref<Dev[]>([])
const statuses = ref<Record<string, StatusView>>({})
const checkedAt = ref<number | null>(null)
const probing = ref(false)

// Notes + runbooks (tier Mid).
const NOTE_MAX = 2000
const note = ref('')
const noteSaving = ref(false)
const noteError = ref('')
const runbooks = ref<Runbook[]>([])

// ponytail: marked without sanitize; runbook authoring is admin only (requireRole
// admin, trusted). Add DOMPurify if authoring is ever opened to operators.
function renderMd(body: string): string {
  return marked.parse(body, { async: false, gfm: true })
}

async function saveNote(): Promise<void> {
  noteSaving.value = true
  noteError.value = ''
  try {
    await $fetch(`/api/points/${props.pointId}/note`, {
      method: 'PATCH', headers: authHeaders.value, body: { note: note.value },
    })
  }
  catch {
    noteError.value = t('board.notes.saveError')
  }
  finally {
    noteSaving.value = false
  }
}

// --- Observed device name ---
// `label` is the human label, `hostname` is what the machine says about itself. One
// NEVER turns into the other automatically: copying only via the "Accept as name" click
// (admin — renaming a device is an admin action, ADR-013).
const { isAdmin } = useRole()
const hostnameBusy = ref<string | null>(null)
const hostnameError = ref<Record<string, string>>({})

async function checkHostname(d: Dev): Promise<void> {
  hostnameBusy.value = d.id
  hostnameError.value[d.id] = ''
  try {
    const res = await $fetch<{ status: string, hostname?: string, source?: string, at?: string }>(
      `/api/devices/${d.id}/hostname`, { method: 'POST', headers: authHeaders.value },
    )
    if (res.status === 'skipped') {
      hostnameError.value[d.id] = t('board.hostname.noSsh')
      return
    }
    d.hostname = res.hostname ?? d.hostname
    d.hostname_source = res.source ?? d.hostname_source
    d.hostname_at = res.at ?? d.hostname_at
  }
  catch {
    hostnameError.value[d.id] = t('board.hostname.checkFailed')
  }
  finally {
    hostnameBusy.value = null
  }
}

// The only path by which the observed name affects the label. The writer is the existing
// devices admin route; there is no new operator path for writing `label`.
async function acceptHostname(d: Dev): Promise<void> {
  if (!d.hostname)
    return
  hostnameBusy.value = d.id
  try {
    await $fetch(`/api/admin/devices/${d.id}`, {
      method: 'PATCH', headers: authHeaders.value, body: { label: d.hostname },
    })
    d.label = d.hostname
  }
  catch {
    hostnameError.value[d.id] = t('board.hostname.acceptFailed')
  }
  finally {
    hostnameBusy.value = null
  }
}

const aggregate = computed<'all-up' | 'has-down' | 'not-probed'>(() => {
  const present = devices.value.map(d => statuses.value[d.id]?.status).filter(Boolean) as Status[]
  if (!present.length)
    return 'not-probed'
  return present.every(s => s === 'up') ? 'all-up' : 'has-down'
})

const badge = computed(() => ({
  'all-up': { color: 'success' as const, label: t('board.health.allUp') },
  'has-down': { color: 'error' as const, label: t('board.health.hasDown') },
  'not-probed': { color: 'neutral' as const, label: t('board.health.notProbed') },
}[aggregate.value]))

const checkedAgo = computed(() => {
  if (checkedAt.value == null)
    return null
  return t('board.health.checkedAgo', { n: Math.max(0, Math.round((Date.now() - checkedAt.value) / 1000)) })
})

function apply(rows: { device_id: string, status: Status, latency_ms: number | null, checked_at: number }[]): void {
  const map: Record<string, StatusView> = {}
  let latest: number | null = null
  for (const r of rows) {
    map[r.device_id] = { status: r.status, latency_ms: r.latency_ms, checked_at: r.checked_at }
    latest = latest == null ? r.checked_at : Math.max(latest, r.checked_at)
  }
  statuses.value = map
  checkedAt.value = latest
}

async function loadInventory(): Promise<void> {
  const [{ data: p }, { data: devs }] = await Promise.all([
    supabase.from('points').select('number,subnet,note').eq('id', props.pointId).maybeSingle(),
    supabase.from('devices')
      .select('id,label,host,type_id,actions,default_action,hostname,hostname_source,hostname_at,device_types(icon,name,color,default_action)')
      .eq('point_id', props.pointId).order('sort'),
  ])
  point.value = (p as typeof point.value) ?? null
  note.value = (p as { note?: string } | null)?.note ?? ''
  devices.value = (devs ?? []) as unknown as Dev[]
  // Runbooks: BFF read route (requireUser + Bearer).
  runbooks.value = await $fetch<Runbook[]>('/api/runbooks', {
    query: { pointId: props.pointId }, headers: authHeaders.value,
  }).catch(() => [])
}

// Any authenticated user reads the cache (RLS device_status) — fallback for viewer.
async function readCached(): Promise<void> {
  if (!devices.value.length)
    return
  const { data } = await supabase.from('device_status')
    .select('device_id,status,latency_ms,checked_at')
    .in('device_id', devices.value.map(d => d.id))
  apply((data ?? []).map(r => ({
    device_id: r.device_id as string,
    status: r.status as Status,
    latency_ms: r.latency_ms as number | null,
    checked_at: new Date(r.checked_at as string).getTime(),
  })))
}

// Probe: POST operator route. 403 (viewer — no right to probe) → show the cache.
// The gate is on the server, not on canOperate (the role loads asynchronously — a
// race), so init always tries POST instead of branching on canOperate.
async function refresh(force: boolean): Promise<void> {
  probing.value = true
  try {
    const res = await $fetch<{ devices: { device_id: string, status: Status, latency_ms: number | null, checked_at: number }[] }>(
      `/api/points/${props.pointId}/probe`,
      { method: 'POST', headers: { Authorization: `Bearer ${session.value?.access_token}` }, body: { force } },
    )
    apply(res.devices)
  }
  catch {
    await readCached()
  }
  finally {
    probing.value = false
  }
}

async function init(): Promise<void> {
  await loadInventory()
  await refresh(false)
}

// Real-time toggle: while on, probes run back to back (the next round right
// after the previous + a short LIVE_GAP_MS breather), not on a fixed interval.
// The cadence adapts to the network: all alive → a round of ~tens of ms → ~1s;
// something down → the round hits the TCP timeout (3s). This is the most "realtime" within
// on-demand ADR-005 L0 (NOT a server background job); real push (ws/SSE) is L2.
// Probes are sequential (await), so overlap is impossible by construction.
// ponytail: LIVE_GAP_MS is fixed; move it to the UI if someone asks to tune the pace.
const LIVE_GAP_MS = 1000
const live = ref(false)
let liveGen = 0 // generation token: incrementing stops the previous loop (toggle/unmount)
async function liveLoop(gen: number): Promise<void> {
  while (live.value && gen === liveGen) {
    await refresh(true)
    if (!(live.value && gen === liveGen))
      break
    await new Promise(r => setTimeout(r, LIVE_GAP_MS))
  }
}
watch(live, (on) => {
  liveGen++
  if (on)
    liveLoop(liveGen)
})
onScopeDispose(() => { liveGen++ })

// SPA: the first fetch in setup can outrun session restore (RLS → empty) —
// wait for the token.
watch(session, (s, prev) => { if (s && !prev) init() }, { immediate: true })
</script>

<template>
  <div class="flex flex-col h-full overflow-y-auto bg-default p-3 gap-3">
    <div class="flex items-center gap-2">
      <UBadge :color="badge.color" variant="subtle">{{ badge.label }}</UBadge>
      <span v-if="checkedAgo" class="text-xs text-muted">{{ checkedAgo }}</span>
      <div v-if="canOperate" class="ml-auto flex items-center gap-2">
        <USwitch v-model="live" size="xs" :label="t('board.health.live')" />
        <UButton
          icon="i-lucide-refresh-cw"
          size="xs"
          variant="ghost"
          color="neutral"
          :loading="probing"
          :aria-label="t('board.health.refresh')"
          :title="t('board.health.refresh')"
          @click="refresh(true)"
        />
      </div>
    </div>

    <div v-if="point" class="flex items-center gap-2">
      <span class="text-xs text-muted font-mono">{{ point.subnet }}</span>
      <UButton
        v-if="isAdmin"
        :to="`/admin/devices?point=${point.number}`"
        size="xs"
        variant="link"
        icon="i-lucide-hard-drive"
        class="ml-auto"
      >
        {{ t('board.health.manageDevices') }}
      </UButton>
    </div>

    <div class="flex flex-col gap-1">
      <div
        v-for="d in devices"
        :key="d.id"
        class="flex flex-col gap-1 rounded border border-default px-2 py-1.5 text-sm"
      >
        <div class="flex items-center gap-2">
          <span class="leading-none">{{ resolveDeviceIcon(d.device_types.icon) }}</span>
          <span class="min-w-0 truncate">{{ d.label }}</span>
          <span class="shrink-0 text-muted font-mono text-xs">{{ d.host }}</span>
          <span class="ml-auto shrink-0 flex items-center gap-1.5">
          <template v-if="statuses[d.id]">
            <span
              class="inline-block size-2 rounded-full"
              :class="{
                'bg-success': statuses[d.id]!.status === 'up',
                'bg-error': statuses[d.id]!.status === 'down',
                'bg-muted': statuses[d.id]!.status === 'unknown',
              }"
            />
            <span class="text-xs" :class="statuses[d.id]!.status === 'up' ? 'text-success' : 'text-error'">
              {{ statuses[d.id]!.status === 'up' ? t('board.health.up') : t('board.health.down') }}
            </span>
            <span v-if="statuses[d.id]!.latency_ms != null" class="text-xs text-muted font-mono">
              {{ statuses[d.id]!.latency_ms }}ms
            </span>
          </template>
            <span v-else class="text-xs text-muted">{{ probing ? t('board.health.probing') : '—' }}</span>
          </span>
        </div>

        <!-- Observed name: a fact, not a label. Tech label
             (mono, uppercase key). A mismatch with `label` is
             visible to anyone; only an admin can copy it into the label. -->
        <div class="flex items-center gap-1.5 text-[10px] text-muted font-mono">
          <span class="uppercase tracking-wider opacity-70">{{ t('board.hostname.label') }}</span>
          <template v-if="d.hostname">
            <span
              class="truncate"
              :class="hostnameMismatch(d.label, d.hostname) ? 'text-warning' : ''"
              :data-testid="`hostname-${d.id}`"
            >{{ d.hostname }}</span>
            <span class="shrink-0 opacity-70">{{ t(`board.hostname.source.${d.hostname_source ?? 'ptr'}`) }}</span>
            <span v-if="d.hostname_at" class="shrink-0 opacity-70">{{ new Date(d.hostname_at).toLocaleDateString() }}</span>
            <UIcon
              v-if="hostnameMismatch(d.label, d.hostname)"
              name="i-lucide-triangle-alert"
              class="shrink-0 text-warning"
              :title="t('board.hostname.mismatch')"
              data-testid="hostname-mismatch"
            />
          </template>
          <span v-else class="opacity-70">{{ t('board.hostname.none') }}</span>

          <span class="ml-auto shrink-0 flex items-center gap-1">
            <UButton
              v-if="canOperate && d.actions.includes('ssh')"
              icon="i-lucide-scan-line"
              size="xs"
              variant="ghost"
              color="neutral"
              :loading="hostnameBusy === d.id"
              :title="t('board.hostname.check')"
              :aria-label="t('board.hostname.check')"
              data-action="hostname-check"
              @click="checkHostname(d)"
            />
            <UButton
              v-if="isAdmin && hostnameMismatch(d.label, d.hostname)"
              size="xs"
              variant="ghost"
              color="neutral"
              :loading="hostnameBusy === d.id"
              :title="t('board.hostname.accept')"
              data-action="hostname-accept"
              @click="acceptHostname(d)"
            >
              {{ t('board.hostname.accept') }}
            </UButton>
          </span>
        </div>
        <span v-if="hostnameError[d.id]" class="text-[10px] text-error">{{ hostnameError[d.id] }}</span>
      </div>
      <div v-if="point && !devices.length" class="text-xs text-muted">{{ t('board.health.noDevices') }}</div>
    </div>

    <!-- Point contacts: whom to call when something breaks here.
         The same gate as the note — a contact is the structured
         half of operator memory. -->
    <div class="border-t border-default pt-3">
      <PointContactsEditor :point-id="pointId" :can-edit="canOperate" />
    </div>

    <!-- Point notes (operator memory). Edit=operator+, viewer read-only. -->
    <div class="flex flex-col gap-1 border-t border-default pt-3">
      <div class="text-xs font-medium text-muted">{{ t('board.notes.title') }}</div>
      <template v-if="canOperate">
        <UTextarea
          v-model="note"
          :maxlength="NOTE_MAX"
          :rows="3"
          autoresize
          :placeholder="t('board.notes.placeholder')"
        />
        <div class="flex items-center gap-2">
          <span class="text-[10px] text-warning">⚠ {{ t('board.notes.passwordWarning') }}</span>
          <UButton class="ml-auto" size="xs" :loading="noteSaving" @click="saveNote">
            {{ t('board.notes.save') }}
          </UButton>
        </div>
        <span v-if="noteError" class="text-xs text-error">{{ noteError }}</span>
      </template>
      <p v-else-if="note" class="text-sm whitespace-pre-wrap">{{ note }}</p>
      <p v-else class="text-xs text-muted">{{ t('board.notes.empty') }}</p>
    </div>

    <!-- Runbooks: procedures of the point's device types + point-specific ones (read).
         Collapsible list (native <details>) — with 10+ the titles are scannable, the body
         opens on click. The first is expanded by default. -->
    <div v-if="runbooks.length" class="flex flex-col gap-1 border-t border-default pt-3">
      <div class="text-xs font-medium text-muted">{{ t('board.runbooks.title') }}</div>
      <details v-for="(r, i) in runbooks" :key="r.id" :open="i === 0" class="rounded border border-default">
        <summary class="cursor-pointer select-none px-2 py-1.5 text-sm font-medium marker:text-muted hover:bg-elevated">
          {{ r.title }}
        </summary>
        <!-- eslint-disable-next-line vue/no-v-html -- admin-trusted authoring (renderMd ponytail note) -->
        <div class="border-t border-default px-2 py-2 text-sm text-muted [&_h1]:text-base [&_h1]:font-semibold [&_h2]:font-semibold [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_code]:font-mono [&_code]:text-xs [&_a]:text-primary [&_a]:underline" v-html="renderMd(r.body)" />
      </details>
    </div>
  </div>
</template>
