// Applies supabase/migrations/*.sql to the self-hosted stack (the supabase CLI
// is not used — the stack is our own).
// Idempotent: journal in public.schema_migrations, keyed by file name, no
// checksums (so editing a comment in an applied migration is safe, and deleting
// a file affects only new installs).
//
// Migrations are schema ONLY. Data lives in `supabase/seeds/*.sql` and does NOT
// get here — that is why a fresh install is empty, with no admin with a known
// password.
//
// Connection goes through `scripts/lib/pg.mjs`: works both from the host and inside
// the app image (`docker compose run --rm app node scripts/db-migrate.mjs`).
import { readdirSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { psql } from './lib/pg.mjs'

/**
 * Which files are not applied yet, in name order. Exported because this
 * calculation is the script's only decision, and since 2026-09-18 the Nitro
 * auto-migration plugin reads it too.
 * Order is by name and sorted on purpose: `0009_rbac.sql` references
 * `auth.users`, so reordering files = breaking a fresh install.
 * @param {Set<string>} applied @param {string[]} files @returns {string[]}
 */
export function pendingMigrations(applied, files) {
  return files.filter(f => !applied.has(f))
}

function main() {
  psql(['-c', 'create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())'])
  const applied = new Set(psql(['-tAc', 'select name from public.schema_migrations']).split('\n').filter(Boolean))

  const files = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort()
  for (const f of files) {
    if (!pendingMigrations(applied, [f]).length) {
      console.log(`skip    ${f}`)
      continue
    }
    // The file name is printed before applying: if psql fails, the last log
    // line names the culprit (the refusal must carry the file name).
    console.log(`applying ${f}`)
    psql(['--single-transaction', '-f', '-'], readFileSync(`supabase/migrations/${f}`, 'utf8'))
    psql(['-c', `insert into public.schema_migrations (name) values ('${f}')`])
    console.log(`applied ${f}`)
  }
  console.log('DB up to date.')
}

// The guard is needed since the file has an export: without it
// `import { pendingMigrations }` in a test would run psql against a live DB.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main()
