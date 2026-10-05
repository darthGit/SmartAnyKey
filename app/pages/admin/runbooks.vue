<script setup lang="ts">
// Admin UI for runbooks (tier Mid). CSR, Nuxt UI, i18n (ADR-006).
// The list is a client select under RLS (require-profile); CRUD — BFF service_role
// with Bearer. Type = all device_types (few); point = server-side
// search (points 300+). Body is markdown (rendered in the point card).
const { t } = useI18n()
const supabase = useSupabaseClient()
const session = useSupabaseSession()
const authHeaders = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

interface RunbookRow {
  id: string
  type_id: string | null
  point_id: string | null
  title: string
  body: string
  sort: number
  device_types: { name: string } | null
  points: { number: number } | null
}

const rows = ref<RunbookRow[]>([])
const loadErr = ref('')
const types = ref<{ label: string, value: string }[]>([])

async function load() {
  const { data, error } = await supabase.from('runbooks')
    .select('id,type_id,point_id,title,body,sort,device_types(name),points(number)')
    .order('sort').order('title')
  if (error) {
    loadErr.value = error.message
    return
  }
  rows.value = (data ?? []) as unknown as RunbookRow[]
}
async function loadTypes() {
  const { data } = await supabase.from('device_types').select('id,name').order('sort')
  types.value = (data ?? []).map((r: { id: string, name: string }) => ({ label: r.name, value: r.id }))
}
// SPA: wait for the session before an RLS fetch (client-side auth timing).
watch(session, (s, prev) => { if (s && !prev) { load(); loadTypes() } }, { immediate: true })

// --- point (optional override) = server-side search ----------------------
type PointRow = { id: string, number: number, address: string }
const pointResults = ref<PointRow[]>([])
const pointSearchTerm = ref('')
const chosenPoint = ref<PointRow | null>(null)
const asItem = (p: PointRow) => ({ label: `#${p.number} — ${p.address}`, value: p.id })
const pointItems = computed(() => {
  const list = pointResults.value.map(asItem)
  const c = chosenPoint.value
  if (c && !list.some(i => i.value === c.id))
    list.unshift(asItem(c))
  return list
})
async function searchPoints(term: string) {
  const clean = term.replace(/[(),]/g, '').trim()
  const like = `%${clean}%`
  const or = /^\d+$/.test(clean) ? `number.eq.${clean},address.ilike.${like}` : `address.ilike.${like}`
  const { data } = await supabase.from('points').select('id,number,address').or(or).order('number').limit(30)
  pointResults.value = (data ?? []) as PointRow[]
}
let pointTimer: ReturnType<typeof setTimeout>
watch(pointSearchTerm, (term) => {
  clearTimeout(pointTimer)
  pointTimer = setTimeout(() => searchPoints(term), 250)
})

// --- create / edit -------------------------------------------------------
const formOpen = ref(false)
const editing = ref<RunbookRow | null>(null)
const form = reactive<{ type_id: string | null, point_id: string | null, title: string, body: string, sort: number }>({
  type_id: null, point_id: null, title: '', body: '', sort: 0,
})
const saveErr = ref('')

function openNew() {
  editing.value = null
  Object.assign(form, { type_id: null, point_id: null, title: '', body: '', sort: 0 })
  chosenPoint.value = null
  saveErr.value = ''
  formOpen.value = true
}
function openEdit(r: RunbookRow) {
  editing.value = r
  Object.assign(form, { type_id: r.type_id, point_id: r.point_id, title: r.title, body: r.body, sort: r.sort })
  chosenPoint.value = r.point_id && r.points ? { id: r.point_id, number: r.points.number, address: '' } : null
  saveErr.value = ''
  formOpen.value = true
}
watch(() => form.point_id, (id) => {
  if (id && pointResults.value.length)
    chosenPoint.value = pointResults.value.find(p => p.id === id) ?? chosenPoint.value
})

