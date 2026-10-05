// A user with a temp password (app_metadata.must_change_password in the JWT) is
// forced to /change-password until they change it. A UX gate; the actual
// change is a self BFF endpoint.
//
// SPA auth race: `useSupabaseUser().value` is often still null when the
// middleware runs (the session restores asynchronously) → the redirect did not
// fire. Fix: awaited `getSession()` — local (no network), returns the current
// token (and its fresh app_metadata after refreshSession), so both forcing and
// lifting the force are stable.
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/change-password' || to.path === '/login')
    return
  const { data } = await useSupabaseClient().auth.getSession()
  if (data.session?.user?.app_metadata?.must_change_password === true)
    return navigateTo('/change-password')
})
