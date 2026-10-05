// Security headers + CSP built from runtime config.
// The CSP cannot be baked at build time: one image serves every install, and both the
// Supabase origin and the inline-config hash depend on that install (same as ADR-019).
import { createHash } from 'node:crypto'

export interface SecurityHeaderInput {
  supabaseUrl: string
  secure: boolean
  scriptHashes: string[]
}

// ponytail: short max-age, no includeSubDomains/preload — removing the TLS proxy
// would otherwise lock technicians out of http for a long time.
const HSTS_MAX_AGE = 86400

export function buildSecurityHeaders({ supabaseUrl, secure, scriptHashes }: SecurityHeaderInput): Record<string, string> {
  const connect = ["'self'"]
  if (supabaseUrl) {
    const u = new URL(supabaseUrl)
    connect.push(u.origin, `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`)
  }
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    // guacamole-common-js, xterm and Nuxt UI write element.style, so inline styles stay allowed.
    "style-src 'self' 'unsafe-inline'",
    // guac frames are data:/blob: images, the cursor is a data: URL.
    "img-src 'self' data: blob:",
    `connect-src ${connect.join(' ')}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')

  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': csp,
  }
  if (secure) headers['Strict-Transport-Security'] = `max-age=${HSTS_MAX_AGE}`
  return headers
}

// sha256 of every inline executable <script> (no src, not a JSON data block).
export function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attrs]) => !/\bsrc=/.test(attrs!) && !/type="application\/json"/.test(attrs!))
    .map(([, , body]) => `'sha256-${createHash('sha256').update(body!).digest('base64')}'`)
}
