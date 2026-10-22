// Repository: data access for device_types.
// Only this layer touches the DB. Maps PG codes to human statuses (never
// silently swallow errors): 23505 unique-slug / 23503 FK → 409, not 500.
import { createError } from 'h3'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface DeviceTypeInput {
  slug: string
  name: string
  icon: string
  color: string
  default_action: string
  actions?: string[]
  sort?: number
}

const COLS = 'id,slug,name,icon,color,default_action,actions,sort'
const dbFail = (msg: string): never => {
  throw createError({ statusCode: 502, statusMessage: `DB: ${msg}` })
}
const slugTaken = (): never => {
  throw createError({ statusCode: 409, statusMessage: 'slug already exists' })
}
// device_types_actions_check: a patch with only actions or only default_action broke the pair.
const badActions = (): never => {
  throw createError({ statusCode: 400, statusMessage: 'default_action must be one of actions' })
}

export async function listTypes(sr: SupabaseClient) {
  const { data, error } = await sr.from('device_types').select(COLS).order('sort')
  if (error) dbFail(error.message)
  return data ?? []
}

export async function insertType(sr: SupabaseClient, input: DeviceTypeInput) {
  const { data, error } = await sr.from('device_types').insert(input).select(COLS).single()
  if (error) {
    if (error.code === '23505') slugTaken()
    if (error.code === '23514') badActions()
    dbFail(error.message)
  }
  return data
}

export async function updateType(sr: SupabaseClient, id: string, patch: Partial<DeviceTypeInput>) {
  const { data, error } = await sr.from('device_types').update(patch).eq('id', id).select(COLS).single()
  if (error) {
    if (error.code === '23505') slugTaken()
    if (error.code === '23514') badActions()
    dbFail(error.message)
  }
  return data
}

export async function countDevicesOfType(sr: SupabaseClient, id: string): Promise<number> {
  const { count, error } = await sr.from('devices').select('id', { count: 'exact', head: true }).eq('type_id', id)
  if (error) dbFail(error.message)
  return count ?? 0
}

export async function deleteType(sr: SupabaseClient, id: string): Promise<void> {
  const { error } = await sr.from('device_types').delete().eq('id', id)
  if (error) {
    // safety net: the service guard should catch it earlier, but an FK violation = 409, not 500.
    if (error.code === '23503') throw createError({ statusCode: 409, statusMessage: 'type in use' })
    dbFail(error.message)
  }
}

// "Apply to existing" (apply_type_actions, 0021): devices of the type missing one of its
// protocols — counted (dry run) or given the missing ones. Adds only.
async function applyActions(sr: SupabaseClient, id: string, dryRun: boolean): Promise<number> {
  const { data, error } = await sr.rpc('apply_type_actions', { p_type_id: id, p_dry_run: dryRun })
  if (error) dbFail(error.message)
  return data as number
}
export const missingActionCount = (sr: SupabaseClient, id: string) => applyActions(sr, id, true)
export const applyTypeActions = (sr: SupabaseClient, id: string) => applyActions(sr, id, false)
