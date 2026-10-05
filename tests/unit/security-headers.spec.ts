// The fixture is the real `/login` shell of the built
// app (`node .output/server/index.mjs` + curl, Supabase URL = sb.example.com, key = dummy).
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildSecurityHeaders, inlineScriptHashes } from '../../server/utils/security-headers'

const html = readFileSync('tests/fixtures/spa-login.html', 'utf8')

const lower = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))

const csp = (h: Record<string, string>) => {
  const raw = lower(h)['content-security-policy'] ?? ''
  return Object.fromEntries(
    raw.split(';').map(d => d.trim().split(/\s+/)).filter(t => t[0]).map(([name, ...v]) => [name, v]),
  ) as Record<string, string[]>
}

const headers = (o: Partial<{ supabaseUrl: string, secure: boolean, scriptHashes: string[] }> = {}) =>
  buildSecurityHeaders({ supabaseUrl: 'http://sb.example.com:8000', secure: false, scriptHashes: [], ...o })

describe('security headers', () => {
  it('base_headers (AC-1)', () => {
    const h = lower(headers())
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['x-frame-options']).toBe('DENY')
    expect(h['referrer-policy']).toBe('same-origin')
    expect(csp(headers())['frame-ancestors']).toEqual(["'none'"])
  })

  it('hsts_only_when_secure (AC-2)', () => {
    expect(lower(headers())['strict-transport-security']).toBeUndefined()
    const hsts = lower(headers({ secure: true }))['strict-transport-security']
    expect(hsts).toMatch(/^max-age=\d+$/) // no includeSubDomains / preload: a short, reversible pin
  })

  it('no_iframe_in_app (AC-3)', () => {
    // The AC's own mechanism: `git grep` exits 1 when nothing matches.
    let out = ''
    try {
      out = execSync("git grep -l '<iframe' -- app/", { encoding: 'utf8' })
    }
    catch (e) {
      expect((e as { status: number }).status).toBe(1)
    }
    expect(out).toBe('')
  })

  it('connect_src_from_runtime_url (AC-4)', () => {
    expect(csp(headers())['connect-src']).toEqual(
      expect.arrayContaining(["'self'", 'http://sb.example.com:8000', 'ws://sb.example.com:8000']),
    )
    // A different install address changes the header — it is not baked in.
    const tls = csp(headers({ supabaseUrl: 'https://db.example.org/' }))['connect-src']
    expect(tls).toEqual(expect.arrayContaining(['https://db.example.org', 'wss://db.example.org']))
    expect(tls).not.toContain('http://sb.example.com:8000')
  })

  it('script_src_hashes_no_unsafe_inline (AC-5)', () => {
    // Expected hashes computed here, independently of the parser under test:
    // the two executable inline scripts of the real page, not the JSON data block.
    const bodies = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!)
    expect(bodies).toHaveLength(2)
    const expected = bodies.map(b => `'sha256-${createHash('sha256').update(b).digest('base64')}'`)

    const hashes = inlineScriptHashes(html)
    expect(hashes).toEqual(expected)

    const src = csp(headers({ scriptHashes: hashes }))['script-src']
    expect(src).toEqual(["'self'", ...expected])
    expect(src).not.toContain("'unsafe-inline'")
  })

  it('remaining CSP directives', () => {
    const d = csp(headers())
    expect(d['default-src']).toEqual(["'self'"])
    expect(d['style-src']).toEqual(["'self'", "'unsafe-inline'"])
    expect(d['img-src']).toEqual(["'self'", 'data:', 'blob:'])
    expect(d['font-src']).toEqual(["'self'"])
    expect(d['object-src']).toEqual(["'none'"])
    expect(d['base-uri']).toEqual(["'self'"])
    expect(d['form-action']).toEqual(["'self'"])
  })
})