async function save() {
  saveErr.value = ''
  try {
    const body = { type_id: form.type_id || null, point_id: form.point_id || null, title: form.title, body: form.body, sort: form.sort }
    if (editing.value)
      await $fetch(`/api/admin/runbooks/${editing.value.id}`, { method: 'PATCH', headers: authHeaders.value, body })
    else
      await $fetch('/api/admin/runbooks', { method: 'POST', headers: authHeaders.value, body })
    formOpen.value = false
    await load()
  }
  catch (e) {
    saveErr.value = t('runbooks.admin.saveError', { message: (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message })
  }
}
async function remove(r: RunbookRow) {
  if (!confirm(t('runbooks.admin.deleteConfirm', { title: r.title })))
    return
  await $fetch(`/api/admin/runbooks/${r.id}`, { method: 'DELETE', headers: authHeaders.value })
  await load()
}

const scopeLabel = (r: RunbookRow) => {
  const type = r.device_types?.name ?? t('runbooks.admin.allTypes')
  return r.point_id ? t('runbooks.admin.scopePoint', { type, n: r.points?.number ?? '?' }) : type
}
</script>

<template>
  <AdminPage :title="t('runbooks.admin.title')" :subtitle="t('runbooks.admin.subtitle')">
    <template #actions>
      <UButton icon="i-lucide-plus" @click="openNew">{{ t('runbooks.admin.new') }}</UButton>
    </template>

    <p v-if="loadErr" class="mb-3 text-sm text-error">{{ loadErr }}</p>
    <p v-if="!rows.length" class="text-muted">{{ t('runbooks.admin.empty') }}</p>
    <ul v-else class="divide-y divide-default rounded ring ring-default">
      <li v-for="r in rows" :key="r.id" class="flex items-center gap-3 p-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="font-medium text-highlighted">{{ r.title }}</span>
            <UBadge size="xs" color="neutral" variant="subtle">{{ scopeLabel(r) }}</UBadge>
          </div>
          <p class="line-clamp-1 text-xs text-muted">{{ r.body }}</p>
        </div>
        <UButton size="xs" variant="ghost" color="neutral" @click="openEdit(r)">{{ t('runbooks.admin.edit') }}</UButton>
        <UButton size="xs" variant="ghost" color="error" @click="remove(r)">{{ t('runbooks.admin.delete') }}</UButton>
      </li>
    </ul>

    <UModal v-model:open="formOpen" :title="editing ? t('runbooks.admin.edit') : t('runbooks.admin.new')" :ui="{ content: 'max-w-3xl' }">
      <template #body>
        <div class="flex flex-col gap-3">
          <UFormField :label="t('runbooks.admin.titleField')">
            <UInput v-model="form.title" class="w-full" />
          </UFormField>
          <div class="flex flex-wrap gap-3">
            <UFormField :label="t('runbooks.admin.type')" :description="t('runbooks.admin.typeHint')" class="w-64">
              <USelect
                v-model="form.type_id"
                :items="[{ label: t('runbooks.admin.allTypes'), value: null }, ...types]"
                value-key="value"
              />
            </UFormField>
            <UFormField :label="t('runbooks.admin.point')" :description="t('runbooks.admin.pointHint')" class="w-64">
              <USelectMenu
                v-model="form.point_id"
                v-model:search-term="pointSearchTerm"
                :items="[{ label: t('runbooks.admin.anyPoint'), value: null }, ...pointItems]"
                value-key="value"
                ignore-filter
                :placeholder="t('runbooks.admin.pointSearch')"
              />
            </UFormField>
            <UFormField :label="t('runbooks.admin.sort')" class="w-24">
              <UInput v-model.number="form.sort" type="number" />
            </UFormField>
          </div>
          <UFormField :label="t('runbooks.admin.body')" :description="t('runbooks.admin.bodyHint')">
            <UTextarea v-model="form.body" :rows="10" class="w-full font-mono" />
          </UFormField>
          <p v-if="saveErr" class="text-sm text-error">{{ saveErr }}</p>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="formOpen = false">{{ t('runbooks.admin.cancel') }}</UButton>
        <UButton color="primary" :disabled="!form.title || !form.body" @click="save">{{ t('runbooks.admin.save') }}</UButton>
      </template>
    </UModal>
  </AdminPage>
</template>
