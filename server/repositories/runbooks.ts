// Repository: access to runbooks (procedures per device type + point override).
// Read — require-profile (reference); CRUD — admin via service_role.
import type { SupabaseClient } from '@supabase/supabase-js'

export interface Runbook {
  id: string
  type_id: string | null
  point_id: string | null
  title: string
  body: string
  sort: number
}

const COLS = 'id,type_id,point_id,title,body,sort'

// The table is small (admin content, dozens) → fetch all; "which apply to a point"
// is decided by the pure applicableRunbooks in the service (unit-tested, no DB).
export async function listAll(client: SupabaseClient): Promise<Runbook[]> {
  const { data, error } = await client.from('runbooks').select(COLS).order('sort').order('title')
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return (data ?? []) as Runbook[]
}

export type RunbookInput = Omit<Runbook, 'id'>

export async function createRunbook(client: SupabaseClient, input: RunbookInput): Promise<Runbook> {
  const { data, error } = await client.from('runbooks').insert(input).select(COLS).single()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return data as Runbook
}

export async function updateRunbook(client: SupabaseClient, id: string, patch: Partial<RunbookInput>): Promise<Runbook> {
  const { data, error } = await client
    .from('runbooks').update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id).select(COLS).single()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return data as Runbook
}

export async function removeRunbook(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('runbooks').delete().eq('id', id)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
}
