// RBAC client role. Reads its own profiles.role (self-select RLS), bound to the
// session (SPA: a fetch can outrun session restoration). This is a UX gate;
// real enforcement is server-side (requireRole / RLS). useState → one value
// for all components.
type Role = 'viewer' | 'operator' | 'admin'
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 }

export function useRole() {
  const supabase = useSupabaseClient()
  const session = useSupabaseSession()
  const role = useState<Role | null>('rbac-role', () => null)

  async function load() {
    const uid = session.value?.user?.id
    if (!uid) {
      role.value = null
      return
    }
    const { data } = await supabase.from('profiles').select('role').eq('user_id', uid).maybeSingle()
    role.value = (data as { role?: Role } | null)?.role ?? null
  }
  watch(session, (s, prev) => { if (s && !prev) load() }, { immediate: true })

  const can = (min: Role) => !!role.value && RANK[role.value] >= RANK[min]

  return {
    role,
    isAdmin: computed(() => role.value === 'admin'),
    canOperate: computed(() => can('operator')),
    can,
    load,
  }
}
