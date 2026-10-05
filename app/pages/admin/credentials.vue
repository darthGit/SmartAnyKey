<script setup lang="ts">
// Admin UI of the credential manager (ADR-009).
// CSR, Nuxt UI, i18n (ADR-006). Password is write-only: the form NEVER shows the
// existing one — empty = keep. Binding keyed by (level, action). Data goes
// through the BFF (service_role); the client never reads credential_sets/bindings directly.
const { t } = useI18n()
const supabase = useSupabaseClient()
// The credentials BFF routes gate on requireRole('admin') → every $fetch must carry
// Bearer (the cookie path of requireUser does not normalize user.id → 403).
const session = useSupabaseSession()
const authHeaders = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

interface CredSet { id: string, name: string, username: string | null, port: number | null }
interface Binding {
  id: string
  level: string
  target_id: string | null
  action: string
  cred_set_id: string
  credential_sets: { name: string } | null
}

const sets = ref<CredSet[]>([])
const bindings = ref<Binding[]>([])
const loadErr = ref('')

async function load() {
  try {
    sets.value = await $fetch<CredSet[]>('/api/credentials', { headers: authHeaders.value })
    bindings.value = await $fetch<Binding[]>('/api/credentials/bindings', { headers: authHeaders.value })
  }
  catch (e) {
    loadErr.value = t('credentials.loadError', { message: (e as Error).message })
  }
}
onMounted(load)

// --- create / edit -------------------------------------------------------
const formOpen = ref(false)
const editing = ref<CredSet | null>(null)
const form = reactive({ name: '', username: '', password: '', port: '' })
const saveErr = ref('')

function openNew() {
  editing.value = null
  Object.assign(form, { name: '', username: '', password: '', port: '' })
  saveErr.value = ''
  formOpen.value = true
}
function openEdit(s: CredSet) {
  editing.value = s
  // the password is NOT loaded — write-only
  Object.assign(form, { name: s.name, username: s.username ?? '', password: '', port: s.port != null ? String(s.port) : '' })
  saveErr.value = ''
  formOpen.value = true
}

async function save() {
  saveErr.value = ''
  const payload: Record<string, unknown> = {
    name: form.name,
    username: form.username || null,
    port: form.port ? Number(form.port) : null,
  }
  if (form.password) payload.password = form.password // empty → leave as is
  try {
    if (editing.value)
      await $fetch(`/api/credentials/${editing.value.id}`, { method: 'PATCH', headers: authHeaders.value, body: payload })
    else
      await $fetch('/api/credentials', { method: 'POST', headers: authHeaders.value, body: payload })
    formOpen.value = false
    await load()
  }
  catch (e) {
    saveErr.value = t('credentials.saveError', { message: (e as Error).message })
  }
}

async function remove(s: CredSet) {
  if (!confirm(t('credentials.deleteConfirm', { name: s.name })))
    return
  await $fetch(`/api/credentials/${s.id}`, { method: 'DELETE', headers: authHeaders.value })
  await load()
}

// --- assign (keyed by level × action) ------------------------------------
// credSetId === 'none' → remove the binding (Reka UI forbids value='').
const assign = reactive<{ level: 'device' | 'type' | 'point' | 'global', action: 'ssh' | 'vnc' | 'rdp', targetId: string | null, credSetId: string }>({
  level: 'type', action: 'ssh', targetId: null, credSetId: 'none',
})
const targets = ref<{ label: string, value: string }[]>([])
const targetSearch = ref('')
const targetLoading = ref(false)
const assignMsg = ref('')

const levelItems = computed(() => [
  { label: t('credentials.levelType'), value: 'type' },
  { label: t('credentials.levelPoint'), value: 'point' },
  { label: t('credentials.levelDevice'), value: 'device' },
  { label: t('credentials.levelGlobal'), value: 'global' },
])
const actionItems = [
  { label: t('action.ssh'), value: 'ssh' },
  { label: t('action.vnc'), value: 'vnc' },
  { label: t('action.rdp'), value: 'rdp' },
]
const setItems = computed(() => [
  { label: t('credentials.unassigned'), value: 'none' },
  ...sets.value.map(s => ({ label: s.name, value: s.id })),
])
const isGlobal = computed(() => assign.level === 'global')

