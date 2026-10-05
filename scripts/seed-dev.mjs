// The dev environment in one command:
//
//   pnpm dev:seed
//
// These used to be four manual steps in the right order (migrations → start
// three containers → taxonomy seed → target seed), and everyone bringing the
// project up from scratch tripped over the order. Idempotent: a rerun yields
// the same counts and does not fail.
//
// The order is mandatory and exactly this:
//   1. migrations — without the schema the seeds have nowhere to go;
//   2. dev targets — so `dev-rdp` is already alive when the seeder sets its password;
//   3. seeds/dev.sql — taxonomy + dev user + admin grant;
//   4. seed-dev-targets.mjs — devices + encrypted credentials + bindings; the
//      guard inside fails clearly if step 3 was skipped.
//
// The demo scale (300 points / 2100 devices) is NOT part of this — that is
// `pnpm seed:demo`, since an end-to-end feature check does not need 2100 rows.
import { spawnSync } from 'node:child_process'

const COMPOSE = [
  'compose',
  '-f', 'docker/docker-compose.yml',
  '-f', 'docker/docker-compose.dev.yml',
  '--env-file', 'docker/.env',
]

function step(title, cmd, args) {
  console.log(`\n── ${title}`)
  const res = spawnSync(cmd, args, { stdio: 'inherit' })
  if (res.error)
    throw new Error(`${cmd}: ${res.error.message}`)
  if (res.status !== 0)
    throw new Error(`${title} → exit ${res.status}`)
}

try {
  // `db` is started too: on a bare volume it does not exist yet, and without it
  // migrations go nowhere. The dev overlay exposes the direct Postgres port for host-side ops.
  step('1/4 infrastructure + dev targets',
    'docker', [...COMPOSE, 'up', '-d', 'db', 'testbox', 'dev-vnc', 'dev-rdp'])
  step('2/4 migrations (schema only)', 'node', ['scripts/db-migrate.mjs'])
  step('3/4 seed dev data', 'node', ['scripts/seed-sql.mjs', 'supabase/seeds/dev.sql'])
  step('4/4 dev targets: devices + encrypted creds + bindings',
    'node', ['scripts/seed-dev-targets.mjs'])

  console.log('\n✓ dev environment ready. Login: dev@smartanykey.local / devpassword123')
  console.log('  demo scale (300 points / 2100 devices) separately: pnpm seed:demo')
}
catch (e) {
  console.error(`\n✗ dev:seed: ${e.message}`)
  process.exit(1)
}
