// Repository: access to device_commands (command definitions bound to a type).
// Read — menu content (no secrets); CRUD — admin via service_role.
import type { SupabaseClient } from '@supabase/supabase-js'

export type Interpreter = 'raw' | 'bash' | 'python' | 'node'
export type CommandTarget = 'ssh' | 'local'
export type CommandRole = 'operator' | 'admin' // a run is never viewer (floor of ADR-013)
export interface CommandParam { key: string, label: string, type?: string }
export interface CredRef { set_id: string, env: string }

export interface DeviceCommand {
  id: string
  type_id: string
  name: string
  body: string
  interpreter: Interpreter
  confirm: boolean
  timeout_s: number
  sort: number
  purpose: 'action' | 'probe'
  stable: boolean
  // Phase 2: execution target, form parameters,
  // task credentials, minimum run role.
  target: CommandTarget
  params: CommandParam[]
  cred_refs: CredRef[]
  min_role: CommandRole
}

const COLS = 'id,type_id,name,body,interpreter,confirm,timeout_s,sort,purpose,stable,target,params,cred_refs,min_role'

export async function listByType(client: SupabaseClient, typeId: string): Promise<DeviceCommand[]> {
  const { data, error } = await client
    .from('device_commands').select(COLS).eq('type_id', typeId).order('sort').order('name')
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return (data ?? []) as DeviceCommand[]
}

export async function getById(client: SupabaseClient, id: string): Promise<DeviceCommand | null> {
  const { data, error } = await client.from('device_commands').select(COLS).eq('id', id).maybeSingle()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return (data as DeviceCommand) ?? null
}

export type CommandInput = Omit<DeviceCommand, 'id'>

export async function createCommand(client: SupabaseClient, input: CommandInput): Promise<DeviceCommand> {
  const { data, error } = await client.from('device_commands').insert(input).select(COLS).single()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return data as DeviceCommand
}

export async function updateCommand(client: SupabaseClient, id: string, patch: Partial<CommandInput>): Promise<DeviceCommand> {
  const { data, error } = await client
    .from('device_commands').update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id).select(COLS).single()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return data as DeviceCommand
}

export async function removeCommand(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('device_commands').delete().eq('id', id)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
}
