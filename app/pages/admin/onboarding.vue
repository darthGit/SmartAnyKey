<script setup lang="ts">
// Guided onboarding wizard. A thin stepper shell: orchestrating existing pieces,
// no new mechanics. Steps
// = guide + live done state + an "Open editor" button (navigation to the existing
// /admin/* page, not a literal mount, so the route pages' chrome is not
// duplicated). Progress is derived from data (no separate table); re-open
// lands on the first unfinished step.
//
// The rail leads to the first connection (decided 2026-09-17): point → type →
// device → creds → connect. "Teach signatures" and the scan are still there — as a
// "scale up" block at the finish, because an empty install does not need them for the
// first connect, and on the critical path they read as mandatory.
// Admin-gated (ADR-013: useRole, like index.vue; enforcement is server-side). All strings
// through t() (ADR-006).
const { t } = useI18n()
const { role } = useRole()
const session = useSupabaseSession()

// Admin gate — non-admin goes to the board. Redirect ONLY when the role is loaded and not admin:
// role loads asynchronously (useRole), null = still loading OR no profile →
// redirecting on null would wrongly kick an admin out before the role resolves (SPA auth race).
watch([session, role], ([s]) => {
  if (s && role.value && role.value !== 'admin')
    navigateTo('/')
}, { immediate: true })

const { steps, firstIncomplete, loading, refresh } = useOnboardingProgress()
const doneByKey = computed(() => Object.fromEntries(steps.value.map(s => [s.key, s.done])))
const teachDone = computed(() => steps.value.find(s => s.key === 'teach')?.done ?? false)

interface StepDef { key: string, icon: string, to?: string, altTo?: string }
// Order = the path to the first connection. `altTo` is a second, optional
// path for the same step: an empty install has nothing to CSV-import yet, so
// the primary action is creating a point by hand, with import next to it.
const STEPS: StepDef[] = [
  { key: 'points', icon: 'i-lucide-map-pin', to: '/admin/points', altTo: '/admin/import' },
  { key: 'types', icon: 'i-lucide-box', to: '/admin/device-types' },
  { key: 'devices', icon: 'i-lucide-monitor-smartphone', to: '/admin/devices' },
  { key: 'credentials', icon: 'i-lucide-key-round', to: '/admin/credentials' },
  { key: 'connect', icon: 'i-lucide-plug-zap', to: '/' },
]
// The teach screen at the finish is on demand, not by default: it is no longer a
// cold-start step but the first scaling step.
const showTeach = ref(false)

const current = ref(0)
// open on the first unfinished step — only once, when counts have loaded;
// after that, do not jerk the user around while they navigate steps by hand.
const initialized = ref(false)
watch(loading, (l) => {
  if (!l && !initialized.value) {
    const fi = firstIncomplete.value
    current.value = fi ? Math.max(0, STEPS.findIndex(s => s.key === fi)) : STEPS.length - 1
    initialized.value = true
  }
}, { immediate: true })

const allDone = computed(() => firstIncomplete.value === null)
const step = computed(() => STEPS[current.value]!)
const isLast = computed(() => current.value === STEPS.length - 1)

function goto(i: number) { current.value = Math.min(STEPS.length - 1, Math.max(0, i)) }
</script>

