<script setup lang="ts">
// Admin UI for auto-discovery signature rules (ADR-012). CSR, Nuxt UI,
// i18n (ADR-006). The client's rules on its own device_types — the engine is domain-agnostic;
// the table ships empty. device_types + signatures are read client-side
// (RLS select-authenticated); CRUD — through the BFF (service_role) with pattern validation.
import type { DeviceType, DeviceTypeSignature } from '~/types/board'

const { t } = useI18n()
const supabase = useSupabaseClient()
const session = useSupabaseSession()
const authHeaders = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

const types = ref<DeviceType[]>([])
const typeId = ref<string | null>(null)
const signatures = ref<DeviceTypeSignature[]>([])
const loadErr = ref('')
const preview = ref<{ hosts: number, wins: number, full: number, partial: number } | null>(null)

const typeItems = computed(() => types.value.map(ty => ({ label: ty.name, value: ty.id })))
const signalItems = ['ip_range', 'port', 'banner', 'cert', 'os'].map(v => ({ label: v, value: v }))
// a sample pattern per signal (technical values, not UI copy — like 'raw'/'bash')
const EXAMPLES: Record<string, string> = {
  ip_range: '192.0.2.0/24',
  port: '22',
  banner: 'MikroTik RouterOS',
  cert: 'pos-(\\d+)',
  os: 'Linux',
}
const patternExample = computed(() => EXAMPLES[form.signal_type] ?? '')
const captureItems = computed(() => [
  { label: t('discovery.admin.captureNone'), value: 'none' },
  { label: t('discovery.admin.captureHostname'), value: 'hostname' },
  { label: t('discovery.admin.capturePoint'), value: 'point_number' },
])

async function loadTypes() {
  const { data } = await supabase.from('device_types').select('id,slug,name,icon,color,default_action,sort').order('sort')
  types.value = (data ?? []) as DeviceType[]
  if (!typeId.value && types.value.length)
    typeId.value = types.value[0]!.id
}

async function loadSignatures() {
  if (!typeId.value)
    return
  const { data, error } = await supabase
    .from('device_type_signatures')
    .select('id,type_id,signal_type,pattern,capture_target,weight')
    .eq('type_id', typeId.value).order('id')
  if (error)
    loadErr.value = t('discovery.admin.loadError', { message: error.message })
  else
    signatures.value = (data ?? []) as DeviceTypeSignature[]
  await loadPreview()
}

// "Will the rule fire": how many recently scanned hosts would yield this type.
async function loadPreview() {
  if (!typeId.value) { preview.value = null; return }
  preview.value = await $fetch('/api/admin/signatures/preview', {
    query: { typeId: typeId.value }, headers: authHeaders.value,
  }).catch(() => null)
}

onMounted(async () => { await loadTypes(); await loadSignatures() })
watch(typeId, loadSignatures)

// --- create / edit -------------------------------------------------------
const formOpen = ref(false)
const editing = ref<DeviceTypeSignature | null>(null)
const form = reactive({ signal_type: 'port', pattern: '', capture_target: 'none', weight: 50 })
const saveErr = ref('')

function openNew() {
  editing.value = null
  Object.assign(form, { signal_type: 'port', pattern: '', capture_target: 'none', weight: 50 })
  saveErr.value = ''
  formOpen.value = true
}
function openEdit(s: DeviceTypeSignature) {
  editing.value = s
  Object.assign(form, {
    signal_type: s.signal_type, pattern: s.pattern,
    capture_target: s.capture_target ?? 'none', weight: s.weight,
  })
  saveErr.value = ''
  formOpen.value = true
}

