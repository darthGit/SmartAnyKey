<script setup lang="ts">
// Auto-discovery diff drawer (ADR-012). Opening on a point → reattach to its running
// scan, else POST scan (task_run kind=discovery-scan) → poll the row (RLS actor=self, like
// ssh-commands — NOT realtime) → GET hosts → diff New/Matched/Changed/Rogue +
// Missing. New → confirm into a device (the single writer). Rogue is a visible flag
// (persistent point timeline — deferred, "later").
// ponytail: rogue is only marked in the drawer for now; a separate audit/timeline of
//           the point is the next step (drift-inbox), the seam in reconcile_status exists.
import type { DeviceType, DiscoveredHost, DiscoveryDiff, Point } from '~/types/board'
import { fillNames } from '~/utils/nameTemplate'

const props = defineProps<{ point: Point | null, open: boolean, types: DeviceType[] }>()
const emit = defineEmits<{ 'update:open': [boolean], 'confirmed': [], 'scheduled': [] }>()

const { t } = useI18n()
const supabase = useSupabaseClient()
const session = useSupabaseSession()
const headers = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

// Per-point rescan schedule: admin turns cadence on/off here.
// Without a cadence the scheduled task never picks the point → no drift ever.
const cadenceOptions = computed(() => [
  { label: t('discovery.cadenceOff'), value: 0 },
  { label: t('discovery.cadence15m'), value: 15 },
  { label: t('discovery.cadence1h'), value: 60 },
  { label: t('discovery.cadence6h'), value: 360 },
  { label: t('discovery.cadence24h'), value: 1440 },
])
const cadence = ref(0)
const scheduleBusy = ref(false)
const scheduleErr = ref('')
watch(() => props.point, (p) => { cadence.value = p?.scan_cadence_minutes ?? 0 }, { immediate: true })

async function saveSchedule() {
  if (!props.point)
    return
  scheduleBusy.value = true
  scheduleErr.value = ''
  try {
    await $fetch(`/api/discovery/${props.point.id}/schedule`, {
      method: 'POST', headers: headers.value, body: { cadenceMinutes: cadence.value || null },
    })
    emit('scheduled')
  }
  catch (e) {
    scheduleErr.value = (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message
  }
  finally {
    scheduleBusy.value = false
  }
}

const phase = ref<'idle' | 'scanning' | 'done' | 'failed'>('idle')
const errorMsg = ref('')
const diff = ref<DiscoveryDiff | null>(null)

// Scan port mode: combined (curated ∪ signatures) = the default
// and auto-scan; signatures = signature ports only; custom = an arbitrary -p string.
type ScanMode = 'combined' | 'signatures' | 'custom'
const scanMode = ref<ScanMode>('combined')
const customPorts = ref('')
// signatures mode makes sense only when port signatures exist (else an empty scan) →
// disable the option. A global flag (signatures belong to types, not to a point).
const hasPortSig = ref(false)
const modeItems = computed(() => [
  { label: t('discovery.modeCombined'), value: 'combined' },
  { label: t('discovery.modeSignatures'), value: 'signatures', disabled: !hasPortSig.value },
  { label: t('discovery.modeCustom'), value: 'custom' },
])
// ponytail: the client guard checks only "non-empty" — the full format (^[\d,-]+$)
// is validated by the server (resolvePorts), a failure comes back as phase=failed with a message.
const canScan = computed(() => scanMode.value !== 'custom' || customPorts.value.trim().length > 0)

async function loadPortSigFlag() {
  const { count } = await supabase
    .from('device_type_signatures')
    .select('id', { count: 'exact', head: true })
    .eq('signal_type', 'port')
  hasPortSig.value = (count ?? 0) > 0
}

// missing rows have no host card (a device without an observation) → own badge.
const MISSING_COLOR = 'neutral' as const

// The point phase/diff belong to and the run being polled. Closing the drawer does NOT
// stop the poll — the scan is a background task_run; reopening shows it again.
const scanPointId = ref<string | null>(null)
const activeRun = ref<string | null>(null)

function fail(e: unknown) {
  errorMsg.value = (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message
  phase.value = 'failed'
}

async function pollRun(id: string, pointId: string) {
  // run-gated: Stop or another point clears activeRun and the loop exits (the server
  // scan finishes detached, last-writer-wins — an accepted ceiling).
  activeRun.value = id
  try {
    for (let i = 0; i < 1000 && activeRun.value === id; i++) {
      const { data } = await supabase.from('task_run').select('status,error').eq('id', id).maybeSingle()
      if (activeRun.value !== id)
        return
      if (data?.status === 'done') {
        diff.value = await $fetch<DiscoveryDiff>(`/api/discovery/${pointId}/hosts`, { headers: headers.value })
        phase.value = 'done'
        return
      }
      if (data?.status === 'failed') {
        errorMsg.value = data.error ?? 'error'
        phase.value = 'failed'
        return
      }
      await new Promise(r => setTimeout(r, 800))
    }
  }
  catch (e) {
    if (activeRun.value === id)
      fail(e)
  }
}

function resetForScan(pointId: string) {
  scanPointId.value = pointId
  activeRun.value = null
  phase.value = 'scanning'
  errorMsg.value = ''
  bulkResult.value = ''
  diff.value = null
}

async function startScan() {
  if (!props.point)
    return
  const pointId = props.point.id
  resetForScan(pointId)
  try {
    const { executionId } = await $fetch<{ executionId: string }>(`/api/discovery/${pointId}/scan`, {
      method: 'POST',
      headers: headers.value,
      body: { mode: scanMode.value, customPorts: scanMode.value === 'custom' ? customPorts.value.trim() : undefined },
    })
    if (scanPointId.value === pointId && phase.value === 'scanning')
      await pollRun(executionId, pointId)
  }
  catch (e) {
    if (scanPointId.value === pointId)
      fail(e)
  }
}

// Stop: aborts waiting for the scan → idle; the selector becomes active,
// the admin starts again with another template via the Scan button.
function stopScan() {
  activeRun.value = null
  phase.value = 'idle'
}

watch(() => [props.open, props.point?.id], async () => {
  if (!props.open || !props.point)
    return
  const pointId = props.point.id
  // same point, scan still polling or its result kept → just show it
  if (scanPointId.value === pointId && phase.value !== 'idle')
    return
  resetForScan(pointId)
  void loadPortSigFlag()
  // a scan of this point already running (drawer closed, page reloaded, another admin) → reattach
  const { data } = await supabase.from('task_run').select('id')
    .eq('kind', 'discovery-scan').eq('ref_id', pointId).eq('status', 'running')
    .order('started_at', { ascending: false }).limit(1).maybeSingle()
  if (scanPointId.value !== pointId || phase.value !== 'scanning')
    return
  if (data) {
    await pollRun(data.id, pointId)
  }
  else {
    scanMode.value = 'combined' // auto-scan on open — always combined
    startScan()
  }
})

// --- confirm New → device ------------------------------------------------
const typeItems = computed(() => props.types.map(ty => ({ label: ty.name, value: ty.id })))

// host list sorted by confidence ↓ (higher % on top; without % —
// rogue/unknown — at the bottom). Copy before sort (do not mutate the reactive array).
const sortedHosts = computed(() => [...(diff.value?.hosts ?? [])].sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1)))

