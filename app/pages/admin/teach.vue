<script setup lang="ts">
// Teaching the classifier outside the wizard — the same TeachStep, reachable from the admin
// menu and from the discovery drawer's "no rule" hint. ADR-012/013.
const { t } = useI18n()
</script>

<template>
  <AdminPage :title="t('onboarding.steps.teach.title')" :subtitle="t('onboarding.steps.teach.help')">
    <OnboardingTeachStep />
  </AdminPage>
</template>
