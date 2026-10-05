<script setup lang="ts">
// Wizard teach screen (the only genuinely new UI of the wizard).
// Flow: pick a point → scan (reuses task_run polling like DiscoverDrawer) → host list
// → pick a sample → show observations → type + signal checkboxes → teachSignatureDraft
// → POST to the existing signatures API (Bearer) → live preview. After
// ≥2 labelled types, auto-diff (signalDiff) highlights the distinguishing signals.
// Several samples/type → teachSignatureDraft generalises. ADR-012/006/004.
// Naive-user flow: inline guide + bulk action (all signals at once),
// fine-tuning of regex/capture — in the standalone /admin/signatures (link below).
import type { DeviceType, DiscoveredHost, DiscoveryDiff, Point } from '~/types/board'
import type { Observation } from '~/../server/repositories/scanner'
import type { SignalSelection } from '~/utils/teachSignatureDraft'
import { signalDiff } from '~/utils/signalDiff'
import { teachSignatureDraft } from '~/utils/teachSignatureDraft'

const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const supabase = useSupabaseClient()
const session = useSupabaseSession()
const headers = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

const types = ref<DeviceType[]>([])
const typeItems = computed(() => types.value.map(ty => ({ label: ty.name, value: ty.id })))
const typeName = (id: string) => types.value.find(ty => ty.id === id)?.name ?? id

// ponytail: load all points (≤1000 PostgREST cap; pilot ~300 — no data loss).
//           >1000 → server-side ilike search. USelectMenu filters on the client.
const points = ref<Point[]>([])
const pointId = ref<string | null>(null)
const pointOf = computed(() => points.value.find(p => p.id === pointId.value) ?? null)
const pointItems = computed(() => points.value.map(p => ({ label: `#${p.number} · ${p.address}`, value: p.id })))

// already saved (type\0signal\0pattern) — avoid duplicate POSTs across samples/sessions
const savedKeys = ref(new Set<string>())

async function loadAll() {
  const [{ data: ty }, { data: pts }, { data: sigs }] = await Promise.all([
    supabase.from('device_types').select('id,slug,name,icon,color,default_action,sort').order('sort'),
    supabase.from('points').select('id,number,address,subnet,scan_cadence_minutes,next_scan_at').order('number').limit(1000),
    supabase.from('device_type_signatures').select('type_id,signal_type,pattern'),
  ])
  types.value = (ty ?? []) as DeviceType[]
  points.value = (pts ?? []) as Point[]
  savedKeys.value = new Set((sigs ?? []).map(s => `${s.type_id}\0${s.signal_type}\0${s.pattern}`))
}
watch(session, (s) => { if (s) loadAll() }, { immediate: true })

// --- scan (reuses the DiscoverDrawer pattern) ----------------------------
const phase = ref<'idle' | 'scanning' | 'done' | 'failed'>('idle')
const errorMsg = ref('')
const hosts = ref<DiscoveredHost[]>([])

async function pollRun(id: string) {
  for (let i = 0; i < 1000 && phase.value === 'scanning'; i++) {
    const { data } = await supabase.from('task_run').select('status,error').eq('id', id).maybeSingle()
    if (data?.status === 'done') {
      const diff = await $fetch<DiscoveryDiff>(`/api/discovery/${pointId.value}/hosts`, { headers: headers.value })
      hosts.value = diff.hosts
      phase.value = 'done'
      return
    }
    if (data?.status === 'failed') { errorMsg.value = data.error ?? 'error'; phase.value = 'failed'; return }
    await new Promise(r => setTimeout(r, 800))
  }
}