// New hosts + rogue (no rule matched) — candidates for the add; the admin may know what a
// rogue is or overrule the classifier, so the type is per host and editable.
const newHosts = computed(() => diff.value?.hosts.filter(h => h.reconcile_status === 'new' || h.reconcile_status === 'rogue') ?? [])
// matched no rule (rogue) → hint to add/refine rules
const unclassifiedCount = computed(() => diff.value?.hosts.filter(h => h.reconcile_status === 'rogue').length ?? 0)

// Hosts of the scan that answer with the same ssh key (clones of one image) — the card
// warns; reconcile already refuses to identify them by that key.
const sharedKeyWith = computed(() => {
  const byKey = new Map<string, string[]>()
  for (const h of diff.value?.hosts ?? [])
    if (h.ssh_hostkey)
      byKey.set(h.ssh_hostkey, [...(byKey.get(h.ssh_hostkey) ?? []), h.ip])
  return (h: DiscoveredHost) => (h.ssh_hostkey ? (byKey.get(h.ssh_hostkey) ?? []).filter(ip => ip !== h.ip) : [])
})

// Selection + names + types for the add. Every classified host starts selected with its
// observed name and proposed type; an unclassified one starts unticked with no type (never
// added under some type by accident). The admin unticks, renames, retypes, or uses a template.
const selected = ref<string[]>([])
const names = ref<Record<string, string>>({})
const hostTypes = ref<Record<string, string>>({})
const edited = ref(new Set<string>())
const nameTemplate = ref('')
watch(newHosts, (list) => {
  selected.value = list.filter(h => h.proposed_type_id).map(h => h.id)
  names.value = Object.fromEntries(list.map(h => [h.id, h.hostname || h.ip]))
  hostTypes.value = Object.fromEntries(list.map(h => [h.id, h.proposed_type_id ?? '']))
  edited.value = new Set()
}, { immediate: true })
const allSelected = computed(() => newHosts.value.length > 0 && selected.value.length === newHosts.value.length)
function toggleAll() {
  selected.value = allSelected.value ? [] : newHosts.value.map(h => h.id)
}
function toggle(id: string) {
  selected.value = selected.value.includes(id) ? selected.value.filter(x => x !== id) : [...selected.value, id]
}
function setName(id: string, v: string) {
  names.value = { ...names.value, [id]: v }
  edited.value = new Set(edited.value).add(id)
}
const missingType = computed(() => selected.value.some(id => !hostTypes.value[id]))
function applyTemplate() {
  if (nameTemplate.value.trim())
    names.value = fillNames(nameTemplate.value.trim(), selected.value, names.value, edited.value)
}

