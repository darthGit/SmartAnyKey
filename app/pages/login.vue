<script setup lang="ts">
const { t } = useI18n()
const supabase = useSupabaseClient()
const state = reactive({ email: '', password: '' })
const error = ref('')
const pending = ref(false)

async function signIn() {
  pending.value = true
  error.value = ''
  const { error: err } = await supabase.auth.signInWithPassword({
    email: state.email,
    password: state.password,
  })
  pending.value = false
  if (err) {
    // 429 = Kong's per-IP sign-in limit (one-minute window).
    error.value = err.status === 429 ? t('auth.tooManyAttempts') : t('auth.invalidCredentials')
    return
  }
  await navigateTo('/')
}
</script>

<template>
  <main class="min-h-screen grid place-items-center bg-muted">
    <UForm
      :state="state"
      class="flex flex-col gap-3 w-80 p-8 rounded-xl shadow-lg bg-default"
      @submit="signIn"
    >
      <h1 class="m-0 mb-2 text-center text-2xl font-semibold text-highlighted">
        SmartAnyKey
      </h1>
      <UFormField name="email">
        <UInput
          v-model="state.email"
          type="email"
          :placeholder="t('auth.email')"
          autocomplete="username"
          required
          class="w-full"
        />
      </UFormField>
      <UFormField name="password">
        <UInput
          v-model="state.password"
          type="password"
          :placeholder="t('auth.password')"
          autocomplete="current-password"
          required
          class="w-full"
        />
      </UFormField>
      <UButton type="submit" :loading="pending" block>
        {{ pending ? t('auth.signingIn') : t('auth.signIn') }}
      </UButton>
      <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    </UForm>
  </main>
</template>