<template>
  <AdminPage :title="t('onboarding.title')" :subtitle="t('onboarding.subtitle')">

    <!-- Progress rail: done / current / todo -->
    <ol class="mb-6 flex flex-wrap gap-2">
      <li v-for="(s, i) in STEPS" :key="s.key">
        <UButton
          size="sm"
          :variant="i === current ? 'solid' : 'soft'"
          :color="(doneByKey[s.key] || (s.key === 'connect' && allDone)) ? 'success' : (i === current ? 'primary' : 'neutral')"
          :icon="(doneByKey[s.key] || (s.key === 'connect' && allDone)) ? 'i-lucide-check' : s.icon"
          @click="goto(i)"
        >
          {{ t(`onboarding.steps.${s.key}.title`) }}
        </UButton>
      </li>
    </ol>

    <!-- The last step = the wizard's goal: the first connection. Not "congrats", but what
         exactly to do — and what still blocks it if the rail is not done. -->
    <div v-if="step.key === 'connect'" class="flex flex-col gap-4">
      <div class="rounded ring ring-default bg-elevated p-5">
        <div class="mb-3 flex items-center gap-2">
          <UIcon :name="step.icon" class="text-primary" />
          <h2 class="text-base font-semibold text-highlighted">{{ t('onboarding.steps.connect.title') }}</h2>
          <UBadge v-if="allDone" size="xs" color="success" variant="subtle" icon="i-lucide-check">
            {{ t('onboarding.stepDone') }}
          </UBadge>
        </div>

        <template v-if="allDone">
          <p class="mb-4 text-sm text-muted">{{ t('onboarding.steps.connect.help') }}</p>
          <div class="flex flex-wrap gap-3">
            <UButton color="primary" icon="i-lucide-layout-dashboard" to="/" data-action="goto-board">
              {{ t('onboarding.steps.connect.action') }}
            </UButton>
            <UButton variant="ghost" color="neutral" icon="i-lucide-users" to="/admin/users">
              {{ t('onboarding.finish.addUsers') }}
            </UButton>
          </div>
        </template>

        <!-- Rail not done → say what is missing and lead there, not a silent button -->
        <template v-else>
          <p class="mb-4 text-sm text-warning" data-testid="connect-blocked">
            {{ t('onboarding.steps.connect.blocked', { step: t(`onboarding.steps.${firstIncomplete}.title`) }) }}
          </p>
          <UButton
            color="primary"
            :icon="STEPS.find(s => s.key === firstIncomplete)?.icon"
            @click="goto(STEPS.findIndex(s => s.key === firstIncomplete))"
          >
            {{ t('onboarding.steps.connect.gotoMissing') }}
          </UButton>
        </template>
      </div>

      <!-- Scaling: what used to sit on the critical path. Here it comes
           after the goal, because the first connect does not need it. -->
      <div class="rounded ring ring-default p-5">
        <div class="mb-2 flex items-center gap-2">
          <UIcon name="i-lucide-radar" class="text-muted" />
          <h3 class="text-sm font-semibold text-highlighted">{{ t('onboarding.scale.title') }}</h3>
          <UBadge v-if="teachDone" size="xs" color="success" variant="subtle" icon="i-lucide-check">
            {{ t('onboarding.stepDone') }}
          </UBadge>
        </div>
        <p class="mb-3 text-sm text-muted">{{ t('onboarding.scale.body') }}</p>
        <div class="flex flex-wrap gap-3">
          <UButton
            variant="soft"
            color="neutral"
            icon="i-lucide-graduation-cap"
            data-action="scale-teach"
            @click="showTeach = !showTeach"
          >
            {{ t('onboarding.scale.teachAction') }}
          </UButton>
          <UButton variant="ghost" color="neutral" icon="i-lucide-radar" to="/">
            {{ t('onboarding.scale.scanAction') }}
          </UButton>
        </div>
        <div v-if="showTeach" class="mt-4">
          <OnboardingTeachStep @changed="refresh" />
        </div>
      </div>
    </div>

    <!-- A regular rail step: guide + jump to the existing editor -->
    <div v-else class="rounded ring ring-default bg-elevated p-5">
      <div class="mb-3 flex items-center gap-2">
        <UIcon :name="step.icon" class="text-primary" />
        <h2 class="text-base font-semibold text-highlighted">{{ t(`onboarding.steps.${step.key}.title`) }}</h2>
        <UBadge v-if="doneByKey[step.key]" size="xs" color="success" variant="subtle" icon="i-lucide-check">
          {{ t('onboarding.stepDone') }}
        </UBadge>
        <UBadge v-else size="xs" color="neutral" variant="subtle">{{ t('onboarding.stepTodo') }}</UBadge>
      </div>
      <p class="mb-4 text-sm text-muted">{{ t(`onboarding.steps.${step.key}.help`) }}</p>

      <div class="flex flex-wrap gap-3">
        <UButton
          v-if="step.to"
          :to="step.to"
          color="primary"
          :icon="step.icon"
          :variant="doneByKey[step.key] ? 'soft' : 'solid'"
        >
          {{ t(`onboarding.steps.${step.key}.action`) }}
        </UButton>
        <!-- a second path for the same step (e.g. CSV import of points) — alongside, not instead -->
        <UButton v-if="step.altTo" :to="step.altTo" variant="ghost" color="neutral" icon="i-lucide-file-up">
          {{ t(`onboarding.steps.${step.key}.altAction`) }}
        </UButton>
      </div>
    </div>


    <!-- Nav: Back / Skip / Next -->
    <div class="mt-5 flex items-center gap-2">
      <UButton
        variant="ghost"
        color="neutral"
        icon="i-lucide-chevron-left"
        :disabled="current === 0"
        @click="goto(current - 1)"
      >
        {{ t('onboarding.back') }}
      </UButton>
      <UButton variant="ghost" color="neutral" class="ml-auto" @click="goto(current + 1)">
        {{ t('onboarding.skip') }}
      </UButton>
      <UButton
        color="primary"
        trailing-icon="i-lucide-chevron-right"
        :disabled="isLast"
        @click="goto(current + 1)"
      >
        {{ t('onboarding.next') }}
      </UButton>
    </div>
  </AdminPage>
</template>
