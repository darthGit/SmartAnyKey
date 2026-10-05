// Live wizard progress: counts 5 done-conditions from the DB (client select,
// RLS-authenticated — ADR-002/013) → pure logic in utils/onboardingProgress
// (done state + first-incomplete). No separate wizard_state table — progress is
// derived from data; a step may "roll back" if data was deleted outside the
// wizard (correct, not a bug).
// SPA auth race: fetch only once the session is restored.
import type { OnboardingCounts } from '~/utils/onboardingProgress'
import { firstIncompleteStep, onboardingSteps } from '~/utils/onboardingProgress'

export function useOnboardingProgress() {
  const supabase = useSupabaseClient()
  const session = useSupabaseSession()

  const counts = ref<OnboardingCounts>({
    pointsWithSubnet: 0, deviceTypes: 0, credentialSets: 0, signatures: 0, confirmedDevices: 0,
  })
  const loading = ref(true)

  // <Q> = supabase query builder (its type is not exported as stable) — the generic
  // keeps in→out identity and does not drag in `any`.
  async function head<Q>(table: string, apply?: (q: Q) => Q): Promise<number> {
    let q = supabase.from(table).select('id', { count: 'exact', head: true })
    if (apply)
      q = apply(q)
    const { count } = await q
    return count ?? 0
  }

  // credential_sets has RLS **deny-all** (ADR-009: a vault with a secret — not
  // even a count leaks to the client), so a client select here always returned 0
  // and the "credentials" step NEVER turned green — measured 2026-09-17 on a live
  // DB with seven sets. Count via the BFF route that feeds /admin/credentials;
  // the wizard is admin-gated, so the right to it is there.
  async function credentialCount(): Promise<number> {
    const token = session.value?.access_token
    if (!token)
      return 0
    try {
      const sets = await $fetch<unknown[]>('/api/credentials', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return sets.length
    }
    catch {
      // not admin or the route is unavailable → the step stays "not done", not a crash
      return 0
    }
  }

  async function refresh() {
    const [pts, types, creds, sigs, devs] = await Promise.all([
      head('points', q => q.not('subnet', 'is', null)),
      head('device_types'),
      credentialCount(),
      head('device_type_signatures'),
      head('devices'),
    ])
    counts.value = {
      pointsWithSubnet: pts, deviceTypes: types, credentialSets: creds, signatures: sigs, confirmedDevices: devs,
    }
    loading.value = false
  }

  // gate on a restored session (RLS returns empty if fetched before it)
  watch(session, (s) => { if (s) refresh() }, { immediate: true })

  const steps = computed(() => onboardingSteps(counts.value))
  const firstIncomplete = computed(() => firstIncompleteStep(counts.value))

  return { counts, steps, firstIncomplete, loading, refresh }
}
