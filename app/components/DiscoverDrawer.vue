<script setup lang="ts">
// Auto-discovery diff drawer (ADR-012). Opening on a point →
// POST scan (task_run kind=discovery-scan) → poll the row (RLS actor=self, like
// ssh-commands — NOT realtime) → GET hosts → diff New/Matched/Changed/Rogue +
// Missing. New → confirm into a device (the single writer). Rogue is a visible flag
// (persistent point timeline — deferred, "later").
// ponytail: rogue is only marked in the drawer for now; a separate audit/timeline of
//           the point is the next step (drift-inbox), the seam in reconcile_status exists.
import type { DeviceType, DiscoveredHost, DiscoveryDiff, Point } from '~/types/board'

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

async function pollRun(id: string) {
  // phase-gated: Stop sets phase→idle and the loop exits (the server scan
  // finishes detached, last-writer-wins — an accepted ceiling).
  for (let i = 0; i < 1000 && phase.value === 'scanning'; i++) {
    const { data } = await supabase.from('task_run').select('status,error').eq('id', id).maybeSingle()
    if (data?.status === 'done') {
      diff.value = await $fetch<DiscoveryDiff>(`/api/discovery/${props.point!.id}/hosts`, { headers: headers.value })
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

async function startScan() {
  if (!props.point)
    return
  phase.value = 'scanning'
  errorMsg.value = ''
  diff.value = null
  confirming.value = null
  try {
    const { executionId } = await $fetch<{ executionId: string }>(`/api/discovery/${props.point.id}/scan`, {
      method: 'POST',
      headers: headers.value,
      body: { mode: scanMode.value, customPorts: scanMode.value === 'custom' ? customPorts.value.trim() : undefined },
    })
    await pollRun(executionId)
  }
  catch (e) {
    errorMsg.value = (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message
    phase.value = 'failed'
  }
}

// Stop: aborts waiting for the scan → idle; the selector becomes active,
// the admin starts again with another template via the Scan button.
function stopScan() {
  phase.value = 'idle'
}

watch(() => [props.open, props.point?.id], () => {
  if (props.open && props.point && phase.value === 'idle') {
    scanMode.value = 'combined' // auto-scan on open — always combined
    void loadPortSigFlag()
    startScan()
  }
  if (!props.open)
    phase.value = 'idle'
})

// --- confirm New → device ------------------------------------------------
const confirming = ref<{ hostId: string, typeId: string, label: string } | null>(null)
const confirmErr = ref('')
const typeItems = computed(() => props.types.map(ty => ({ label: ty.name, value: ty.id })))

// host list sorted by confidence ↓ (higher % on top; without % —
// rogue/unknown — at the bottom). Copy before sort (do not mutate the reactive array).
const sortedHosts = computed(() => [...(diff.value?.hosts ?? [])].sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1)))

// classified New hosts (have a proposed type) — candidates for bulk add
const newHosts = computed(() => diff.value?.hosts.filter(h => h.reconcile_status === 'new' && h.proposed_type_id) ?? [])
// matched no rule (rogue) → hint to add/refine rules
const unclassifiedCount = computed(() => diff.value?.hosts.filter(h => h.reconcile_status === 'rogue').length ?? 0)

const bulkBusy = ref(false)
const bulkResult = ref('')

// Bulk "Add all matched" — removes the chore of N clicks (give a naive
// user a bulk action). Propose-don't-write stays: a human clicks once.
// ponytail: a sequential loop — a point has dozens of hosts; a batch endpoint if needed.
async function addAllNew() {
  if (!props.point)
    return
  bulkBusy.value = true
  bulkResult.value = ''
  let ok = 0
  let fail = 0
  for (const h of newHosts.value) {
    try {
      await $fetch(`/api/discovery/${props.point.id}/confirm`, {
        method: 'POST', headers: headers.value,
        body: { ip: h.ip, typeId: h.proposed_type_id!, label: h.hostname || h.ip },
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

function openConfirm(h: DiscoveredHost) {
  confirmErr.value = ''
  confirming.value = {
    hostId: h.id,
    typeId: h.proposed_type_id ?? props.types[0]?.id ?? '',
    label: h.hostname || h.ip,
  }
}

async function submitConfirm(h: DiscoveredHost) {
  if (!confirming.value || !props.point)
    return
  confirmErr.value = ''
  try {
    await $fetch(`/api/discovery/${props.point.id}/confirm`, {
      method: 'POST', headers: headers.value,
      body: { ip: h.ip, typeId: confirming.value.typeId, label: confirming.value.label },
    })
    confirming.value = null
    emit('confirmed')
    diff.value = await $fetch<DiscoveryDiff>(`/api/discovery/${props.point.id}/hosts`, { headers: headers.value })
  }
  catch (e) {
    confirmErr.value = (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message
  }
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
          <div v-if="newHosts.length" class="flex flex-wrap items-center gap-2 rounded bg-elevated p-2">
            <UButton size="sm" color="primary" icon="i-lucide-plus" :loading="bulkBusy" @click="addAllNew">
              {{ t('discovery.addAll', { count: newHosts.length }) }}
            </UButton>
            <span v-if="bulkResult" class="text-xs text-muted">{{ bulkResult }}</span>
          </div>
          <p v-if="unclassifiedCount" class="text-xs text-muted">
            {{ t('discovery.unclassifiedHint', { count: unclassifiedCount }) }}
            <UButton to="/admin/signatures" variant="link" size="xs" class="px-1">{{ t('discovery.editRules') }}</UButton>
          </p>
        </div>

        <p class="mb-2 text-xs font-mono text-muted uppercase tracking-wide">
          {{ t('discovery.hostsTitle', { count: diff.hosts.length }) }}
        </p>
        <ul class="divide-y divide-default rounded ring ring-default">
          <li v-for="h in sortedHosts" :key="h.id" class="p-3">
            <div class="flex items-start gap-2">
              <DiscoverHostCard :host="h" :types="types" class="flex-1" />
              <UButton
                v-if="h.reconcile_status === 'new'"
                size="xs"
                variant="ghost"
                color="primary"
                @click="openConfirm(h)"
              >
                {{ t('discovery.confirm') }}
              </UButton>
            </div>

            <!-- inline confirm form (explicit confirm of type+label) -->
            <div v-if="confirming?.hostId === h.id" class="mt-2 flex flex-wrap items-end gap-2 rounded bg-elevated p-2">
              <UFormField :label="t('discovery.type')" class="w-44">
                <USelect v-model="confirming.typeId" :items="typeItems" size="sm" />
              </UFormField>
              <UFormField :label="t('discovery.label')" class="flex-1 min-w-32">
                <UInput v-model="confirming.label" size="sm" class="w-full" />
              </UFormField>
              <UButton size="sm" color="neutral" variant="ghost" @click="confirming = null">{{ t('discovery.cancel') }}</UButton>
              <UButton size="sm" color="primary" :disabled="!confirming.typeId || !confirming.label" @click="submitConfirm(h)">
                {{ t('discovery.add') }}
              </UButton>
              <p v-if="confirmErr" class="w-full text-xs text-error">{{ t('discovery.confirmError', { message: confirmErr }) }}</p>
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
