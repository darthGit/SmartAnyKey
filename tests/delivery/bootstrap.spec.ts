// bootstrap generates its own secrets (ANON/SERVICE_ROLE signed by the generated
// JWT_SECRET, no key equals the public demo value) and NEVER overwrites an
// existing .env without --force (losing NUXT_CRED_ENCRYPTION_KEY = losing every
// password_enc, ADR-009).
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — .mjs script without types
import { dockerEnv, generateSecrets, nextSteps, signHs256, staleSecrets, writeEnvFile } from '../../scripts/bootstrap.mjs'

const DEMO = readFileSync('docker/.env.example', 'utf8')
function demoValue(key: string): string {
  const line = DEMO.split('\n').find(l => l.startsWith(`${key}=`))
  if (!line) throw new Error(`docker/.env.example has no ${key} — the test relies on the real file`)
  return line.slice(key.length + 1).trim()
}

function decodeSegment(seg: string): unknown {
  return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
}

/** Independent signature check — the test does NOT call our own signHs256 to verify. */
function hs256(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('bootstrap: generated secrets', () => {
  it('anon_and_service_keys_are_hs256_signed_by_generated_secret', () => {
    const s = generateSecrets()
    expect(Buffer.from(s.credEncryptionKey, 'hex')).toHaveLength(32) // ADR-009: 64 hex
    expect(s.jwtSecret.length).toBeGreaterThanOrEqual(32) // GoTrue requires ≥32

    for (const [key, role] of [[s.anonKey, 'anon'], [s.serviceKey, 'service_role']] as const) {
      const [h, p, sig] = key.split('.')
      expect(decodeSegment(h)).toMatchObject({ alg: 'HS256', typ: 'JWT' })
      expect(decodeSegment(p)).toMatchObject({ role })
      expect(sig, `${role}: signature is not HS256 from the generated JWT_SECRET`)
        .toBe(hs256(`${h}.${p}`, s.jwtSecret))
    }
  })

  it('no_generated_key_equals_demo_value', () => {
    const s = generateSecrets()
    const demos = new Set([
      demoValue('POSTGRES_PASSWORD'),
      demoValue('JWT_SECRET'),
      demoValue('ANON_KEY'),
      demoValue('SERVICE_ROLE_KEY'),
      demoValue('EXECUTOR_SHARED_SECRET'),
    ])
    for (const [name, value] of Object.entries(s)) {
      expect(demos.has(String(value)), `${name} equals the public demo value`).toBe(false)
    }
  })

  // The template marks every secret with a "generate with …" comment. A marked
  // key left at its example value is a secret shared by every install — e.g. the
  // S3 protocol keys, which open Storage on the public port without an apikey.
  it('every_secret_the_template_asks_to_generate_is_replaced', () => {
    const lines = DEMO.split('\n')
    const marked = lines.flatMap((l, i) => {
      const m = /^([A-Z0-9_]+)=(.+)$/.exec(l)
      const comment = lines.slice(Math.max(0, i - 3), i).join(' ')
      return m && /generate with/i.test(comment) ? [[m[1], m[2].trim()]] : []
    })
    expect(marked.map(([k]) => k)).toEqual(['SECRET_KEY_BASE', 'REALTIME_DB_ENC_KEY', 'PG_META_CRYPTO_KEY', 'S3_PROTOCOL_ACCESS_KEY_ID', 'S3_PROTOCOL_ACCESS_KEY_SECRET'])
    const out = new Map(dockerEnv(generateSecrets()).split('\n').map((l: string) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]))
    const leftAsExample = marked.filter(([k, v]) => out.get(k) === v).map(([k]) => k)
    expect(leftAsExample).toEqual([])
  })

  // An existing install is never overwritten, so it must at least be told which
  // secrets it still shares with every other install — names only, never values.
  it('names_the_secrets_an_existing_env_still_shares_with_the_template', () => {
    const existing = dockerEnv(generateSecrets()).replace(/^S3_PROTOCOL_ACCESS_KEY_SECRET=.*$/m, `S3_PROTOCOL_ACCESS_KEY_SECRET=${demoValue('S3_PROTOCOL_ACCESS_KEY_SECRET')}`)
    expect(staleSecrets(existing, DEMO)).toEqual(['S3_PROTOCOL_ACCESS_KEY_SECRET'])
    expect(staleSecrets(dockerEnv(generateSecrets()), DEMO)).toEqual([])
  })

  it('signs_with_the_secret_it_is_given', () => {
    const token = signHs256({ role: 'anon' }, 'secret-of-at-least-32-characters!!')
    const [h, p, sig] = token.split('.')
    expect(sig).toBe(hs256(`${h}.${p}`, 'secret-of-at-least-32-characters!!'))
    expect(decodeSegment(p)).toMatchObject({ role: 'anon' })
  })
})

describe('bootstrap: overwrite guard', () => {
  it('refuses_to_overwrite_existing_env_without_force', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sak-bootstrap-'))
    const path = join(dir, '.env')
    writeFileSync(path, 'NUXT_CRED_ENCRYPTION_KEY=deadbeef\n')

    expect(writeEnvFile(path, 'NUXT_CRED_ENCRYPTION_KEY=new\n')).toBe('kept')
    expect(readFileSync(path, 'utf8')).toContain('deadbeef') // key still in place

    expect(writeEnvFile(path, 'NUXT_CRED_ENCRYPTION_KEY=new\n', { force: true })).toBe('written')
    expect(readFileSync(path, 'utf8')).toContain('new')
  })

  it('writes_when_file_is_absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sak-bootstrap-'))
    const path = join(dir, '.env')
    expect(writeEnvFile(path, 'A=1\n')).toBe('written')
    expect(readFileSync(path, 'utf8')).toBe('A=1\n')
  })
})

describe('bootstrap: what it tells the person running it', () => {
  it('prints_the_manual_steps_when_run_by_hand', () => {
    expect(nextSteps({ written: true, fromInstaller: false }).join('\n')).toMatch(/db-migrate/)
  })

  it('stays_quiet_about_manual_steps_under_install_sh', () => {
    // install.sh does every one of them itself; a client reading "run db-migrate"
    // mid-install would think the install is waiting on them.
    expect(nextSteps({ written: true, fromInstaller: true })).toEqual([])
  })
})
