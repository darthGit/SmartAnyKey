<script setup lang="ts">
// The single shell for admin pages: canonical container + header
// (back button icon+text → title+subtitle → #actions).
// Removes hand-made header markup on every page. ADR-004 (kit+Tailwind, no
// scoped), ADR-006 (t()).
withDefaults(defineProps<{ title: string, subtitle?: string, backTo?: string }>(), {
  subtitle: undefined,
  backTo: '/',
})
const { t } = useI18n()
</script>

<template>
  <div class="mx-auto max-w-3xl p-6">
    <header class="mb-4 flex items-center gap-3">
      <UButton :to="backTo" variant="ghost" color="neutral" icon="i-lucide-arrow-left">
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
