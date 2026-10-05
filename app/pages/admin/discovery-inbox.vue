<script setup lang="ts">
// Drift inbox. CSR, Nuxt UI, i18n
// (ADR-006). Points with unacknowledged drift from scheduled rescans; ack clears a
// whole point in one action (bulk, not N per-row confirmations). Read + ack via
// admin BFF (requireRole admin); client carries Bearer.
type ChangeType = 'new' | 'changed' | 'missing' | 'rogue'
interface InboxPoint {
  point_id: string
  point_number: number
  counts: Record<ChangeType, number>
  total: number
  escalated: string[]
}

const { t } = useI18n()
const session = useSupabaseSession()
const authHeaders = computed(() => ({ Authorization: `Bearer ${session.value?.access_token}` }))

const points = ref<InboxPoint[]>([])
const loadErr = ref('')
const busy = ref('')

const TYPES: ChangeType[] = ['new', 'changed', 'missing', 'rogue']
const typeColor: Record<ChangeType, 'success' | 'warning' | 'error' | 'neutral'> = {
  new: 'success', changed: 'warning', missing: 'neutral', rogue: 'error',
}

async function load() {
  loadErr.value = ''
  try {
    points.value = await $fetch<InboxPoint[]>('/api/discovery/inbox', { headers: authHeaders.value })
  }
  catch (e) {
    loadErr.value = t('driftInbox.loadError', { message: (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message })
  }
}

// SPA: gate fetch on session (RLS/auth race).
onMounted(load)
watch(session, (s, prev) => { if (s && !prev) load() })

async function ack(p: InboxPoint) {
  busy.value = p.point_id
  try {
    await $fetch(`/api/discovery/inbox/${p.point_id}/ack`, { method: 'POST', headers: authHeaders.value })
    await load()
  }
  catch (e) {
    loadErr.value = t('driftInbox.ackError', { message: (e as { data?: { statusMessage?: string } }).data?.statusMessage ?? (e as Error).message })
  }
  finally {
    busy.value = ''
  }
}
</script>

<template>
  <AdminPage :title="t('driftInbox.title')" :subtitle="t('driftInbox.subtitle')">
    <template #actions>
      <UButton icon="i-lucide-refresh-cw" variant="ghost" color="neutral" @click="load">{{ t('driftInbox.refresh') }}</UButton>
    </template>

    <p v-if="loadErr" class="mb-3 text-sm text-error">{{ loadErr }}</p>

    <p v-if="!points.length" class="text-muted">{{ t('driftInbox.empty') }}</p>
    <ul v-else class="divide-y divide-default rounded ring ring-default">
      <li v-for="p in points" :key="p.point_id" class="flex items-center gap-3 p-3">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium text-highlighted">{{ t('driftInbox.point', { number: p.point_number }) }}</span>
            <UBadge
              v-for="ct in TYPES"
              v-show="p.counts[ct]"
              :key="ct"
              size="xs"
              :color="typeColor[ct]"
              variant="subtle"
            >
              {{ t(`driftInbox.type.${ct}`) }}: {{ p.counts[ct] }}
            </UBadge>
            <UBadge v-if="p.escalated.length" size="xs" color="error" variant="solid" icon="i-lucide-triangle-alert">
              {{ t('driftInbox.escalated', { count: p.escalated.length }) }}
            </UBadge>
          </div>
          <p v-if="p.escalated.length" class="mt-1 text-xs text-muted">
            {{ t('driftInbox.escalatedHint', { hosts: p.escalated.join(', ') }) }}
          </p>
        </div>
        <UButton size="xs" color="primary" :loading="busy === p.point_id" @click="ack(p)">
          {{ t('driftInbox.ack', { count: p.total }) }}
        </UButton>
      </li>
    </ul>
  </AdminPage>
</template>