// Server-side target search (ilike + limit): 2000+ devices → PGRST cuts at 1000,
// and a client filter over the truncated list is incomplete and slow (the
// PGRST_DB_MAX_ROWS trap). Fetch only matches, up to 30.
async function loadTargets(term: string) {
  if (assign.level === 'global') {
    targets.value = []
    return
  }
  // Strip commas/parentheses — they break PostgREST .or() syntax.
  const clean = term.replace(/[(),]/g, '').trim()
  const like = `%${clean}%`
  const isNum = /^\d+$/.test(clean)
  targetLoading.value = true
  try {
    if (assign.level === 'type') {
      const { data } = await supabase.from('device_types').select('id,name').ilike('name', like).order('sort').limit(50)
      targets.value = (data ?? []).map((r: { id: string, name: string }) => ({ label: r.name, value: r.id }))
    }
    else if (assign.level === 'point') {
      // point number OR address
      const or = isNum ? `number.eq.${clean},address.ilike.${like}` : `address.ilike.${like}`
      const { data } = await supabase.from('points').select('id,number,address').or(or).order('number').limit(30)
      targets.value = (data ?? []).map((r: { id: string, number: number, address: string }) => ({ label: `#${r.number} — ${r.address}`, value: r.id }))
    }
    else {
      // Combined device search: label OR host IP (own columns) + point number
      // (inner join, separate query — PostgREST cannot OR an embedded column).
      const byOwn = supabase.from('devices').select('id,label,host,points(number)').or(`label.ilike.${like},host.ilike.${like}`).order('label').limit(30)
      const byPoint = isNum
        ? supabase.from('devices').select('id,label,host,points!inner(number)').eq('points.number', Number(clean)).limit(30)
        : Promise.resolve({ data: [] as unknown[] })
      const [r1, r2] = await Promise.all([byOwn, byPoint])
      type Row = { id: string, label: string, host: string, points: { number: number } | null }
      const merged = new Map<string, Row>()
      for (const r of [...(r1.data ?? []), ...(r2.data ?? [])] as Row[]) merged.set(r.id, r)
      targets.value = [...merged.values()].slice(0, 30).map(r => ({
        label: `#${r.points?.number ?? '?'} · ${r.label} · ${r.host}`, value: r.id,
      }))
    }
  }
  finally {
    targetLoading.value = false
  }
}
watch(() => assign.level, () => {
  assign.targetId = null
  targetSearch.value = ''
  loadTargets('')
}, { immediate: true })
// ponytail: manual debounce (250ms) — no dependency on the transitive @vueuse.
let searchTimer: ReturnType<typeof setTimeout>
watch(targetSearch, (term) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => loadTargets(term), 250)
})

async function doAssign() {
  assignMsg.value = ''
  try {
    await $fetch('/api/credentials/assign', {
      method: 'POST',
      headers: authHeaders.value,
      body: {
        level: assign.level,
        action: assign.action,
        targetId: isGlobal.value ? null : assign.targetId,
        credSetId: assign.credSetId === 'none' ? null : assign.credSetId,
      },
    })
    assignMsg.value = t('credentials.assignDone')
    await load()
  }
  catch (e) {
    assignMsg.value = t('credentials.assignError', { message: (e as Error).message })
  }
}

const canAssign = computed(() => isGlobal.value || !!assign.targetId)
function bindingLabel(b: Binding) {
  const lvl = t(`credentials.level${b.level[0]!.toUpperCase()}${b.level.slice(1)}`)
  return `${lvl} · ${t(`action.${b.action}`).split(' —')[0]} → ${b.credential_sets?.name ?? '—'}`
}
</script>