async function startScan() {
  if (!pointId.value)
    return
  phase.value = 'scanning'
  errorMsg.value = ''
  hosts.value = []
  sample.value = null
  needsRescan.value = false
  savedMsg.value = ''
  try {
    const { executionId } = await $fetch<{ executionId: string }>(`/api/discovery/${pointId.value}/scan`, {
      method: 'POST', headers: headers.value, body: { mode: 'combined' },
    })
    await pollRun(executionId)
  }
  catch (e) {
    errorMsg.value = (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message
    phase.value = 'failed'
  }
}

// --- sample + labelling ---------------------------------------------------
interface Sample { host: DiscoveredHost, typeId: string, checked: Set<string> }
const sample = ref<Sample | null>(null)
const labeled = ref<{ typeId: string, obs: Observation }[]>([]) // for auto-diff
const saveErr = ref('')
const preview = ref<{ hosts: number, wins: number } | null>(null)
const savedMsg = ref('') // "rules saved" confirmation (feedback)
// rules changed after the last scan → the shown classification is stale
// until a rescan (reclassification only on a new scan — inline guide + button below)
const needsRescan = ref(false)

function toObs(h: DiscoveredHost): Observation {
  return {
    ip: h.ip,
    hostname: h.hostname ?? undefined,
    ports: (h.open_ports ?? []).map(p => ({ port: p.port, proto: p.proto, banner: p.banner })),
    tlsCertSha256: h.tls_cert_sha256 ?? undefined,
    tlsCertCn: h.tls_cert_cn ?? undefined,
    osGuess: h.os_guess ?? undefined,
  }
}

// the host's candidate signals (axes as in the engine). key = signal_type\0pattern (for checkboxes).
function candidatesOf(h: DiscoveredHost): SignalSelection[] {
  const out: SignalSelection[] = []
  for (const p of h.open_ports ?? []) {
    out.push({ signal_type: 'port', pattern: String(p.port) })
    if (p.banner) out.push({ signal_type: 'banner', pattern: p.banner })
  }
  if (h.tls_cert_cn) out.push({ signal_type: 'cert', pattern: h.tls_cert_cn })
  if (h.os_guess) out.push({ signal_type: 'os', pattern: h.os_guess })
  return out
}
const candKey = (c: SignalSelection) => `${c.signal_type}\0${c.pattern}`

// auto-diff: distinguishing signals among already labelled types (≥2). A Set of keys.
const discriminating = computed(() => {
  if (new Set(labeled.value.map(l => l.typeId)).size < 2)
    return new Set<string>()
  return new Set(signalDiff(labeled.value).map(d => `${d.signal_type}\0${d.pattern}`))
})

function pickSample(h: DiscoveredHost) {
  saveErr.value = ''
  preview.value = null
  // preselection: distinguishing signals (hint) or all ports
  const cands = candidatesOf(h)
  const preChecked = cands.filter(c => discriminating.value.has(candKey(c)) || c.signal_type === 'port')
  sample.value = {
    host: h,
    typeId: h.proposed_type_id ?? types.value[0]?.id ?? '',
    checked: new Set(preChecked.map(candKey)),
  }
}

function toggle(c: SignalSelection) {
  if (!sample.value)
    return
  const k = candKey(c)
  if (sample.value.checked.has(k))
    sample.value.checked.delete(k)
  else sample.value.checked.add(k)
}

async function saveRules() {
  if (!sample.value?.typeId)
    return
  saveErr.value = ''
  const typeId = sample.value.typeId
  const chosen = candidatesOf(sample.value.host).filter(c => sample.value!.checked.has(candKey(c)))
  const rows = teachSignatureDraft(typeId, chosen)
  let ok = 0
  try {
    for (const row of rows) {
      const key = `${typeId}\0${row.signal_type}\0${row.pattern}`
      if (savedKeys.value.has(key))
        continue // already exists — do not duplicate
      await $fetch('/api/admin/signatures', { method: 'POST', headers: headers.value, body: row })
      savedKeys.value.add(key)
      ok++
    }
    labeled.value.push({ typeId, obs: toObs(sample.value.host) })
    preview.value = await $fetch('/api/admin/signatures/preview', { query: { typeId }, headers: headers.value }).catch(() => null)
    sample.value = null
    savedMsg.value = t('onboarding.teach.saved', { count: ok, type: typeName(typeId) })
    if (ok) {
      needsRescan.value = true // host classification is stale until a rescan
      emit('changed') // update the wizard progress (signatures count)
    }
  }
  catch (e) {
    saveErr.value = (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message
  }
}

const labeledTypeNames = computed(() => [...new Set(labeled.value.map(l => typeName(l.typeId)))])
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- inline guide (naive-user flow) -->
    <div class="flex flex-col gap-1 rounded bg-default p-3 text-sm">
      <p class="text-muted">{{ t('onboarding.teach.help1') }}</p>
      <p class="text-muted">{{ t('onboarding.teach.help2') }}</p>
    </div>

    <!-- 1. point + scan -->
    <div class="flex flex-wrap items-end gap-3">
      <UFormField :label="t('onboarding.teach.point')" class="w-72">
        <USelectMenu
          v-model="pointId"
          :items="pointItems"
          value-key="value"
          :placeholder="t('onboarding.teach.pointPlaceholder')"
          searchable
        />
      </UFormField>
      <UButton
        color="primary"
        icon="i-lucide-radar"
        :loading="phase === 'scanning'"
        :disabled="!pointId || phase === 'scanning'"
        @click="startScan"
      >
        {{ t('onboarding.teach.scan') }}
      </UButton>
    </div>

    <p v-if="phase === 'scanning'" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-lucide-loader-circle" class="animate-spin" />
      {{ t('onboarding.teach.scanning', { subnet: pointOf?.subnet }) }}
    </p>
    <p v-else-if="phase === 'failed'" class="text-sm text-error">{{ t('onboarding.teach.scanFailed', { error: errorMsg }) }}</p>

    <!-- auto-diff hint -->
    <p v-if="labeledTypeNames.length >= 2" class="text-xs text-primary">
      {{ t('onboarding.teach.autoDiff', { types: labeledTypeNames.join(', ') }) }}
    </p>

    <!-- save confirmation + rescan hint (feedback: teaching worked,
         but hosts are reclassified only on a new scan) -->
    <p v-if="savedMsg" class="text-sm text-success">{{ savedMsg }}</p>
    <div
      v-if="needsRescan && phase !== 'scanning'"
      class="flex flex-wrap items-center gap-2 rounded bg-elevated p-3"
    >
      <UIcon name="i-lucide-info" class="text-primary" />
      <span class="text-sm text-muted">{{ t('onboarding.teach.needsRescan') }}</span>
      <UButton size="sm" color="primary" variant="soft" icon="i-lucide-refresh-cw" class="ml-auto" @click="startScan">
        {{ t('onboarding.teach.rescanApply') }}
      </UButton>
    </div>

    <!-- 2. host list (samples) -->
    <template v-if="phase === 'done'">
      <p v-if="!hosts.length" class="text-sm text-muted">{{ t('onboarding.teach.noHosts') }}</p>
      <ul v-else class="divide-y divide-default rounded ring ring-default">
        <li v-for="h in hosts" :key="h.id" class="p-3">
          <div class="flex items-start gap-2">
            <DiscoverHostCard :host="h" :types="types" class="flex-1" />
            <UButton size="xs" variant="ghost" color="primary" @click="pickSample(h)">
              {{ t('onboarding.teach.useSample') }}
            </UButton>
          </div>

          <!-- 3. labelling the chosen sample -->
          <div v-if="sample && sample.host.id === h.id" class="mt-3 flex flex-col gap-3 rounded bg-elevated p-3">
            <UFormField :label="t('onboarding.teach.type')" class="w-64">
              <USelect v-model="sample.typeId" :items="typeItems" />
            </UFormField>

            <div class="flex flex-col gap-1">
              <span class="text-xs font-mono text-muted uppercase tracking-wide">{{ t('onboarding.teach.signals') }}</span>
              <label
                v-for="c in candidatesOf(h)"
                :key="candKey(c)"
                class="flex cursor-pointer items-center gap-2 text-sm"
              >
                <UCheckbox
                  :model-value="sample.checked.has(candKey(c))"
                  @update:model-value="toggle(c)"
                />
                <UBadge size="xs" color="neutral" variant="subtle">{{ c.signal_type }}</UBadge>
                <code class="text-xs text-highlighted">{{ c.pattern }}</code>
                <UBadge
                  v-if="discriminating.has(candKey(c))"
                  size="xs"
                  color="primary"
                  variant="subtle"
                  icon="i-lucide-sparkles"
                >
                  {{ t('onboarding.teach.distinguishing') }}
                </UBadge>
              </label>
            </div>

            <p v-if="saveErr" class="text-sm text-error">{{ saveErr }}</p>
            <div class="flex items-center gap-2">
              <UButton size="sm" color="neutral" variant="ghost" @click="sample = null">{{ t('onboarding.teach.cancel') }}</UButton>
              <UButton
                size="sm"
                color="primary"
                :disabled="!sample.typeId || !sample.checked.size"
                @click="saveRules"
              >
                {{ t('onboarding.teach.saveRules', { type: typeName(sample.typeId) }) }}
              </UButton>
            </div>
          </div>
        </li>
      </ul>

      <p v-if="preview" class="text-sm text-muted">
        {{ t('onboarding.teach.preview', { wins: preview.wins, hosts: preview.hosts }) }}
      </p>
    </template>

    <UButton to="/admin/signatures" variant="link" size="xs" class="self-start px-0" icon="i-lucide-sliders-horizontal">
      {{ t('onboarding.teach.advanced') }}
    </UButton>
  </div>
</template>
