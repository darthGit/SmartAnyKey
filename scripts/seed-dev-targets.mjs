// Dev target seeder: all three fake devices on point 9999 — testbox (SSH),
// dev-vnc (VNC/RandR), dev-rdp (RDP/xrdp). Creates a device + an encrypted
// credential_set (AES-256-GCM, key NUXT_CRED_ENCRYPTION_KEY) + a device binding
// on the protocol. For dev-rdp it also sets user abc's password in the
// container (xrdp logs in a system user). Idempotent.
// Run after db-migrate and with `docker compose --profile dev up -d dev-vnc dev-rdp`.
//
// ponytail: the GCM crypto (3 lines) is duplicated from server/services/crypto.ts —
// .mjs does not import .ts; the iv|tag|ct format is from ADR-009.
import { createCipheriv, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { psql, q } from './lib/pg.mjs'

const COMPOSE = ['compose', '-f', 'docker/docker-compose.yml', '-f', 'docker/docker-compose.dev.yml', '--env-file', 'docker/.env']

// ⚠ The device host depends on where the app runs — and not the same way for
// all three:
//   • VNC/RDP: **guacd** connects to them (it is in compose), so compose DNS
//     `dev-vnc`/`dev-rdp` is right in both modes;
//   • SSH: **the BFF itself** connects (ssh2 in the app process), so host-dev
//     (`pnpm dev` on the host) needs `127.0.0.1:2222`, and in-compose needs
//     `testbox`. Hence env `DEV_TESTBOX_HOST`. Without it the SSH terminal
//     silently fails to connect in compose mode.
const TESTBOX_HOST = process.env.DEV_TESTBOX_HOST || '127.0.0.1'

// TigerVNC truncates the VNC password to 8 characters → effectively 'testbox-'; RDP takes it whole.
const TARGETS = [
  { label: 'Testbox SSH', set: 'Testbox SSH [testbox]', host: TESTBOX_HOST, port: 2222, action: 'ssh', user: 'smartanykey', pass: 'testbox-secret-pass', type: 'rpi-music' },
  { label: 'VNC dev (dev-vnc)', set: 'VNC dev [dev-vnc]', host: 'dev-vnc', port: 5901, action: 'vnc', user: null, pass: 'testbox-secret-pass', type: 'pos' },
  { label: 'RDP dev (dev-rdp)', set: 'RDP dev [dev-rdp]', host: 'dev-rdp', port: 3389, action: 'rdp', user: 'abc', pass: 'testbox-secret-pass', type: 'pc' },
]

export function keyHex() {
  let k = process.env.NUXT_CRED_ENCRYPTION_KEY
  if (!k) {
    const line = readFileSync('.env', 'utf8').split('\n').find(l => l.startsWith('NUXT_CRED_ENCRYPTION_KEY='))
    k = line?.split('=')[1]?.trim()
  }
  if (!k || Buffer.from(k, 'hex').length !== 32)
    throw new Error('NUXT_CRED_ENCRYPTION_KEY missing or not 64 hex')
  return k
}

export function encryptHex(plain, kHex) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', Buffer.from(kHex, 'hex'), iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('hex')
}

// Guard against a silent zero rows: the insert below goes through
// `with ty as (select … from device_types where slug=…) insert … select … from p, ty`
// — on an empty taxonomy the `ty` CTE is empty, so insert inserts 0 rows with no
// error, and `ON_ERROR_STOP=1` does not see it. Hence the explicit check.
// A pure function (testable without a DB): tests/delivery/seed-guard.spec.ts.
export function requireTypes(required, present) {
  const have = new Set(present)
  const missing = required.filter(s => !have.has(s))
  if (missing.length) {
    throw new Error(
      `device_types lacks slug(s): ${missing.join(', ')}. `
      + 'Seed the taxonomy first: psql -f supabase/seeds/dev.sql '
      + '(migrations hold DDL only — data lives in seeds/dev.sql).',
    )
  }
}

async function main() {
  const kHex = keyHex()

  const slugs = psql(['-tAc', 'select slug from public.device_types'])
    .split('\n').map(x => x.trim()).filter(Boolean)
  requireTypes([...new Set(TARGETS.map(t => t.type))], slugs)

  // point 9999 (guaranteed without depending on the constraint name)
  psql(['-c', `insert into public.points (number, address, subnet)
  select 9999, 'DEV: test point', '172.30.0.0/24'::cidr
  where not exists (select 1 from public.points where number = 9999);`])

  for (const t of TARGETS) {
    const encHex = encryptHex(t.pass, kHex)
    const sql = `
      -- The order is not cosmetic: \`credential_bindings.target_id\` is POLYMORPHIC,
      -- with no FK (0004), so deleting a device does NOT cascade to it.
      -- First drop the device bindings of the device being replaced, otherwise
      -- a repeated seed would pile up orphaned rows — including a legacy set
      -- under a different name.
      delete from public.credential_bindings b
        using public.devices d, public.points p
        where b.level = 'device' and b.target_id = d.id
          and d.point_id = p.id and p.number = 9999 and d.label = ${q(t.label)};
      delete from public.devices d using public.points p
        where d.point_id = p.id and p.number = 9999 and d.label = ${q(t.label)};
      delete from public.credential_sets where name = ${q(t.set)};
      with p as (select id from public.points where number = 9999),
           ty as (select id from public.device_types where slug = ${q(t.type)}),
           d as (
             insert into public.devices (point_id, type_id, label, host, actions, default_action, sort)
             select p.id, ty.id, ${q(t.label)}, ${q(t.host)}, array[${q(t.action)}], ${q(t.action)}, 5
             from p, ty returning id
           ),
           s as (
             insert into public.credential_sets (name, username, password_enc, port)
             values (${q(t.set)}, ${t.user ? q(t.user) : 'null'}, '\\x${encHex}'::bytea, ${t.port})
             returning id
           )
      insert into public.credential_bindings (level, target_id, action, cred_set_id)
      select 'device', d.id, ${q(t.action)}, s.id from d, s;`
    psql(['--single-transaction', '-c', sql])
    console.log(`✓ ${t.label} → ${t.host}:${t.port} (${t.action})`)
  }

  // dev-rdp: xrdp logs in a system user, so the password must be set in the
  // container. Don't fail the whole seed if the container is not up: the other
  // targets are already seeded, and this is a fixable detail with a visible cause.
  const rdp = spawnSync('docker', [...COMPOSE, 'exec', '-T', 'dev-rdp', 'bash', '-c', `echo 'abc:testbox-secret-pass' | chpasswd`], { encoding: 'utf8' })
  if (rdp.status === 0)
    console.log('✓ dev-rdp: password abc set')
  else
    console.warn('⚠ dev-rdp: password not set (is the container up? `-f docker/docker-compose.dev.yml up -d dev-rdp`)')
}

// CLI gate: without it an `import` of this file ran the seeder. Not in theory —
// on 2026-09-04 a `vitest` run really reseeded the dev DB just because a test
// imported `requireTypes` (and on a machine without the stack the same import
// failed with `process.exit(1)`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main()
