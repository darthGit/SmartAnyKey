<script setup lang="ts">
// Authenticator (TOTP) enrollment: QR + key as text + the first code. Used by the account
// page and by first-run setup, where the new admin enrolls before anything else.
const emit = defineEmits<{ enrolled: [] }>()
const { t } = useI18n()
const supabase = useSupabaseClient()

const enrolling = ref<{ id: string, qr: string, secret: string } | null>(null)
const code = ref('')
const err = ref('')
const busy = ref(false)

async function start() {
  err.value = ''
  // A factor left half-done by an abandoned attempt blocks a new one with the same name.
  const { data: list } = await supabase.auth.mfa.listFactors()
  for (const f of list?.all ?? []) {
    if (f.status === 'unverified')
      await supabase.auth.mfa.unenroll({ factorId: f.id })
  }
  // Without an issuer the server uses its site URL ("localhost:3000"), and the colon of the
  // port splits the label in the authenticator app. Host without port: installs stay apart.
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'SmartAnyKey',
    issuer: `SmartAnyKey (${location.hostname})`,
  })
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
  emit('enrolled')
}
</script>

<template>
  <div class="flex flex-col gap-4">
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
    <template v-else>
      <p class="m-0 text-sm text-muted">
        {{ t('mfa.offHint') }}
      </p>
      <UButton @click="start">
        {{ t('mfa.setUp') }}
      </UButton>
    </template>
    <UAlert v-if="err" color="error" variant="subtle" :title="err" />
  </div>
</template>
