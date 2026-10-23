<script setup lang="ts">
// The user's own sign-in security: turn the authenticator (TOTP) on or off. Also where the
// middleware sends a user whose role must have 2FA and who has none yet.
const { t } = useI18n()
const supabase = useSupabaseClient()

const factorId = ref<string | null>(null)
const required = ref(false)
const loaded = ref(false)
const err = ref('')
const busy = ref(false)

async function load() {
  const { data } = await supabase.auth.mfa.listFactors()
  factorId.value = data?.totp[0]?.id ?? null
  const { data: { session } } = await supabase.auth.getSession()
  const res = await $fetch<{ forced: boolean }>('/api/auth/mfa', {
    headers: { Authorization: `Bearer ${session?.access_token}` },
  }).catch(() => null)
  required.value = !!res?.forced
  loaded.value = true
}
onMounted(load)

async function enrolled() {
  await load()
  if (required.value)
    await navigateTo('/')
}

async function turnOff() {
  if (!factorId.value)
    return
  busy.value = true
  const { error } = await supabase.auth.mfa.unenroll({ factorId: factorId.value })
  busy.value = false
  if (error) {
    err.value = error.message
    return
  }
  await supabase.auth.refreshSession()
  await load()
}
</script>

<template>
  <main class="min-h-screen grid place-items-center bg-muted">
    <div v-if="loaded" class="flex flex-col gap-4 w-96 p-8 rounded-xl shadow-lg bg-default">
      <h1 class="m-0 text-xl font-semibold text-highlighted">
        {{ t('mfa.title') }}
      </h1>
      <UAlert
        v-if="required && !factorId"
        color="warning"
        variant="subtle"
        :title="t('mfa.requiredHint')"
      />

      <template v-if="factorId">
        <p class="m-0 text-sm">
          <UIcon name="i-lucide-shield-check" class="text-success align-middle" />
          {{ t('mfa.on') }}
        </p>
        <UButton v-if="!required" color="neutral" variant="outline" :loading="busy" @click="turnOff">
          {{ t('mfa.disable') }}
        </UButton>
        <p v-else class="m-0 text-xs text-muted">
          {{ t('mfa.cannotDisable') }}
        </p>
      </template>
      <MfaEnroll v-else @enrolled="enrolled" />

      <UAlert v-if="err" color="error" variant="subtle" :title="err" />
      <UButton v-if="!required || factorId" to="/" color="neutral" variant="ghost">
        {{ t('mfa.back') }}
      </UButton>
    </div>
  </main>
</template>
