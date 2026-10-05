// Repository: event-free service-role client + token verification. Needed
// for the ws controller, where there is no H3Event (so serverSupabaseServiceRole/
// serverSupabaseUser are unavailable). The only layer that creates a supabase client
// directly (3-tier).
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

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
  return error || !data.user ? null : data.user
}
