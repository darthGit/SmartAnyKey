<script setup lang="ts">
// First-run screen (ADR-021).
// No authentication — on a fresh install there is nobody to authenticate.
// Layout follows the neighbour `login.vue` (same centred UForm), so the two
// "before sign-in" screens do not drift apart.
//
// Two steps, and the second one is here, not in the `admin/onboarding.vue` rail:
// that rail leads to the first connection, and an ops step in the middle of it
// would derail its goal. After creating the admin we sign in as them at once —
// otherwise nobody can do the "enable backup" step: the toggle needs an admin session.
interface BackupState {
  taskId: string | null
  enabled: boolean
  dirInContainer: string
  keep: number
  nextRunAt: string | null
}

const { t } = useI18n()
const supabase = useSupabaseClient()
const session = useSupabaseSession()
const authHeaders = () => ({ Authorization: `Bearer ${session.value?.access_token}` })

const step = ref<'admin' | 'backup'>('admin')
const state = reactive({ email: '', password: '', confirm: '' })
const error = ref('')
const pending = ref(false)
const backup = ref<BackupState | null>(null)

const mismatch = computed(() => !!state.confirm && state.password !== state.confirm)
const nextRun = computed(() =>
  backup.value?.nextRunAt ? new Date(backup.value.nextRunAt).toLocaleString() : null)

async function createAdmin() {
  if (mismatch.value)
    return
  pending.value = true
  error.value = ''
  try {
    await $fetch('/api/setup/admin', {
      method: 'POST',
      body: { email: state.email, password: state.password },
    })
    // The gate is closed — nobody gets here again.
    useState<boolean | null>('setup-open').value = false
    const { error: signInErr } = await supabase.auth.signInWithPassword({
      email: state.email,
      password: state.password,
    })
    if (signInErr)
      return await navigateTo('/login')
    // ⚠ Bearer explicitly. Gated routes in this project are NOT read from the cookie:
    // `requireUser` via the cookie path returns raw JWT claims and `requireRole` gives 403.
    // The convention is the same `Authorization: Bearer` as in
    // `PointContactsEditor`/`FileManager`. Without it the backup step simply did not
    // appear — measured in a clean room 2026-09-18.
    backup.value = await $fetch<BackupState>('/api/setup/backup', { headers: authHeaders() })
    step.value = 'backup'
  }
  catch (e) {
    const status = (e as { statusCode?: number }).statusCode
    error.value = status === 403 ? t('setup.alreadyDone') : status === 429 ? t('auth.tooManyAttempts') : t('setup.failed')
  }
  finally {
    pending.value = false
  }
}

async function enableBackup() {
  pending.value = true
  error.value = ''
  try {
    backup.value = await $fetch<BackupState>('/api/setup/backup', {
      method: 'POST',
      headers: authHeaders(),
    })
  }
  catch {
    error.value = t('setup.backupFailed')
  }
  finally {
    pending.value = false
  }
}
</script>

<template>
  <main class="min-h-screen grid place-items-center bg-muted">
    <UForm
      v-if="step === 'admin'"
      :state="state"
      class="flex flex-col gap-3 w-96 p-8 rounded-xl shadow-lg bg-default"
      @submit="createAdmin"
    >
      <h1 class="m-0 text-center text-2xl font-semibold text-highlighted">
        SmartAnyKey
      </h1>
      <p class="m-0 mb-2 text-center text-sm text-muted">
        {{ t('setup.intro') }}
      </p>
      <UFormField name="email" :label="t('setup.email')">
        <UInput v-model="state.email" type="email" autocomplete="username" required class="w-full" />
      </UFormField>
      <UFormField name="password" :label="t('setup.password')" :description="t('setup.passwordHint')">
        <UInput
          v-model="state.password"
          type="password"
          autocomplete="new-password"
          minlength="12"
          required
          class="w-full"
        />
      </UFormField>
      <UFormField
        name="confirm"
        :label="t('setup.confirm')"
        :error="mismatch ? t('setup.mismatch') : undefined"
      >
        <UInput v-model="state.confirm" type="password" autocomplete="new-password" required class="w-full" />
      </UFormField>
      <UButton type="submit" :loading="pending" :disabled="mismatch" block>
        {{ t('setup.submit') }}
      </UButton>
      <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    </UForm>

    <div
      v-else
      class="flex flex-col gap-3 w-96 p-8 rounded-xl shadow-lg bg-default"
      data-testid="setup-backup"
    >
      <h1 class="m-0 text-center text-2xl font-semibold text-highlighted">
        {{ t('setup.doneTitle') }}
      </h1>
      <h2 class="m-0 text-center text-base font-medium text-toned">
        {{ t('setup.backupTitle') }}
      </h2>

      <UAlert
        v-if="backup && !backup.enabled"
        color="warning"
        variant="subtle"
        :title="t('setup.backupOff')"
        :description="t('setup.backupWhy')"
        data-testid="backup-off"
      />
      <UAlert
        v-else-if="backup"
        color="success"
        variant="subtle"
        :title="t('setup.backupOn', { keep: backup.keep })"
        :description="nextRun ? t('setup.backupNext', { at: nextRun }) : undefined"
        data-testid="backup-on"
      />

      <p v-if="backup" class="m-0 text-xs text-muted">
        {{ t('setup.backupWhere', { dir: backup.dirInContainer }) }}
      </p>

      <UButton
        v-if="backup && !backup.enabled"
        :loading="pending"
        block
        data-action="backup-enable"
        @click="enableBackup"
      >
        {{ t('setup.backupEnable') }}
      </UButton>
      <UAlert v-if="error" color="error" variant="subtle" :title="error" />

      <UButton variant="ghost" block data-action="setup-finish" @click="navigateTo('/')">
        {{ backup?.enabled ? t('setup.finish') : t('setup.backupSkip') }}
      </UButton>
    </div>
  </main>
</template>
