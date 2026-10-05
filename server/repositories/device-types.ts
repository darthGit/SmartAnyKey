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
  sort?: number
}

const COLS = 'id,slug,name,icon,color,default_action,sort'
const dbFail = (msg: string): never => {
  throw createError({ statusCode: 502, statusMessage: `DB: ${msg}` })
}
const slugTaken = (): never => {
  throw createError({ statusCode: 409, statusMessage: 'slug already exists' })
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
    dbFail(error.message)
  }
  return data
}

export async function updateType(sr: SupabaseClient, id: string, patch: Partial<DeviceTypeInput>) {
  const { data, error } = await sr.from('device_types').update(patch).eq('id', id).select(COLS).single()
  if (error) {
    if (error.code === '23505') slugTaken()
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
