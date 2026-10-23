<script setup lang="ts">
// The user's own sign-in security: turn the authenticator (TOTP) on or off. Also where the
// middleware sends a user whose role must have 2FA and who has none yet.
const { t } = useI18n()
const supabase = useSupabaseClient()
const session = useSupabaseSession()

const factorId = ref<string | null>(null)
const required = ref(false)
const enrolling = ref<{ id: string, qr: string, secret: string } | null>(null)
const code = ref('')
const err = ref('')
const busy = ref(false)

async function load() {
  const { data } = await supabase.auth.mfa.listFactors()
  factorId.value = data?.totp[0]?.id ?? null
  const res = await $fetch<{ forced: boolean }>('/api/auth/mfa', {
    headers: { Authorization: `Bearer ${session.value?.access_token}` },
  }).catch(() => null)
  required.value = !!res?.forced
}
onMounted(load)

async function start() {
  err.value = ''
  // A factor left half-done by an abandoned attempt blocks a new one with the same name.
  const { data: list } = await supabase.auth.mfa.listFactors()
  for (const f of list?.all ?? []) {
    if (f.status === 'unverified')
      await supabase.auth.mfa.unenroll({ factorId: f.id })
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'SmartAnyKey' })
  if (error) {
    err.value = error.message
    return
  }
  enrolling.value = { id: data.id, qr: data.totp.qr_code, secret: data.totp.secret }
}

async function confirm() {
  if (!enrolling.value)
    return
  busy.value = true
  err.value = ''
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrolling.value.id, code: code.value.trim() })
  busy.value = false
  if (error) {
    err.value = t('mfa.invalidCode')
    return
  }
  enrolling.value = null
  code.value = ''
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
    <div class="flex flex-col gap-4 w-96 p-8 rounded-xl shadow-lg bg-default">
      <h1 class="m-0 text-xl font-semibold text-highlighted">
        {{ t('mfa.title') }}
      </h1>
      <UAlert
        v-if="required && !factorId"
        color="warning"
        variant="subtle"
        :title="t('mfa.requiredHint')"
      />

      <template v-if="enrolling">
        <p class="m-0 text-sm text-muted">
          {{ t('mfa.scanHint') }}
        </p>
        <img :src="enrolling.qr" :alt="t('mfa.qrAlt')" class="mx-auto size-48 bg-white p-2 rounded">
        <p class="m-0 text-xs text-muted">
          {{ t('mfa.secretHint') }}
          <code class="block mt-1 break-all text-default">{{ enrolling.secret }}</code>
        </p>
        <UForm :state="{ code }" class="flex flex-col gap-3" @submit="confirm">
          <UInput
            v-model="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            :placeholder="t('mfa.code')"
            required
            autofocus
          />
          <UButton type="submit" :loading="busy" block>
            {{ t('mfa.enable') }}
          </UButton>
        </UForm>
      </template>

      <template v-else-if="factorId">
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

      <template v-else>
        <p class="m-0 text-sm text-muted">
          {{ t('mfa.offHint') }}
        </p>
        <UButton @click="start">
          {{ t('mfa.setUp') }}
        </UButton>
      </template>

      <UAlert v-if="err" color="error" variant="subtle" :title="err" />
      <UButton v-if="!required || factorId" to="/" color="neutral" variant="ghost">
        {{ t('mfa.back') }}
      </UButton>
    </div>
  </main>
</template>