<template>
  <AdminPage :title="t('credentials.title')" :subtitle="t('credentials.subtitle')">
    <template #actions>
      <UButton icon="i-lucide-plus" @click="openNew">
        {{ t('credentials.new') }}
      </UButton>
    </template>
    <div class="flex flex-col gap-6">

    <UAlert v-if="loadErr" color="error" :description="loadErr" />

    <p v-if="!sets.length && !loadErr" class="text-sm text-muted">
      {{ t('credentials.empty') }}
    </p>

    <ul class="flex flex-col gap-2">
      <li
        v-for="s in sets"
        :key="s.id"
        class="flex items-center gap-3 px-4 py-3 rounded-lg border border-default bg-default"
      >
        <div class="flex-1 min-w-0">
          <span class="font-medium truncate text-highlighted">{{ s.name }}</span>
          <span class="text-xs text-muted font-mono block">{{ s.username || '—' }}{{ s.port ? `:${s.port}` : '' }}</span>
        </div>
        <UButton size="xs" variant="ghost" icon="i-lucide-pencil" :aria-label="t('credentials.edit')" @click="openEdit(s)" />
        <UButton size="xs" variant="ghost" color="error" icon="i-lucide-trash-2" :aria-label="t('credentials.delete')" @click="remove(s)" />
      </li>
    </ul>

    <!-- Assign (level × action) -->
    <section class="flex flex-col gap-3 p-4 rounded-lg border border-default bg-muted">
      <h2 class="text-sm font-semibold text-highlighted">
        {{ t('credentials.assignTitle') }}
      </h2>
      <div class="grid sm:grid-cols-4 gap-3">
        <UFormField :label="t('credentials.level')">
          <USelect v-model="assign.level" :items="levelItems" value-key="value" class="w-full" />
        </UFormField>
        <UFormField :label="t('credentials.actionLabel')">
          <USelect v-model="assign.action" :items="actionItems" value-key="value" class="w-full" />
        </UFormField>
        <UFormField :label="t('credentials.target')">
          <USelectMenu
            v-model="assign.targetId"
            v-model:search-term="targetSearch"
            :items="targets"
            value-key="value"
            :ignore-filter="true"
            :loading="targetLoading"
            :disabled="isGlobal"
            class="w-full"
          />
        </UFormField>
        <UFormField :label="t('credentials.set')">
          <USelect v-model="assign.credSetId" :items="setItems" value-key="value" class="w-full" />
        </UFormField>
      </div>
      <div class="flex items-center gap-3">
        <UButton :disabled="!canAssign" @click="doAssign">
          {{ t('credentials.assign') }}
        </UButton>
        <span v-if="assignMsg" class="text-sm text-muted">{{ assignMsg }}</span>
      </div>
    </section>

    <!-- Existing bindings -->
    <section class="flex flex-col gap-2 p-4 rounded-lg border border-default">
      <h2 class="text-sm font-semibold text-highlighted">
        {{ t('credentials.bindingsTitle') }}
      </h2>
      <p v-if="!bindings.length" class="text-sm text-muted">
        {{ t('credentials.noBindings') }}
      </p>
      <ul v-else class="flex flex-col gap-1">
        <li v-for="b in bindings" :key="b.id" class="text-xs font-mono text-muted">
          {{ bindingLabel(b) }}
        </li>
      </ul>
    </section>

    <!-- Create / edit modal -->
    <UModal v-model:open="formOpen" :title="editing ? t('credentials.edit') : t('credentials.new')">
      <template #body>
        <UForm :state="form" class="flex flex-col gap-4" @submit="save">
          <UFormField :label="t('credentials.name')" required>
            <UInput v-model="form.name" class="w-full" />
          </UFormField>
          <UFormField :label="t('credentials.username')">
            <UInput v-model="form.username" class="w-full" />
          </UFormField>
          <UFormField :label="t('credentials.password')" :hint="editing ? t('credentials.passwordKeepHint') : undefined">
            <UInput v-model="form.password" type="password" autocomplete="new-password" class="w-full" />
          </UFormField>
          <UFormField :label="t('credentials.port')">
            <UInput v-model="form.port" type="number" class="w-full" />
          </UFormField>
          <p v-if="!editing" class="text-xs text-muted">{{ t('credentials.unboundHint') }}</p>
          <UAlert v-if="saveErr" color="error" :description="saveErr" />
          <div class="flex justify-end gap-2">
            <UButton variant="ghost" color="neutral" @click="formOpen = false">
              {{ t('credentials.cancel') }}
            </UButton>
            <UButton type="submit">
              {{ t('credentials.save') }}
            </UButton>
          </div>
        </UForm>
      </template>
    </UModal>
    </div>
  </AdminPage>
</template>