async function save() {
  saveErr.value = ''
  const body = {
    signal_type: form.signal_type,
    pattern: form.pattern,
    capture_target: form.capture_target === 'none' ? null : form.capture_target,
    weight: form.weight,
  }
  try {
    if (editing.value)
      await $fetch(`/api/admin/signatures/${editing.value.id}`, { method: 'PATCH', headers: authHeaders.value, body })
    else
      await $fetch('/api/admin/signatures', { method: 'POST', headers: authHeaders.value, body: { type_id: typeId.value, ...body } })
    formOpen.value = false
    await loadSignatures()
  }
  catch (e) {
    saveErr.value = t('discovery.admin.saveError', { message: (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message })
  }
}

async function remove(s: DeviceTypeSignature) {
  if (!confirm(t('discovery.admin.deleteConfirm')))
    return
  await $fetch(`/api/admin/signatures/${s.id}`, { method: 'DELETE', headers: authHeaders.value })
  await loadSignatures()
}
</script>

<template>
  <AdminPage :title="t('discovery.admin.title')" :subtitle="t('discovery.admin.subtitle')">

    <div class="mb-4 flex flex-col gap-1 rounded ring ring-default bg-elevated p-3 text-sm">
      <p class="text-muted">{{ t('discovery.admin.help') }}</p>
      <p class="text-muted">{{ t('discovery.admin.matching') }}</p>
      <p class="text-warning">{{ t('discovery.admin.tipStrong') }}</p>
    </div>

    <div class="mb-4 flex items-end gap-3">
      <UFormField :label="t('discovery.admin.type')" class="w-64">
        <USelect v-model="typeId" :items="typeItems" />
      </UFormField>
      <UButton icon="i-lucide-plus" class="ml-auto" @click="openNew">{{ t('discovery.admin.new') }}</UButton>
    </div>

    <p v-if="loadErr" class="mb-3 text-sm text-error">{{ loadErr }}</p>

    <p v-if="preview" class="mb-3 text-sm" :class="preview.wins ? 'text-muted' : 'text-warning'">
      <template v-if="preview.hosts">{{ t('discovery.admin.preview', { wins: preview.wins, hosts: preview.hosts, full: preview.full, partial: preview.partial }) }}</template>
      <template v-else>{{ t('discovery.admin.previewNone') }}</template>
    </p>

    <p v-if="!signatures.length" class="text-muted">{{ t('discovery.admin.empty') }}</p>
    <ul v-else class="divide-y divide-default rounded ring ring-default">
      <li v-for="s in signatures" :key="s.id" class="flex items-center gap-3 p-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <UBadge size="xs" color="neutral" variant="subtle">{{ s.signal_type }}</UBadge>
            <code class="line-clamp-1 text-xs text-highlighted">{{ s.pattern }}</code>
            <UBadge v-if="s.capture_target" size="xs" color="info" variant="subtle">→ {{ s.capture_target }}</UBadge>
          </div>
          <span class="text-xs text-muted">{{ t('discovery.admin.weight') }}: {{ s.weight }}</span>
        </div>
        <UButton size="xs" variant="ghost" color="neutral" @click="openEdit(s)">{{ t('discovery.admin.edit') }}</UButton>
        <UButton size="xs" variant="ghost" color="error" @click="remove(s)">{{ t('discovery.admin.delete') }}</UButton>
      </li>
    </ul>

    <UModal v-model:open="formOpen" :title="editing ? t('discovery.admin.edit') : t('discovery.admin.new')">
      <template #body>
        <div class="flex flex-col gap-3">
          <div class="flex gap-3">
            <UFormField :label="t('discovery.admin.signalType')" class="w-40">
              <USelect v-model="form.signal_type" :items="signalItems" />
            </UFormField>
            <UFormField :label="t('discovery.admin.captureTarget')" class="w-44">
              <USelect v-model="form.capture_target" :items="captureItems" />
            </UFormField>
          </div>
          <UFormField
            :label="t('discovery.admin.pattern')"
            :help="`${t('discovery.admin.patternHint')} · ${t('discovery.admin.example', { example: patternExample })}`"
          >
            <UInput v-model="form.pattern" class="w-full font-mono" :placeholder="patternExample" />
          </UFormField>
          <UFormField :label="t('discovery.admin.weight')" :help="t('discovery.admin.weightHint')" class="w-40">
            <UInput v-model.number="form.weight" type="number" min="1" max="100" />
          </UFormField>
          <p v-if="saveErr" class="text-sm text-error">{{ saveErr }}</p>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="formOpen = false">{{ t('discovery.admin.cancel') }}</UButton>
        <UButton color="primary" :disabled="!form.pattern" @click="save">{{ t('discovery.admin.save') }}</UButton>
      </template>
    </UModal>
  </AdminPage>
</template>
