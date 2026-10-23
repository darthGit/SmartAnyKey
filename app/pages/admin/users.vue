<script setup lang="ts">
// Admin UI: users + roles + lifecycle. Admin-only
// (the server returns 403 otherwise). CSR, Nuxt UI, i18n. Data through the BFF (service_role).
// The temp password is shown ONLY once (dialog) — not stored.
type Role = 'viewer' | 'operator' | 'admin'
const { t } = useI18n()
const session = useSupabaseSession()
const authHeaders = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

interface UserRow { id: string, email: string | null, role: Role | null, mfa: boolean }
const users = ref<UserRow[]>([])
const loadErr = ref('')

const roleItems = computed(() => [
  { label: t('rbac.roleViewer'), value: 'viewer' },
  { label: t('rbac.roleOperator'), value: 'operator' },
  { label: t('rbac.roleAdmin'), value: 'admin' },
])

async function load() {
  loadErr.value = ''
  try {
    users.value = await $fetch<UserRow[]>('/api/admin/users', { headers: authHeaders.value })
  }
  catch (e) {
    loadErr.value = t('rbac.loadError', { message: msg(e) })
  }
}
const msg = (e: unknown) => (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message

async function setRole(u: UserRow, role: Role) {
  try {
    await $fetch(`/api/admin/users/${u.id}/role`, { method: 'PATCH', headers: authHeaders.value, body: { role } })
    u.role = role
  }
  catch (e) { alert(t('rbac.saveError', { message: msg(e) })) }
}

// --- temp password, shown once ---
const tempPassword = ref('')
const tempOpen = ref(false)
function showTemp(pw: string) {
  tempPassword.value = pw
  tempOpen.value = true
}

// --- create ---
const createOpen = ref(false)
const newEmail = ref('')
const newRole = ref<Role>('operator')
const createBusy = ref(false)
async function create() {
  createBusy.value = true
  try {
    const { tempPassword: pw } = await $fetch<{ id: string, tempPassword: string }>('/api/admin/users', {
      method: 'POST', headers: authHeaders.value, body: { email: newEmail.value, role: newRole.value },
    })
    createOpen.value = false
    newEmail.value = ''
    newRole.value = 'operator'
    showTemp(pw)
    await load()
  }
  catch (e) { alert(t('rbac.createError', { message: msg(e) })) }
  finally { createBusy.value = false }
}

async function resetPw(u: UserRow) {
  try {
    const { tempPassword: pw } = await $fetch<{ tempPassword: string }>(`/api/admin/users/${u.id}/reset-password`, {
      method: 'POST', headers: authHeaders.value,
    })
    showTemp(pw)
  }
  catch (e) { alert(t('rbac.resetError', { message: msg(e) })) }
}

async function del(u: UserRow) {
  if (!confirm(t('rbac.deleteConfirm', { email: u.email ?? '' })))
    return
  try {
    await $fetch(`/api/admin/users/${u.id}`, { method: 'DELETE', headers: authHeaders.value })
    await load()
  }
  catch (e) { alert(t('rbac.deleteError', { message: msg(e) })) }
}

async function resetMfa(u: UserRow) {
  if (!confirm(t('mfa.resetConfirm', { email: u.email ?? '' })))
    return
  try {
    await $fetch(`/api/admin/users/${u.id}/mfa`, { method: 'DELETE', headers: authHeaders.value })
    u.mfa = false
  }
  catch (e) { alert(t('mfa.resetError', { message: msg(e) })) }
}

// --- 2FA policy: the lowest role that must use a second factor ('off' = nobody) ---
const policy = ref<Role | 'off'>('off')
const policyNote = ref('')
const policyItems = computed(() => [
  { label: t('mfa.policyOff'), value: 'off' },
  { label: t('mfa.policyViewer'), value: 'viewer' },
  { label: t('mfa.policyOperator'), value: 'operator' },
  { label: t('mfa.policyAdmin'), value: 'admin' },
])
async function loadPolicy() {
  const { requiredRole } = await $fetch<{ requiredRole: Role | null }>('/api/admin/settings/mfa', { headers: authHeaders.value })
  policy.value = requiredRole ?? 'off'
}
async function savePolicy(v: Role | 'off') {
  policyNote.value = ''
  try {
    await $fetch('/api/admin/settings/mfa', {
      method: 'PATCH', headers: authHeaders.value, body: { requiredRole: v === 'off' ? null : v },
    })
    policy.value = v
    policyNote.value = t('mfa.policySaved')
  }
  catch (e) { policyNote.value = t('mfa.policyError', { message: msg(e) }) }
}

const loadAll = () => Promise.all([load(), loadPolicy().catch(() => {})])
onMounted(loadAll)
watch(session, (s, prev) => { if (s && !prev) loadAll() })
</script>

<template>
  <AdminPage :title="t('rbac.usersTitle')">
    <template #actions>
      <UButton icon="i-lucide-user-plus" size="sm" @click="createOpen = true">
        {{ t('rbac.addUser') }}
      </UButton>
    </template>
    <p v-if="loadErr" class="text-error mb-3">{{ loadErr }}</p>
    <div class="flex flex-wrap items-center gap-3 mb-4">
      <span class="text-sm">{{ t('mfa.policy') }}</span>
      <USelect
        :model-value="policy"
        :items="policyItems"
        class="w-56"
        @update:model-value="savePolicy($event as Role | 'off')"
      />
      <span v-if="policyNote" class="text-xs text-muted">{{ policyNote }}</span>
    </div>
    <table class="w-full text-sm">
      <thead>
        <tr class="text-left text-muted border-b border-default">
          <th class="py-2">{{ t('rbac.email') }}</th>
          <th class="py-2 w-44">{{ t('rbac.role') }}</th>
          <th class="py-2 w-16">{{ t('mfa.column') }}</th>
          <th class="py-2 w-96" />
        </tr>
      </thead>
      <tbody>
        <tr v-for="u in users" :key="u.id" class="border-b border-default">
          <td class="py-2">{{ u.email }}</td>
          <td class="py-2">
            <USelect
              :model-value="u.role ?? undefined"
              :items="roleItems"
              :placeholder="t('rbac.noRole')"
              class="w-40"
              @update:model-value="setRole(u, $event as Role)"
            />
          </td>
          <td class="py-2">
            <UIcon v-if="u.mfa" name="i-lucide-shield-check" class="text-success" :aria-label="t('mfa.on')" />
            <span v-else class="text-muted">—</span>
          </td>
          <td class="py-2">
            <div class="flex gap-2 justify-end whitespace-nowrap">
              <UButton v-if="u.mfa" variant="ghost" color="neutral" size="xs" icon="i-lucide-shield-off" @click="resetMfa(u)">
                {{ t('mfa.reset') }}
              </UButton>
              <UButton variant="ghost" color="neutral" size="xs" icon="i-lucide-key-round" @click="resetPw(u)">
                {{ t('rbac.reset') }}
              </UButton>
              <UButton variant="ghost" color="error" size="xs" icon="i-lucide-trash-2" @click="del(u)">
                {{ t('rbac.delete') }}
              </UButton>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- Create -->
    <UModal v-model:open="createOpen" :title="t('rbac.createTitle')">
      <template #body>
        <form class="flex flex-col gap-3" @submit.prevent="create">
          <UInput v-model="newEmail" type="email" :placeholder="t('rbac.email')" autocomplete="off" />
          <USelect v-model="newRole" :items="roleItems" />
        </form>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="createOpen = false">{{ t('rbac.cancel') }}</UButton>
        <UButton :loading="createBusy" :disabled="!newEmail" @click="create">{{ t('rbac.create') }}</UButton>
      </template>
    </UModal>

    <!-- Temp password (shown once) -->
    <UModal v-model:open="tempOpen" :title="t('rbac.tempPasswordTitle')">
      <template #body>
        <p class="text-sm text-muted mb-3">{{ t('rbac.tempPasswordHint') }}</p>
        <code class="block p-3 rounded-md bg-elevated text-highlighted break-all select-all">{{ tempPassword }}</code>
      </template>
      <template #footer>
        <UButton @click="tempOpen = false">{{ t('rbac.close') }}</UButton>
      </template>
    </UModal>
  </AdminPage>
</template>
