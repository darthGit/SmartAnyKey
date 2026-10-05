<script setup lang="ts">
// Self-service password change (forced on a temp password). After the change —
// refreshSession, so must_change_password in the JWT becomes false (otherwise the
// middleware loops). CSR, Nuxt UI, i18n.
const { t } = useI18n()
const supabase = useSupabaseClient()
const session = useSupabaseSession()
const user = useSupabaseUser()
const password = ref('')
const err = ref('')
const busy = ref(false)

async function submit() {
  err.value = ''
  busy.value = true
  try {
    await $fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.value?.access_token}` },
      body: { password: password.value },
    })
    // A password change (admin API) revokes the refresh token → refreshSession fails.
    // Instead — a fresh login with the new password: valid session + flag already false.
    const { error } = await supabase.auth.signInWithPassword({
      email: user.value?.email ?? '',
      password: password.value,
    })
    if (error)
      throw error
    await navigateTo('/')
  }
  catch (e) {
    const status = (e as { statusCode?: number, status?: number }).statusCode ?? (e as { status?: number }).status
    err.value = status === 429
      ? t('auth.tooManyAttempts')
      : t('rbac.changeError', { message: (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message })
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-default p-4">
    <UCard class="w-full max-w-sm">
      <template #header>
        <h1 class="text-lg font-semibold text-highlighted">{{ t('rbac.changeTitle') }}</h1>
      </template>
      <form class="flex flex-col gap-3" @submit.prevent="submit">
        <p class="text-sm text-muted">{{ t('rbac.changeHint') }}</p>
        <UInput
          v-model="password"
          type="password"
          :placeholder="t('rbac.newPassword')"
          autocomplete="new-password"
        />
        <p v-if="err" class="text-error text-sm">{{ err }}</p>
        <UButton type="submit" block :loading="busy" :disabled="password.length < 8">
          {{ t('rbac.changeSubmit') }}
        </UButton>
      </form>
    </UCard>
  </div>
</template>
