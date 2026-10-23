<script setup lang="ts">
const { t } = useI18n()
const supabase = useSupabaseClient()
const state = reactive({ email: '', password: '' })
const error = ref('')
const pending = ref(false)
// Second step: the password was right and the account has an authenticator.
const needCode = ref(false)
const code = ref('')

// Also reached already signed in at aal1 (the middleware sends a user who owes the code here).
onMounted(async () => {
  needCode.value = await owesCode()
})

async function owesCode() {
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  return data?.nextLevel === 'aal2' && data.currentLevel !== 'aal2'
}

async function verifyCode() {
  pending.value = true
  error.value = ''
  const { data } = await supabase.auth.mfa.listFactors()
  const factor = data?.totp[0]
  const { error: err } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor?.id ?? '', code: code.value.trim() })
  pending.value = false
  if (err) {
    error.value = err.status === 429 ? t('auth.tooManyAttempts') : t('mfa.invalidCode')
    return
  }
  await navigateTo('/')
}

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
  if (await owesCode()) {
    needCode.value = true
    return
  }
  await navigateTo('/')
}
</script>

<template>
  <main class="min-h-screen grid place-items-center bg-muted">
    <UForm
      v-if="needCode"
      :state="{ code }"
      class="flex flex-col gap-3 w-80 p-8 rounded-xl shadow-lg bg-default"
      @submit="verifyCode"
    >
      <h1 class="m-0 mb-2 text-center text-2xl font-semibold text-highlighted">
        SmartAnyKey
      </h1>
      <p class="m-0 text-sm text-muted">
        {{ t('mfa.codePrompt') }}
      </p>
      <UFormField name="code">
        <UInput
          v-model="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          :placeholder="t('mfa.code')"
          maxlength="6"
          required
          autofocus
          class="w-full"
        />
      </UFormField>
      <UButton type="submit" :loading="pending" block>
        {{ t('mfa.verify') }}
      </UButton>
      <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    </UForm>
    <UForm
      v-else
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
