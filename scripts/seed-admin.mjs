// Bootstrap the default admin. Creates/updates one auth user via the GoTrue
// admin API + sets profiles.role=admin. Idempotent: a rerun does not duplicate
// the user. Run after `node scripts/db-migrate.mjs` (0009 must create
// profiles). Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, RBAC_ADMIN_EMAIL,
// RBAC_ADMIN_PASSWORD (docker defaults in docker/.env — change them).
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

// Core (tested): create-or-update admin + upsert profiles.role=admin.
export async function seedAdmin(service, { email, password }) {
  // ponytail: perPage 1000 — bootstrap users are a handful; paginate if it grows.
  const { data: list, error: listErr } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (listErr)
    throw new Error(`listUsers: ${listErr.message}`)

  let user = (list?.users ?? []).find(u => u.email === email)
  if (!user) {
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true })
    if (error)
      throw new Error(`createUser: ${error.message}`)
    user = data.user
  }
  else if (password) {
    await service.auth.admin.updateUserById(user.id, { password })
  }

  const { error: pErr } = await service.from('profiles')
    .upsert({ user_id: user.id, role: 'admin', updated_at: new Date().toISOString() })
  if (pErr)
    throw new Error(`profiles upsert: ${pErr.message}`)

  return user.id
}

function env(key) {
  if (process.env[key])
    return process.env[key]
  try {
    const line = readFileSync('.env', 'utf8').split('\n').find(l => l.startsWith(`${key}=`))
    if (line)
      return line.slice(key.length + 1).trim()
  }
  catch { /* no .env → stay on process.env */ }
  return undefined
}

// CLI: an import from a test skips this block (import.meta.url !== argv[1]).
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = env('SUPABASE_URL')
  const serviceKey = env('SUPABASE_SERVICE_KEY')
  const email = env('RBAC_ADMIN_EMAIL')
  const password = env('RBAC_ADMIN_PASSWORD')
  if (!url || !serviceKey) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY are required')
    process.exit(1)
  }
  if (!email || !password) {
    console.error('RBAC_ADMIN_EMAIL / RBAC_ADMIN_PASSWORD are required')
    process.exit(1)
  }
  const id = await seedAdmin(createClient(url, serviceKey), { email, password })
  console.log(`admin seeded: ${email} (${id})`)
}
