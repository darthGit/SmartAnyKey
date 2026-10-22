<script setup lang="ts">
// Admin UI: device type CRUD. CSR, Nuxt UI,
// i18n (ADR-006). The client manages its own taxonomy (domain-agnostic). Read directly
// (RLS authenticated); mutations through the BFF (service_role, requireRole admin). Small
// table → no pagination (unlike devices/points).
import type { DeviceType } from '~/types/board'

const { t } = useI18n()
const supabase = useSupabaseClient()
const session = useSupabaseSession()
const authHeaders = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

const types = ref<DeviceType[]>([])
const loadErr = ref('')

const ACTIONS = ['vnc', 'rdp', 'ssh', 'web']
// the default is one of the ticked protocols (the DB constraint holds the same)
const actionItems = computed(() => form.actions.map(v => ({ label: v, value: v })))

async function load() {
  const { data, error } = await supabase
    .from('device_types').select('id,slug,name,icon,color,default_action,actions,sort').order('sort')
  if (error)
    loadErr.value = t('deviceTypes.loadError', { message: error.message })
  else
    types.value = (data ?? []) as DeviceType[]
}

// SPA: gate the fetch on the session (otherwise RLS → empty on first render).
onMounted(load)
watch(session, (s, prev) => { if (s && !prev) load() })

// --- create / edit -------------------------------------------------------
const formOpen = ref(false)
const editing = ref<DeviceType | null>(null)
const form = reactive({ name: '', slug: '', icon: '💻', color: '#a855f7', default_action: 'vnc', actions: ['vnc'] as string[], sort: 0 })
const saveErr = ref('')

// The type's protocols: an empty column means just default_action (old types, seeds).
const typeActions = (ty: DeviceType) => (ty.actions?.length ? ty.actions : [ty.default_action])

function openNew() {
  editing.value = null
  Object.assign(form, { name: '', slug: '', icon: 'i-lucide-box', color: '#a855f7', default_action: 'vnc', actions: ['vnc'], sort: 0 })
  saveErr.value = ''
  formOpen.value = true
}
function openEdit(ty: DeviceType) {
  editing.value = ty
  Object.assign(form, { name: ty.name, slug: ty.slug, icon: ty.icon, color: ty.color, default_action: ty.default_action, actions: [...typeActions(ty)], sort: ty.sort })
  saveErr.value = ''
  formOpen.value = true
}
function toggleAction(a: string) {
  form.actions = form.actions.includes(a) ? form.actions.filter(x => x !== a) : ACTIONS.filter(x => x === a || form.actions.includes(x))
  if (!form.actions.includes(form.default_action) && form.actions.length)
    form.default_action = form.actions[0]!
}

