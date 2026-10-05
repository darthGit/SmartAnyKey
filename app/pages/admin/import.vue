<script setup lang="ts">
// Admin UI for bulk CSV import.
// CSR, Nuxt UI, i18n. Flow: upload → Preview → column mapping + value mapping
// of types (their values → our device_types, no guessing) → Import. Validation in
// preview (blocked rows visible before import); propose-don't-write.
import type { DeviceType } from '~/types/board'

const { t } = useI18n()
const supabase = useSupabaseClient()
const session = useSupabaseSession()
const authHeaders = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

type Kind = 'points' | 'devices' | 'contacts'
type Row = Record<string, string>
interface DiffEntry { status: 'new' | 'update' | 'skip', key: string, row: Row }
interface Plan {
  headers: string[]
  mapping: Record<string, string>
  typeValues: string[]
  malformed: { line: number, reason: string }[]
  blocked: { key: string, reason: string, row: Row }[]
  diff: DiffEntry[]
  counts: { new: number, update: number, skip: number, blocked: number }
}
interface Summary { created: number, updated: number, skipped: number, failed: { key: string, reason: string }[] }

const FIELDS: Record<Kind, string[]> = {
  points: ['number', 'address', 'subnet'],
  devices: ['host', 'label', 'type', 'point'],
  // A row = one point contact.
  // No value mapping needed here — `kind` stays the client's value.
  contacts: ['point', 'kind', 'value', 'label'],
}
const DIFF_CAP = 100 // ponytail: first N rows + a counter, not thousands of DOM nodes

const kind = ref<Kind>('points')
const csv = ref('')
const mapping = ref<Record<string, string>>({})
const valueMap = ref<Record<string, string>>({}) // CSV type value → our device_type.id
const plan = ref<Plan | null>(null)
const summary = ref<Summary | null>(null)
const busy = ref(false)
const err = ref('')

const types = ref<DeviceType[]>([])
// Reka UI (Nuxt UI v3) forbids a SelectItem with value='' → placeholder via prop,
// not as an option. Unmapped = valueMap[v] undefined → row blocked.
const typeItems = computed(() => types.value.map(ty => ({ label: ty.name, value: ty.id })))
// A devices CSV with types → our types are needed for value mapping. Small table (no pagination).
onMounted(loadTypes)
watch(session, (s, prev) => { if (s && !prev) loadTypes() })
async function loadTypes() {
  const { data } = await supabase.from('device_types').select('id,slug,name,icon,color,default_action,sort').order('sort')
  types.value = (data ?? []) as DeviceType[]
}

const kindItems = computed(() => [
  { label: t('import.kindPoints'), value: 'points' },
  { label: t('import.kindDevices'), value: 'devices' },
  { label: t('import.kindContacts'), value: 'contacts' },
])
const headerItems = computed(() => (plan.value?.headers ?? []).map(h => ({ label: h, value: h })))
const shownDiff = computed(() => plan.value?.diff.slice(0, DIFF_CAP) ?? [])
const hiddenCount = computed(() => Math.max(0, (plan.value?.diff.length ?? 0) - DIFF_CAP))
const statusColor: Record<string, string> = { new: 'success', update: 'warning', skip: 'neutral' }

// A readable row identifier (not the internal composite key point+host):
// points → «#147 · Address»; devices → «192.0.2.5 · point #147»;
// contacts → «+380000000000 · point #147».
function rowLabel(row: Row): string {
  if (kind.value === 'points')
    return `#${row.number}${row.address ? ` · ${row.address}` : ''}`
  if (kind.value === 'contacts')
    return `${row.value} · ${t('import.pointShort', { n: row.point })}`
  return `${row.host} · ${t('import.pointShort', { n: row.point })}`
}

function reset() { plan.value = null; summary.value = null; err.value = '' }
watch(kind, () => { reset(); mapping.value = {}; valueMap.value = {} })

async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) { csv.value = await file.text(); reset() }
}

async function downloadTemplate() {
  const text = await $fetch<string>('/api/import/template', { query: { kind: kind.value }, headers: authHeaders.value })
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `import-${kind.value}-template.csv`
  a.click()
  URL.revokeObjectURL(url)
}

const msg = (e: unknown) => (e as { statusMessage?: string })?.statusMessage ?? String(e)

async function runPreview() {
  if (!csv.value.trim()) return
  busy.value = true; err.value = ''; summary.value = null
  try {
    const resp = await $fetch<Plan>('/api/import/preview', {
      method: 'POST', headers: authHeaders.value,
      body: { kind: kind.value, csv: csv.value, mapping: mapping.value, valueMap: valueMap.value },
    })
    plan.value = resp
    mapping.value = { ...resp.mapping }
  }
  catch (e) { err.value = t('import.error', { message: msg(e) }) }
  finally { busy.value = false }
}

async function runImport() {
  busy.value = true; err.value = ''
  try {
    summary.value = await $fetch<Summary>('/api/import/confirm', {
      method: 'POST', headers: authHeaders.value,
      body: { kind: kind.value, csv: csv.value, mapping: mapping.value, valueMap: valueMap.value },
    })
    plan.value = null
  }
  catch (e) { err.value = t('import.error', { message: msg(e) }) }
  finally { busy.value = false }
}
</script>

