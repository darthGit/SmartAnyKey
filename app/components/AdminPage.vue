<script setup lang="ts">
// The single shell for admin pages: canonical container + header
// (back button icon+text → title+subtitle → #actions).
// Removes hand-made header markup on every page. ADR-004 (kit+Tailwind, no
// scoped), ADR-006 (t()).
const props = withDefaults(defineProps<{ title: string, subtitle?: string, backTo?: string }>(), {
  subtitle: undefined,
  backTo: '/',
})
const { t } = useI18n()
const router = useRouter()
// vue-router keeps the previous in-app path in history.state.back; null = opened
// directly (link, new tab) → backTo, never out of the app.
function goBack() {
  if (window.history.state?.back)
    router.back()
  else
    navigateTo(props.backTo)
}
</script>

<template>
  <div class="mx-auto max-w-3xl p-6">
    <header class="mb-4 flex items-center gap-3">
      <UButton data-action="admin-back" variant="ghost" color="neutral" icon="i-lucide-arrow-left" @click="goBack">
        {{ t('admin.back') }}
      </UButton>
      <div class="min-w-0 flex-1">
        <h1 class="text-lg font-semibold text-highlighted">{{ title }}</h1>
        <p v-if="subtitle" class="text-sm text-muted">{{ subtitle }}</p>
      </div>
      <slot name="actions" />
    </header>
    <slot />
  </div>
</template>
