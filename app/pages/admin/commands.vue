<script setup lang="ts">
// Admin UI for per-type commands. CSR, Nuxt UI, i18n (ADR-006).
// device_types are read client-side (RLS select-authenticated); CRUD goes through
// the BFF (service_role). The body field is CodeMirror, highlighted by interpreter.
import type { CommandParam, CredRef, DeviceCommand, DeviceType } from '~/types/board'

const { t } = useI18n()
const supabase = useSupabaseClient()
const session = useSupabaseSession()
const authHeaders = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

const types = ref<DeviceType[]>([])
const typeId = ref<string | null>(null)
const commands = ref<DeviceCommand[]>([])
const loadErr = ref('')
// Sets for the cred_refs picker (admin route, Bearer). Few rows → all of them.
const credSets = ref<{ label: string, value: string }[]>([])

const typeItems = computed(() => types.value.map(t => ({ label: t.name, value: t.id })))
const interpreterItems = ['raw', 'bash', 'python', 'node'].map(v => ({ label: v, value: v }))
const targetItems = computed(() => [
  { label: t('commands.admin.targetSsh'), value: 'ssh' },
  { label: t('commands.admin.targetLocal'), value: 'local' },
])
const minRoleItems = computed(() => [
  { label: t('commands.admin.minRoleOperator'), value: 'operator' },
  { label: t('commands.admin.minRoleAdmin'), value: 'admin' },
])

async function loadTypes() {
  const { data } = await supabase.from('device_types').select('id,slug,name,icon,color,default_action,sort').order('sort')
  types.value = (data ?? []) as DeviceType[]
  if (!typeId.value && types.value.length)
    typeId.value = types.value[0]!.id
}

async function loadCommands() {
  if (!typeId.value)
    return
  try {
    commands.value = await $fetch<DeviceCommand[]>('/api/commands', {
      query: { typeId: typeId.value },
      headers: authHeaders.value,
    })
  }
  catch (e) {
    loadErr.value = t('commands.admin.loadError', { message: (e as Error).message })
  }
}

async function loadCredSets() {
  const sets = await $fetch<{ id: string, name: string }[]>('/api/credentials', { headers: authHeaders.value }).catch(() => [])
  credSets.value = sets.map(s => ({ label: s.name, value: s.id }))
}

onMounted(async () => { await loadTypes(); await loadCommands(); await loadCredSets() })
watch(typeId, loadCommands)

// --- create / edit -------------------------------------------------------
const formOpen = ref(false)
const editing = ref<DeviceCommand | null>(null)
const form = reactive({
  name: '', body: '', interpreter: 'raw', confirm: false, timeout_s: 45, sort: 0, purpose: 'action', stable: false,
  target: 'ssh', min_role: 'operator', params: [] as CommandParam[], cred_refs: [] as CredRef[],
})
const emptyForm = () => ({
  name: '', body: '', interpreter: 'raw', confirm: false, timeout_s: 45, sort: 0, purpose: 'action', stable: false,
  target: 'ssh', min_role: 'operator', params: [] as CommandParam[], cred_refs: [] as CredRef[],
})
function addParam() { form.params.push({ key: '', label: '', type: '' }) }
function addCredRef() { form.cred_refs.push({ set_id: credSets.value[0]?.value ?? '', env: '' }) }

// Init preamble per interpreter, so the author need not guess how to reach env
// (the server injects params + cred_refs into env). DEVICE_* and meta keys are in env too.
// ponytail: node/bash assignments assume env-style names (letters/digits/_).
function varInitBlock(interpreter: string, names: string[]): string {
  const q = (n: string) => JSON.stringify(n)
  const note = 'DEVICE_ID, DEVICE_HOST + meta keys are also available as env'
  if (interpreter === 'python')
    return `import os\n# ${note}\n${names.map(n => `${n} = os.environ.get(${q(n)}, "")`).join('\n')}`
  if (interpreter === 'node')
    return `// ${note}\n${names.map(n => `const ${n} = process.env[${q(n)}] ?? ''`).join('\n')}`
  return `# ${note}\n${names.map(n => `${n}="\${${n}:-}"`).join('\n')}` // bash / raw
}
function insertVars() {
  const names = [
    ...form.params.map(p => p.key),
    // A set = login+password → the prefix expands to _USER + _PASSWORD.
    ...form.cred_refs.flatMap(r => r.env.trim() ? [`${r.env.trim()}_USER`, `${r.env.trim()}_PASSWORD`] : []),
  ].map(s => s.trim()).filter(Boolean)
  // Idempotent: keep only names not yet in the body (word boundary, so that
  // MSG does not "match" MESSAGE).
  const has = (n: string) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(form.body)
  const missing = names.filter(n => !has(n))
  if (!missing.length)
    return
  const block = varInitBlock(form.interpreter, missing)
  form.body = form.body.trim() ? `${block}\n\n${form.body}` : `${block}\n`
}
const purposeItems = computed(() => [
  { label: t('commands.admin.purposeAction'), value: 'action' },
  { label: t('commands.admin.purposeProbe'), value: 'probe' },
])
const saveErr = ref('')

