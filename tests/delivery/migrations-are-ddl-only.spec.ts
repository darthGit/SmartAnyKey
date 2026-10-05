// Migrations contain DDL only — data moves to supabase/seeds/*.sql.
//
// The criterion is `grep -l 'insert into' supabase/migrations/*.sql` → empty.
// A literal grep fails for two files for reasons that are not "demo data", so
// they are in the allowlist with a named reason (the ceiling is named out loud,
// otherwise a green test reads as "no DML" without being that).
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const DIR = 'supabase/migrations'

const ALLOWED: Record<string, string> = {
  '0004_credential_bindings.sql':
    'data migration: `insert … select` moves EXISTING devices.cred_set_id into credential_bindings; zero literals, needed for the upgrade path',
  '0015_tasks.sql':
    '`storage.buckets` provisioning — Supabase models a bucket as a row, but it is a schema object (run artifacts do not work without it), not domain data',
  '0019_first_admin_claim.sql':
    'DDL: `create function`. `insert into public.profiles` sits in the function BODY ($$…$$), so it runs only when `/setup` calls it — the migration itself runs nothing. The detector cannot tell function bodies apart, hence an entry here rather than a looser regex',
  '0018_task_builtin.sql':
    'built-in backup recipe provisioning (AC-24): the row comes from the PRODUCT, not the client, and must exist on ANY install — in prod `supabase/seeds/*.sql` never run (only migrations + seed-admin), so in seeds this row would reach nowhere. Same class as the bucket in 0015: provisioning a product object, not domain data',
}

/** Strips `--` comments and single-quoted literals (command bodies contain SQL words). */
function strip(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

function findDml(sql: string): string[] {
  const s = strip(sql)
  const hits: string[] = []
  for (const re of [
    /\binsert\s+into\s+([a-z_][\w.]*)/gi,
    /\bupdate\s+([a-z_][\w.]*)\s+set\b/gi,
    /\bdelete\s+from\s+([a-z_][\w.]*)/gi,
    /\bcopy\s+([a-z_][\w.]*)\s+from\b/gi,
  ]) {
    for (const m of s.matchAll(re)) hits.push(`${m[0].split(/\s+/)[0].toLowerCase()} ${m[1]}`)
  }
  return [...new Set(hits)]
}

describe('migrations are DDL only', () => {
  it('no_dml_in_migrations', () => {
    const files = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
    expect(files.length).toBeGreaterThan(0)

    const offenders: Record<string, string[]> = {}
    for (const f of files) {
      if (f in ALLOWED) continue
      const dml = findDml(readFileSync(`${DIR}/${f}`, 'utf8'))
      if (dml.length) offenders[f] = dml
    }

    expect(offenders).toEqual({})
  })

  it('allowlist_entries_still_exist_and_carry_a_reason', () => {
    // Guard against a rotten allowlist: the file was deleted/renamed, but the exception stayed.
    const files = new Set(readdirSync(DIR))
    for (const [f, reason] of Object.entries(ALLOWED)) {
      expect(files.has(f), `allowlist points to a missing ${f}`).toBe(true)
      expect(reason.length).toBeGreaterThan(30)
    }
  })
})