const msg = (e: unknown) => (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message

async function save() {
  saveErr.value = ''
  const body = { ...form }
  const before = editing.value
  try {
    if (before)
      await $fetch(`/api/admin/device-types/${before.id}`, { method: 'PATCH', headers: authHeaders.value, body })
    else
      await $fetch('/api/admin/device-types', { method: 'POST', headers: authHeaders.value, body })
    formOpen.value = false
    await load()
    // a protocol was added → offer it to the devices that already exist (new ones get it anyway)
    if (before && form.actions.some(a => !typeActions(before).includes(a)))
      await applyToDevices({ ...before, ...form })
  }
  catch (e) {
    saveErr.value = t('deviceTypes.saveError', { message: msg(e) })
  }
}

// "Apply to existing": add the type's protocols to its devices that miss them. Adds only.
const applyMsg = ref('')
async function applyToDevices(ty: DeviceType) {
  applyMsg.value = ''
  try {
    const { missing } = await $fetch<{ missing: number }>(`/api/admin/device-types/${ty.id}/apply-actions`, { headers: authHeaders.value })
    if (!missing) {
      applyMsg.value = t('deviceTypes.applyNone', { name: ty.name })
      return
    }
    if (!confirm(t('deviceTypes.applyConfirm', { protocols: typeActions(ty).join(', '), count: missing, name: ty.name })))
      return
    const { updated } = await $fetch<{ updated: number }>(`/api/admin/device-types/${ty.id}/apply-actions`, { method: 'POST', headers: authHeaders.value })
    applyMsg.value = t('deviceTypes.applyDone', { count: updated, name: ty.name })
  }
  catch (e) {
    applyMsg.value = t('deviceTypes.saveError', { message: msg(e) })
  }
}

const deleteErr = ref('')
async function remove(ty: DeviceType) {
  deleteErr.value = ''
  if (!confirm(t('deviceTypes.deleteConfirm', { name: ty.name })))
    return
  try {
    await $fetch(`/api/admin/device-types/${ty.id}`, { method: 'DELETE', headers: authHeaders.value })
    await load()
  }
  catch (e) {
    // A type in use → a human error with the count (409), not silent.
    deleteErr.value = t('deviceTypes.deleteError', { name: ty.name, message: msg(e) })
  }
}
</script>

<template>
  <AdminPage :title="t('deviceTypes.title')" :subtitle="t('deviceTypes.subtitle')">
    <template #actions>
      <UButton icon="i-lucide-plus" @click="openNew">{{ t('deviceTypes.new') }}</UButton>
    </template>

    <p v-if="loadErr" class="mb-3 text-sm text-error">{{ loadErr }}</p>
    <p v-if="deleteErr" class="mb-3 text-sm text-error">{{ deleteErr }}</p>
    <p v-if="applyMsg" class="mb-3 text-sm text-muted" data-testid="apply-msg">{{ applyMsg }}</p>

    <p v-if="!types.length" class="text-muted">{{ t('deviceTypes.empty') }}</p>
    <ul v-else class="divide-y divide-default rounded ring ring-default">
      <li v-for="ty in types" :key="ty.id" class="flex items-center gap-3 p-3">
        <span class="w-6 shrink-0 text-center text-lg leading-none">{{ resolveDeviceIcon(ty.icon) }}</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="font-medium text-highlighted">{{ ty.name }}</span>
            <UBadge size="xs" color="neutral" variant="subtle">{{ ty.slug }}</UBadge>
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-1">
            <UBadge
              v-for="a in typeActions(ty)"
              :key="a"
              size="xs"
              :color="a === ty.default_action ? 'info' : 'neutral'"
              :variant="a === ty.default_action ? 'subtle' : 'outline'"
              :title="a === ty.default_action ? t('deviceTypes.defaultAction') : undefined"
            >
              {{ a }}
            </UBadge>
          </div>
        </div>
        <span class="shrink-0 text-xs text-muted tabular-nums" data-testid="type-sort">{{ t('deviceTypes.sortShort', { n: ty.sort }) }}</span>
        <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-copy-check" :title="t('deviceTypes.applyHint')" @click="applyToDevices(ty)">{{ t('deviceTypes.apply') }}</UButton>
        <UButton size="xs" variant="ghost" color="neutral" @click="openEdit(ty)">{{ t('deviceTypes.edit') }}</UButton>
        <UButton size="xs" variant="ghost" color="error" @click="remove(ty)">{{ t('deviceTypes.delete') }}</UButton>
      </li>
    </ul>

    <UModal v-model:open="formOpen" :title="editing ? t('deviceTypes.edit') : t('deviceTypes.new')">
      <template #body>
        <div class="flex flex-col gap-3">
          <div class="flex gap-3">
            <UFormField :label="t('deviceTypes.name')" class="flex-1">
              <UInput v-model="form.name" class="w-full" />
            </UFormField>
            <UFormField :label="t('deviceTypes.slug')" :help="t('deviceTypes.slugHint')" class="flex-1">
              <UInput v-model="form.slug" class="w-full font-mono" placeholder="pos" />
            </UFormField>
          </div>
          <div class="flex gap-3">
            <UFormField :label="t('deviceTypes.icon')" :help="t('deviceTypes.iconHint')" class="flex-1">
              <UInput v-model="form.icon" class="w-full" placeholder="💻" />
            </UFormField>
            <UFormField :label="t('deviceTypes.color')" class="w-28">
              <UInput v-model="form.color" type="color" class="w-full" />
            </UFormField>
          </div>
          <UFormField :label="t('deviceTypes.actions')" :help="t('deviceTypes.actionsHint')">
            <div class="flex flex-wrap gap-3">
              <UCheckbox
                v-for="a in ACTIONS"
                :key="a"
                :model-value="form.actions.includes(a)"
                :label="t(`action.${a}`)"
                :data-action="`type-action-${a}`"
                @update:model-value="toggleAction(a)"
              />
            </div>
          </UFormField>
          <div class="flex gap-3">
            <UFormField :label="t('deviceTypes.defaultAction')" class="w-40">
              <USelect v-model="form.default_action" :items="actionItems" />
            </UFormField>
            <UFormField :label="t('deviceTypes.sort')" class="w-28">
              <UInput v-model.number="form.sort" type="number" />
            </UFormField>
          </div>
          <p v-if="saveErr" class="text-sm text-error">{{ saveErr }}</p>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="formOpen = false">{{ t('deviceTypes.cancel') }}</UButton>
        <UButton color="primary" :disabled="!form.name || !form.slug || !form.actions.length" @click="save">{{ t('deviceTypes.save') }}</UButton>
      </template>
    </UModal>
  </AdminPage>
</template>
