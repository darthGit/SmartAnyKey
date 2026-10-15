// Showcase data: a fictional branch network for the README media and the demo
// install. Applies supabase/seeds/showcase.sql, then the credentials — they need
// the runtime key (ADR-009), so they cannot live in plain SQL. Bound at the TYPE
// level: one set per role opens every branch's device, which is also what the
// credential manager screenshot shows. Idempotent: reruns replace the secrets.
//
//   node scripts/seed-showcase.mjs
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { psql, q } from './lib/pg.mjs'
import { encryptHex, keyHex, requireTypes } from './seed-dev-targets.mjs'

// Must match the demo targets in docker/docker-compose.demo.yml. TigerVNC truncates
// the VNC password to 8 characters; xrdp logs in the system user `abc`.
export const SETS = [
  { name: 'Branch routers (SSH)', type: 'gateway', action: 'ssh', user: 'support', pass: 'demo-secret-pass', port: 22 },
  { name: 'Signage players (SSH)', type: 'signage', action: 'ssh', user: 'support', pass: 'demo-secret-pass', port: 22 },
  { name: 'Front desk (VNC)', type: 'front-desk', action: 'vnc', user: null, pass: 'demo-secret-pass', port: 5901 },
  { name: 'Back office (RDP)', type: 'back-office', action: 'rdp', user: 'abc', pass: 'demo-secret-pass', port: 3389 },
]

function main() {
  const kHex = keyHex()
  psql(['--single-transaction', '-f', 'supabase/seeds/showcase.sql'])
  console.log('✓ supabase/seeds/showcase.sql')

  const slugs = psql(['-tAc', 'select slug from public.device_types']).split('\n').map(x => x.trim()).filter(Boolean)
  requireTypes(SETS.map(s => s.type), slugs)

  for (const s of SETS) {
    psql(['--single-transaction', '-c', `
      with cs as (
        insert into public.credential_sets (name, username, password_enc, port)
        values (${q(s.name)}, ${s.user ? q(s.user) : 'null'}, '\\x${encryptHex(s.pass, kHex)}'::bytea, ${s.port})
        on conflict (name) do update set username = excluded.username,
          password_enc = excluded.password_enc, port = excluded.port, updated_at = now()
        returning id
      )
      insert into public.credential_bindings (level, target_id, action, cred_set_id)
      select 'type', t.id, ${q(s.action)}, cs.id
      from cs, public.device_types t where t.slug = ${q(s.type)}
      on conflict (level, target_id, action) where target_id is not null
      do update set cred_set_id = excluded.cred_set_id;`])
    console.log(`✓ ${s.name} → every ${s.type} (${s.action})`)
  }

  // xrdp checks the system password inside the target. From the host this sets it;
  // inside the app image there is no docker CLI, and install.sh --demo does it instead.
  const rdp = spawnSync('docker', ['compose', '-f', 'docker/docker-compose.yml', '-f', 'docker/docker-compose.demo.yml',
    '--env-file', 'docker/.env', 'exec', '-T', 'demo-office', 'bash', '-c', `echo 'abc:demo-secret-pass' | chpasswd`], { encoding: 'utf8' })
  console.log(rdp.status === 0 ? '✓ back office RDP: password set' : '· back office RDP password: set by install.sh --demo (no docker here)')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main()