<template>
  <AdminPage :title="t('import.title')" :subtitle="t('import.subtitle')">
    <div class="flex flex-col gap-4">

    <div class="flex items-center gap-2">
      <UButtonGroup>
        <UButton
          v-for="it in kindItems" :key="it.value"
          :variant="kind === it.value ? 'solid' : 'outline'" color="primary" size="sm"
          @click="kind = it.value as Kind"
        >
          {{ it.label }}
        </UButton>
      </UButtonGroup>
      <UButton variant="ghost" color="neutral" size="sm" icon="i-lucide-download" class="ml-auto" @click="downloadTemplate">
        {{ t('import.downloadTemplate') }}
      </UButton>
    </div>

    <UFormField :label="t('import.csvLabel')">
      <UTextarea v-model="csv" :rows="6" class="w-full font-mono text-xs" @update:model-value="reset" />
    </UFormField>
    <label class="text-xs text-muted">
      {{ t('import.fileLabel') }}
      <input type="file" accept=".csv,text/csv" class="block mt-1 text-xs" @change="onFile">
    </label>

    <UButton :loading="busy" :disabled="!csv.trim()" icon="i-lucide-eye" class="self-start" @click="runPreview">
      {{ t('import.analyze') }}
    </UButton>

    <UAlert v-if="err" color="error" variant="soft" :description="err" />
    <UAlert
      v-if="summary" color="success" variant="soft" icon="i-lucide-check"
      :title="t('import.resultOk', summary)"
      :description="summary.failed.length ? t('import.resultFailed', { count: summary.failed.length }) : undefined"
    />

    <template v-if="plan">
      <UCard>
        <template #header>
          <span class="font-medium">{{ t('import.mappingTitle') }}</span>
          <p class="text-xs text-muted mt-1">{{ t('import.mappingHint') }}</p>
        </template>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
          <UFormField v-for="f in FIELDS[kind]" :key="f" :label="t(`import.field.${f}`)">
            <USelect v-model="mapping[f]" :items="headerItems" :placeholder="t('import.none')" class="w-full" @update:model-value="runPreview" />
          </UFormField>
        </div>
      </UCard>

      <!-- type value mapping (devices): their values → our device_types -->
      <UCard v-if="kind === 'devices' && plan.typeValues.length">
        <template #header>
          <span class="font-medium">{{ t('import.valueMapTitle') }}</span>
          <p class="text-xs text-muted mt-1">{{ t('import.valueMapHint') }}</p>
        </template>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          <UFormField v-for="v in plan.typeValues" :key="v" :label="v">
            <USelect v-model="valueMap[v]" :items="typeItems" :placeholder="t('import.selectType')" class="w-full" @update:model-value="runPreview" />
          </UFormField>
        </div>
      </UCard>

      <UAlert
        v-if="plan.malformed.length" color="warning" variant="soft" icon="i-lucide-triangle-alert"
        :title="t('import.malformedTitle', { count: plan.malformed.length })"
      >
        <template #description>
          <ul class="text-xs list-disc pl-4 max-h-40 overflow-y-auto">
            <li v-for="(er, i) in plan.malformed" :key="i">{{ t('import.malformedLine', er) }}</li>
          </ul>
        </template>
      </UAlert>

      <UAlert
        v-if="plan.blocked.length" color="error" variant="soft" icon="i-lucide-ban"
        :title="t('import.blockedTitle', { count: plan.blocked.length })"
      >
        <template #description>
          <ul class="text-xs list-disc pl-4 max-h-40 overflow-y-auto">
            <li v-for="(b, i) in plan.blocked" :key="i">{{ rowLabel(b.row) }} — {{ b.reason }}</li>
          </ul>
        </template>
      </UAlert>

      <UCard>
        <template #header>
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium">{{ t('import.diffTitle') }}</span>
            <span class="text-xs text-muted">{{ t('import.counts', plan.counts) }}</span>
          </div>
        </template>
        <div class="max-h-80 overflow-y-auto">
          <table class="w-full text-xs">
            <thead class="text-muted text-left">
              <tr><th class="py-1 pr-3">{{ t('import.colStatus') }}</th><th class="py-1">{{ t('import.colKey') }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="(d, i) in shownDiff" :key="i" class="border-t border-default">
                <td class="py-1 pr-3">
                  <UBadge :color="statusColor[d.status]" variant="soft" size="sm">{{ t(`import.status.${d.status}`) }}</UBadge>
                </td>
                <td class="py-1">{{ rowLabel(d.row) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="hiddenCount" class="text-xs text-muted pt-2">{{ t('import.diffMore', { count: hiddenCount }) }}</p>
        </div>
        <template #footer>
          <UButton
            :loading="busy" color="primary" icon="i-lucide-upload"
            :disabled="plan.counts.new + plan.counts.update === 0"
            @click="runImport"
          >
            {{ t('import.confirm', { count: plan.counts.new + plan.counts.update }) }}
          </UButton>
        </template>
      </UCard>
    </template>
    </div>
  </AdminPage>
</template>
