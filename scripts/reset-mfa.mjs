// Removes every second factor of one user — for the last admin who lost their phone, when
// nobody is left to reset it in the UI. Runs where the other ops scripts run:
//
//   docker compose run --rm app node scripts/reset-mfa.mjs <email>
//
// The next sign-in is a password; if the role is under the 2FA policy, enrollment follows.
import { createClient } from '@supabase/supabase-js'

const email = process.argv[2]
const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_KEY
if (!email || !url || !key) {
  console.error('usage: node scripts/reset-mfa.mjs <email>   (needs SUPABASE_URL, SUPABASE_SERVICE_KEY)')
  process.exit(2)
}

const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
if (error)
  throw new Error(`listUsers: ${error.message}`)
const user = data.users.find(u => u.email?.toLowerCase() === email.toLowerCase())
if (!user) {
  console.error(`no user ${email}`)
  process.exit(1)
}
const { data: f, error: fErr } = await admin.auth.admin.mfa.listFactors({ userId: user.id })
if (fErr)
  throw new Error(`listFactors: ${fErr.message}`)
for (const factor of f.factors) {
  const { error: dErr } = await admin.auth.admin.mfa.deleteFactor({ id: factor.id, userId: user.id })
  if (dErr)
    throw new Error(`deleteFactor: ${dErr.message}`)
}
console.log(`${email}: ${f.factors.length} factor(s) removed`)