function openNew() {
  editing.value = null
  Object.assign(form, emptyForm())
  saveErr.value = ''
  formOpen.value = true
}
function openEdit(c: DeviceCommand) {
  editing.value = c
  Object.assign(form, {
    name: c.name, body: c.body, interpreter: c.interpreter, confirm: c.confirm, timeout_s: c.timeout_s, sort: c.sort, purpose: c.purpose, stable: c.stable,
    target: c.target ?? 'ssh', min_role: c.min_role ?? 'operator',
    params: (c.params ?? []).map(p => ({ ...p })), cred_refs: (c.cred_refs ?? []).map(r => ({ ...r })),
  })
  saveErr.value = ''
  formOpen.value = true
}

async function save() {
  saveErr.value = ''
  try {
    if (editing.value) {
      await $fetch(`/api/admin/commands/${editing.value.id}`, { method: 'PATCH', headers: authHeaders.value, body: { ...form } })
    }
    else {
      await $fetch('/api/admin/commands', { method: 'POST', headers: authHeaders.value, body: { type_id: typeId.value, ...form } })
    }
    formOpen.value = false
    await loadCommands()
  }
  catch (e) {
    saveErr.value = t('commands.admin.saveError', { message: (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message })
  }
}

async function remove(c: DeviceCommand) {
  if (!confirm(t('commands.admin.deleteConfirm', { name: c.name })))
    return
  await $fetch(`/api/admin/commands/${c.id}`, { method: 'DELETE', headers: authHeaders.value })
  await loadCommands()
}
</script>

<template>
  <AdminPage :title="t('commands.admin.title')" :subtitle="t('commands.admin.subtitle')">

    <div class="mb-4 flex items-end gap-3">
      <UFormField :label="t('commands.admin.type')" class="w-64">
        <USelect v-model="typeId" :items="typeItems" />
      </UFormField>
      <UButton icon="i-lucide-plus" class="ml-auto" @click="openNew">{{ t('commands.admin.new') }}</UButton>
    </div>

    <p v-if="loadErr" class="mb-3 text-sm text-red-500">{{ loadErr }}</p>

    <p v-if="!commands.length" class="text-muted">{{ t('commands.admin.empty') }}</p>
    <ul v-else class="divide-y divide-default rounded ring ring-default">
      <li v-for="c in commands" :key="c.id" class="flex items-center gap-3 p-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="font-medium text-highlighted">{{ c.name }}</span>
            <UBadge size="xs" color="neutral" variant="subtle">{{ c.interpreter }}</UBadge>
            <UBadge v-if="c.target === 'local'" size="xs" color="primary" variant="subtle">{{ t('commands.admin.targetLocal') }}</UBadge>
            <UBadge v-if="c.min_role === 'admin'" size="xs" color="warning" variant="subtle">{{ t('commands.admin.minRoleAdmin') }}</UBadge>
            <UBadge v-if="c.purpose === 'probe'" size="xs" color="info" variant="subtle">{{ t('commands.admin.purposeProbe') }}</UBadge>
            <UBadge v-if="c.purpose === 'probe' && c.stable" size="xs" color="success" variant="subtle">{{ t('commands.admin.stableFlag') }}</UBadge>
            <UBadge v-if="c.confirm" size="xs" color="warning" variant="subtle">confirm</UBadge>
            <span class="text-xs text-muted">{{ c.timeout_s }}s</span>
          </div>
          <code class="line-clamp-1 text-xs text-muted">{{ c.body }}</code>
        </div>
        <UButton size="xs" variant="ghost" color="neutral" @click="openEdit(c)">{{ t('commands.admin.edit') }}</UButton>
        <UButton size="xs" variant="ghost" color="error" @click="remove(c)">{{ t('commands.admin.delete') }}</UButton>
      </li>
    </ul>

    <UModal v-model:open="formOpen" :title="editing ? t('commands.admin.edit') : t('commands.admin.new')" :ui="{ content: 'max-w-4xl' }">
      <template #body>
        <div class="flex flex-col gap-3">
          <UFormField :label="t('commands.admin.name')">
            <UInput v-model="form.name" class="w-full" />
          </UFormField>
          <div class="flex flex-wrap gap-3">
            <UFormField :label="t('commands.admin.target')" class="w-40">
              <USelect v-model="form.target" :items="targetItems" value-key="value" />
            </UFormField>
            <UFormField :label="t('commands.admin.minRole')" class="w-40">
              <USelect v-model="form.min_role" :items="minRoleItems" value-key="value" />
            </UFormField>
            <UFormField :label="t('commands.admin.purpose')" class="w-40">
              <USelect v-model="form.purpose" :items="purposeItems" />
            </UFormField>
            <UFormField :label="t('commands.admin.interpreter')" class="w-40">
              <USelect v-model="form.interpreter" :items="interpreterItems" />
            </UFormField>
            <UFormField :label="t('commands.admin.timeout')" class="w-28">
              <UInput v-model.number="form.timeout_s" type="number" />
            </UFormField>
            <UFormField :label="t('commands.admin.sort')" class="w-28">
              <UInput v-model.number="form.sort" type="number" />
            </UFormField>
          </div>
          <UFormField :label="t('commands.admin.body')">
            <CodeEditor v-model="form.body" :language="form.interpreter" />
            <UButton
              size="xs"
              variant="soft"
              icon="i-lucide-wand-2"
              class="mt-2"
              :disabled="!form.params.length && !form.cred_refs.length"
              @click="insertVars"
            >
              {{ t('commands.admin.insertVars', { interp: form.interpreter }) }}
            </UButton>
          </UFormField>

          <!-- Form parameters (flat list {key,label,type?}) → pre-exec form. -->
          <UFormField :label="t('commands.admin.params')" :description="t('commands.admin.paramsHint')">
            <div class="flex flex-col gap-2">
              <div v-for="(p, i) in form.params" :key="i" class="flex gap-2">
                <UInput v-model="p.key" :placeholder="t('commands.admin.paramKey')" class="w-40 font-mono" />
                <UInput v-model="p.label" :placeholder="t('commands.admin.paramLabel')" class="flex-1" />
                <UInput v-model="p.type" :placeholder="t('commands.admin.paramType')" class="w-28" />
                <UButton icon="i-lucide-x" variant="ghost" color="error" :aria-label="t('commands.admin.paramRemove')" @click="form.params.splice(i, 1)" />
              </div>
              <UButton size="xs" variant="soft" icon="i-lucide-plus" class="self-start" @click="addParam">{{ t('commands.admin.paramAdd') }}</UButton>
            </div>
          </UFormField>

          <!-- Credential refs (set → env name); the secret is injected server-side. -->
          <UFormField :label="t('commands.admin.credRefs')" :description="t('commands.admin.credRefsHint')">
            <div class="flex flex-col gap-2">
              <div v-for="(r, i) in form.cred_refs" :key="i" class="flex gap-2">
                <USelect v-model="r.set_id" :items="credSets" value-key="value" class="flex-1" />
                <UInput v-model="r.env" :placeholder="t('commands.admin.credRefEnv')" class="w-40 font-mono" />
                <UButton icon="i-lucide-x" variant="ghost" color="error" :aria-label="t('commands.admin.credRefRemove')" @click="form.cred_refs.splice(i, 1)" />
              </div>
              <UButton size="xs" variant="soft" icon="i-lucide-plus" class="self-start" :disabled="!credSets.length" @click="addCredRef">{{ t('commands.admin.credRefAdd') }}</UButton>
            </div>
          </UFormField>
          <UCheckbox v-model="form.confirm" :label="t('commands.admin.confirmFlag')" />
          <UCheckbox v-if="form.purpose === 'probe'" v-model="form.stable" :label="t('commands.admin.stableFlag')" :description="t('commands.admin.stableHint')" />
          <p v-if="saveErr" class="text-sm text-red-500">{{ saveErr }}</p>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="formOpen = false">{{ t('commands.admin.cancel') }}</UButton>
        <UButton color="primary" :disabled="!form.name || !form.body" @click="save">{{ t('commands.admin.save') }}</UButton>
      </template>
    </UModal>
  </AdminPage>
</template>
