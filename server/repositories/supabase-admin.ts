// Repository: event-free service-role client + token verification. Needed
// for the ws controller, where there is no H3Event (so serverSupabaseServiceRole/
// serverSupabaseUser are unavailable). The only layer that creates a supabase client
// directly (3-tier).
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { tokenAal } from '../utils/mfa'
import { mfaVerdict } from './mfa'

let client: SupabaseClient | null = null

export function adminClient(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_KEY
    if (!url || !key)
      throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set')
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  }
  return client
}

export async function getUserByToken(token: string): Promise<{ id: string, email?: string } | null> {
  if (!token)
    return null
  const { data, error } = await adminClient().auth.getUser(token)
  if (error || !data.user)
    return null
  // A session (terminal, desktop, files) is refused to a token that still owes the second factor.
  return await mfaVerdict(adminClient(), data.user.id, tokenAal(token)) === 'ok' ? data.user : null
}
