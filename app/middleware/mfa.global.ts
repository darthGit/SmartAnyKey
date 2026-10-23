// Second factor in the browser — a UX gate; the server refuses the same requests anyway.
// Runs after force-password-change (global middleware run in name order): a temp password
// is changed first, then the authenticator is set up.
//   has a factor, session at aal1          → /login (code step)
//   role under the policy, no factor yet   → /account (enrollment)
export default defineNuxtRouteMiddleware(async (to) => {
  if (['/login', '/setup', '/change-password', '/account'].includes(to.path))
    return
  const supabase = useSupabaseClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session)
    return
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (data?.currentLevel === 'aal2')
    return
  if (data?.nextLevel === 'aal2')
    return navigateTo('/login')
  // No factor: only the server knows whether the role must have one. Asked once per token.
  const checked = useState<string | null>('mfa-checked-token', () => null)
  if (checked.value === session.access_token)
    return
  const res = await $fetch<{ verdict: string }>('/api/auth/mfa', {
    headers: { Authorization: `Bearer ${session.access_token}` },
  }).catch(() => null)
  if (res?.verdict === 'mfa_enroll_required')
    return navigateTo('/account')
  checked.value = session.access_token
})
