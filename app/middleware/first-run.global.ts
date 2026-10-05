// ADR-021: while the installation has no admin, any path leads to /setup; as
// soon as an admin exists, /setup disappears.
//
// ⚠ This is a UX gate, not protection. The real gate is server-side:
// `/api/setup/*` themselves return 403 once an admin exists
// (`server/api/setup/status.get.ts`). The middleware only keeps a person from
// looking at /login, which will not let anyone in yet.
//
// `useState` caches the answer for the SPA session: after the admin is created
// the status never changes back, so there is no reason to ask on every navigation.
export default defineNuxtRouteMiddleware(async (to) => {
  const open = useState<boolean | null>('setup-open', () => null)

  if (open.value === null) {
    // 403 = closed, and that is a normal answer, not an error → don't throw.
    open.value = await $fetch('/api/setup/status')
      .then(() => true)
      .catch(() => false)
  }

  if (open.value && to.path !== '/setup')
    return navigateTo('/setup')
  if (!open.value && to.path === '/setup')
    return navigateTo('/login')
})