const bulkBusy = ref(false)
const bulkResult = ref('')

// Bulk add of the selected hosts — removes the chore of N clicks (give a naive
// user a bulk action). Propose-don't-write stays: a human clicks once.
// ponytail: a sequential loop — a point has dozens of hosts; a batch endpoint if needed.
async function addSelected() {
  if (!props.point)
    return
  bulkBusy.value = true
  bulkResult.value = ''
  let ok = 0
  let fail = 0
  for (const h of newHosts.value.filter(h => selected.value.includes(h.id))) {
    try {
      await $fetch(`/api/discovery/${props.point.id}/confirm`, {
        method: 'POST', headers: headers.value,
        body: { ip: h.ip, typeId: hostTypes.value[h.id]!, label: names.value[h.id]?.trim() || h.hostname || h.ip },
      })
      ok++
    }
    catch { fail++ }
  }
  bulkResult.value = t('discovery.addAllResult', { ok, failText: fail ? t('discovery.addAllFailPart', { fail }) : '' })
  emit('confirmed')
  diff.value = await $fetch<DiscoveryDiff>(`/api/discovery/${props.point.id}/hosts`, { headers: headers.value })
  bulkBusy.value = false
}
</script>

<template>
  <USlideover
    :open="open"
    :title="t('discovery.title')"
    :description="point ? t('discovery.point', { number: point.number }) : ''"
    @update:open="v => emit('update:open', v)"
  >
    <template #body>
      <!-- Schedule switch: always visible — enable auto-rescan for drift detection. -->
      <div class="mb-3 flex flex-wrap items-center gap-2 rounded bg-elevated p-2">
        <UIcon name="i-lucide-timer" class="text-muted" />
        <span class="text-sm text-muted">{{ t('discovery.scheduleLabel') }}</span>
        <USelect v-model="cadence" :items="cadenceOptions" size="sm" class="w-40" @update:model-value="saveSchedule" />
        <UIcon v-if="scheduleBusy" name="i-lucide-loader-circle" class="animate-spin text-muted" />
        <span class="ml-auto text-xs text-muted">{{ t('discovery.scheduleHint') }}</span>
        <span v-if="scheduleErr" class="w-full text-xs text-error">{{ scheduleErr }}</span>
      </div>

      <!-- Scan port mode: the port range before a (re)scan. -->
      <div class="mb-3 flex flex-wrap items-center gap-2 rounded bg-elevated p-2">
        <UIcon name="i-lucide-radar" class="text-muted" />
        <span class="text-sm text-muted">{{ t('discovery.scanMode') }}</span>
        <USelect v-model="scanMode" :items="modeItems" size="sm" class="w-44" />
        <UInput
          v-if="scanMode === 'custom'"
          v-model="customPorts"
          size="sm"
          class="w-40 font-mono"
          :placeholder="t('discovery.customPortsPlaceholder')"
        />
        <span class="ml-auto text-xs text-muted">{{ t('discovery.modeHint') }}</span>
      </div>

      <div v-if="phase === 'scanning'" class="flex items-center gap-2 text-muted">
        <UIcon name="i-lucide-loader-circle" class="animate-spin" />
        {{ t('discovery.scanning', { subnet: point?.subnet }) }}
        <UButton class="ml-auto" size="xs" variant="ghost" color="neutral" icon="i-lucide-square" @click="stopScan">
          {{ t('discovery.stop') }}
        </UButton>
      </div>

      <div v-else-if="phase === 'idle'" class="flex items-center gap-2">
        <UButton size="sm" color="primary" icon="i-lucide-radar" :disabled="!canScan" @click="startScan">
          {{ t('discovery.scan') }}
        </UButton>
        <span class="text-xs text-muted">{{ t('discovery.scanIdleHint') }}</span>
      </div>

      <p v-else-if="phase === 'failed'" class="text-sm text-error">
        {{ t('discovery.scanFailed', { error: errorMsg }) }}
      </p>

      <template v-else-if="phase === 'done' && diff">
        <p v-if="!diff.hosts.length && !diff.missing.length" class="text-muted">
          {{ t('discovery.noHosts') }}
        </p>

        <!-- bulk action + hints (to make the flow intuitive) -->
        <div v-if="diff.hosts.length" class="mb-3 flex flex-col gap-2">
          <div v-if="newHosts.length" class="flex flex-col gap-2 rounded bg-elevated p-2">
            <p class="text-xs text-muted">{{ t('discovery.selectHint') }}</p>
            <div class="flex flex-wrap items-center gap-2">
              <UCheckbox :model-value="allSelected" :label="t('discovery.selectAll')" data-action="select-all" @update:model-value="toggleAll" />
              <UInput v-model="nameTemplate" size="sm" class="min-w-40 flex-1" :placeholder="t('discovery.templatePlaceholder')" data-testid="name-template" @keydown.enter="applyTemplate" />
              <UButton size="sm" variant="soft" color="neutral" :disabled="!nameTemplate.trim() || !selected.length" data-action="apply-template" @click="applyTemplate">
                {{ t('discovery.templateApply') }}
              </UButton>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <UButton size="sm" color="primary" icon="i-lucide-plus" :loading="bulkBusy" :disabled="!selected.length || missingType" data-action="add-selected" @click="addSelected">
                {{ t('discovery.addAll', { count: selected.length }) }}
              </UButton>
              <span v-if="missingType" class="text-xs text-warning">{{ t('discovery.pickType') }}</span>
            </div>
          </div>
          <!-- outside the add panel: it hides once every candidate is added -->
          <p v-if="bulkResult" class="text-xs text-muted" data-testid="bulk-result">{{ bulkResult }}</p>
          <p v-if="unclassifiedCount" class="text-xs text-muted">
            {{ t('discovery.unclassifiedHint', { count: unclassifiedCount }) }}
            <UButton to="/admin/teach" variant="link" size="xs" class="px-1" data-action="teach-link">{{ t('discovery.teach') }}</UButton>
            <UButton to="/admin/signatures" variant="link" size="xs" class="px-1">{{ t('discovery.editRules') }}</UButton>
          </p>
        </div>

        <p class="mb-2 text-xs font-mono text-muted uppercase tracking-wide">
          {{ t('discovery.hostsTitle', { count: diff.hosts.length }) }}
        </p>
        <ul class="divide-y divide-default rounded ring ring-default">
          <li v-for="h in sortedHosts" :key="h.id" class="p-3">
            <div class="flex items-start gap-2">
              <UCheckbox
                v-if="h.reconcile_status === 'new' || h.reconcile_status === 'rogue'"
                :model-value="selected.includes(h.id)"
                :aria-label="h.ip"
                class="mt-0.5"
                data-action="select-host"
                @update:model-value="toggle(h.id)"
              />
              <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                <DiscoverHostCard :host="h" :types="types" :shared-key-with="sharedKeyWith(h)" />
                <div v-if="selected.includes(h.id)" class="flex flex-wrap gap-2">
                  <USelect
                    v-model="hostTypes[h.id]"
                    :items="typeItems"
                    size="sm"
                    class="w-44"
                    :placeholder="t('discovery.type')"
                    data-testid="host-type"
                  />
                  <UInput
                    :model-value="names[h.id] ?? ''"
                    size="sm"
                    class="min-w-32 flex-1"
                    :placeholder="t('discovery.label')"
                    data-testid="host-name"
                    @update:model-value="setName(h.id, String($event))"
                  />
                </div>
              </div>
            </div>
          </li>
        </ul>

        <template v-if="diff.missing.length">
          <p class="mt-4 mb-2 text-xs font-mono text-muted uppercase tracking-wide">
            {{ t('discovery.missingTitle', { count: diff.missing.length }) }}
          </p>
          <ul class="divide-y divide-default rounded ring ring-default">
            <li v-for="m in diff.missing" :key="m.id" class="flex items-center gap-2 p-3">
              <UBadge size="xs" :color="MISSING_COLOR" variant="subtle">{{ t('discovery.status.missing') }}</UBadge>
              <span class="text-sm">{{ m.label }}</span>
              <span class="font-mono text-xs text-muted">{{ m.host }}</span>
            </li>
          </ul>
        </template>
      </template>
    </template>

    <template #footer>
      <UButton to="/admin/signatures" variant="ghost" color="neutral" icon="i-lucide-sliders-horizontal">
        {{ t('discovery.editRules') }}
      </UButton>
      <UButton
        class="ml-auto"
        variant="ghost"
        color="neutral"
        icon="i-lucide-refresh-cw"
        :loading="phase === 'scanning'"
        :disabled="phase === 'scanning' || !canScan"
        @click="startScan"
      >
        {{ t('discovery.rescan') }}
      </UButton>
      <UButton color="neutral" @click="emit('update:open', false)">{{ t('discovery.close') }}</UButton>
    </template>
  </USlideover>
</template>
