// Applies seed file(s). Separate from `db-migrate.mjs` on purpose: migrations
// are journaled and run once, seeds are idempotent and rerunnable on demand
// (migrations = schema, data = seeds).
//
//   node scripts/seed-sql.mjs supabase/seeds/dev.sql
//   docker compose run --rm app node scripts/seed-sql.mjs supabase/seeds/dev.sql
import { psql } from './lib/pg.mjs'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('usage: node scripts/seed-sql.mjs <file.sql> [file.sql …]')
  process.exit(1)
}

for (const f of files) {
  // --single-transaction: a seed applies entirely or not at all. Without it a
  // failure midway leaves a half-seeded DB that is hard to tell apart from
  // "almost fine".
  psql(['--single-transaction', '-f', f])
  console.log(`✓ ${f}`)
}
