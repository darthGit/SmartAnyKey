// Security headers on every response; the CSP is (re)computed on the rendered document
// so the inline-script hashes match exactly what this response carries.
// `render:response` gets `{ body, headers }` and
// applies `headers` after the hook (nitropack renderer, measured on the built output).
import { buildSecurityHeaders, inlineScriptHashes } from '../utils/security-headers'

export default defineNitroPlugin((nitroApp) => {
  const { supabase } = useRuntimeConfig().public
  const input = (scriptHashes: string[]) => ({
    supabaseUrl: supabase.url,
    // The same TLS switch as the session cookie — ADR-019.
    secure: !!supabase.cookieOptions?.secure,
    scriptHashes,
  })

  nitroApp.hooks.hook('request', (event) => {
    const headers = buildSecurityHeaders(input([]))
    // Vite HMR injects its own inline scripts and ws — no CSP in dev.
    if (import.meta.dev) delete headers['Content-Security-Policy']
    setResponseHeaders(event, headers)
  })

  nitroApp.hooks.hook('render:response', (response) => {
    if (import.meta.dev || typeof response.body !== 'string') return
    const csp = buildSecurityHeaders(input(inlineScriptHashes(response.body)))['Content-Security-Policy']!
    response.headers = { ...response.headers, 'Content-Security-Policy': csp }
  })
})
