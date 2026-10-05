// Credential resolution (ADR-009, per-protocol amendment). Bindings keyed by
// (level, action) in credential_bindings; for a given action the first non-null in the order
// device → type → point → global wins. The password is stored encrypted;
// decryption happens here (BFF RAM). Only service_role reads it (RLS deny-all).
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptSecret, encryptSecret } from './crypto'
import type { DeviceCredentials, GuacAction } from './remote-session'

export interface CredentialLevels<T> {
  device: T | null
  type: T | null
  point: T | null
  global: T | null
}

export function pickCredentialSet<T>(levels: CredentialLevels<T>): T | null {
  return levels.device ?? levels.type ?? levels.point ?? levels.global ?? null
}

interface BindingRow {
  level: 'device' | 'type' | 'point' | 'global'
  cred_set_id: string
  // PostgREST to-one embed: the set object (bytea as "\\x<hex>").
  credential_sets: { username: string | null, password_enc: string | null, port: number | null } | null
}

// PostgREST serialises bytea into a hex string prefixed with "\x".
function byteaToBuffer(v: string): Buffer {
  return Buffer.from(v.startsWith('\\x') ? v.slice(2) : v, 'hex')
}

// The stored password does not decrypt with this install's key (a foreign key, a
// corrupted row). Its own class so the session routes can say "credentials" rather
// than "host unreachable". The message never carries the secret.
export class CredentialDecryptError extends Error {
  constructor() {
    super('stored credential does not decrypt with NUXT_CRED_ENCRYPTION_KEY')
    this.name = 'CredentialDecryptError'
  }
}

export function decryptStored(v: string, keyHex: string): string {
  try {
    return decryptSecret(byteaToBuffer(v), keyHex)
  }
  catch {
    throw new CredentialDecryptError()
  }
}

// Password → bytea literal for writing via supabase-js (the same "\x<hex>").
export function encryptToBytea(plain: string, keyHex: string): string {
  return `\\x${encryptSecret(plain, keyHex).toString('hex')}`
}

// Resolve the binding row (device>type>point>global) for an action — no decrypt/audit.
// Shared core of resolveCredentials (which adds decryption+audit) and hasCredential.
async function resolveChosenBinding(
  client: SupabaseClient,
  deviceId: string,
  action: GuacAction,
): Promise<BindingRow | null> {
  const { data: dev, error: devErr } = await client
    .from('devices').select('type_id,point_id').eq('id', deviceId).maybeSingle()
  if (devErr)
    throw createError({ statusCode: 502, statusMessage: `DB: ${devErr.message}` })
  if (!dev)
    return null

  // Candidate bindings for this action at all of the device's levels + global.
  const or = [
    `and(level.eq.device,target_id.eq.${deviceId})`,
    `and(level.eq.type,target_id.eq.${dev.type_id})`,
    dev.point_id ? `and(level.eq.point,target_id.eq.${dev.point_id})` : null,
    'level.eq.global',
  ].filter(Boolean).join(',')
  const { data, error } = await client
    .from('credential_bindings')
    .select('level,cred_set_id,credential_sets(username,password_enc,port)')
    .eq('action', action)
    .or(or)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })

  const rows = (data ?? []) as unknown as BindingRow[]
  const at = (lvl: BindingRow['level']) => rows.find(r => r.level === lvl) ?? null
  return pickCredentialSet<BindingRow>({
    device: at('device'), type: at('type'), point: at('point'), global: at('global'),
  })
}

// Pre-check before connecting: is there a resolvable cred for (device, action) — no decrypt/audit.
export async function hasCredential(client: SupabaseClient, deviceId: string, action: GuacAction): Promise<boolean> {
  return (await resolveChosenBinding(client, deviceId, action)) !== null
}

// Per-protocol cred status for the admin UI: for each action —
// whether a cred resolves + at which level (device>type>point>global). No decrypt/audit —
// the secret does not reach the client, only the fact+level. Built on the same core as hasCredential.
export async function credStatus(
  client: SupabaseClient,
  deviceId: string,
  actions: GuacAction[],
): Promise<{ action: GuacAction, resolved: boolean, level: string | null }[]> {
  const out = []
  for (const action of actions) {
    const b = await resolveChosenBinding(client, deviceId, action)
    out.push({ action, resolved: b !== null, level: b?.level ?? null })
  }
  return out
}

export async function resolveCredentials(
  client: SupabaseClient,
  deviceId: string,
  action: GuacAction,
  keyHex: string,
  audit?: { actor: string, action?: 'resolve' | 'copy' },
): Promise<DeviceCredentials | null> {
  const chosen = await resolveChosenBinding(client, deviceId, action)
  const set = chosen?.credential_sets
  if (!chosen || !set)
    return null
  if (audit)
    await logCredentialAccess(client, { actor: audit.actor, deviceId, credSetId: chosen.cred_set_id, action: audit.action ?? 'resolve' })
  return {
    username: set.username,
    password: set.password_enc ? decryptStored(set.password_enc, keyHex) : null,
    port: set.port,
  }
}

// Task-side resolution of a set directly by id (bypassing credential_bindings — task creds
// are not bound to a device/protocol). Decrypt in
// RAM + audit like a normal resolve. Amends ADR-009 (unbound sets + by-id).
// A set = login+password(+port): we return the whole set, because script authentication
// (e.g. `curl -u $USER:$PASS`) needs both. The caller injects them as
// PREFIX_USER / PREFIX_PASSWORD / PREFIX_PORT (only the password is masked).
export async function resolveSetById(
  client: SupabaseClient,
  setId: string,
  keyHex: string,
  audit: { actor: string, deviceId: string | null },
): Promise<{ username: string | null, password: string, port: number | null } | null> {
  const { data, error } = await client
    .from('credential_sets')
    .select('username,password_enc,port')
    .eq('id', setId)
    .maybeSingle()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  if (!data?.password_enc)
    return null
  await logCredentialAccess(client, { actor: audit.actor, deviceId: audit.deviceId, credSetId: setId, action: 'resolve' })
  return {
    username: (data.username as string | null) ?? null,
    password: decryptStored(data.password_enc as string, keyHex),
    port: (data.port as number | null) ?? null,
  }
}

// Resolve the port for an action — the same 4-level binding as creds, but no
// decrypt and no audit (the probe takes only the port, does not
// touch the secret and does not spam credential_access_log). null → no binding
// (the caller falls back to the action's default port).
export async function resolvePort(
  client: SupabaseClient,
  deviceId: string,
  action: GuacAction,
): Promise<number | null> {
  const chosen = await resolveChosenBinding(client, deviceId, action)
  return chosen?.credential_sets?.port ?? null
}

// Secret access audit. action: 'resolve' (mint) | 'copy' (endpoint).
export async function logCredentialAccess(
  client: SupabaseClient,
  // deviceId nullable: a task is not bound to a device,
  // yet the set access audit is needed all the same. The column is nullable since 0003.
  entry: { actor: string, deviceId: string | null, credSetId: string, action: 'resolve' | 'copy' },
): Promise<void> {
  const { error } = await client.from('credential_access_log').insert({
    actor: entry.actor,
    device_id: entry.deviceId,
    cred_set_id: entry.credSetId,
    action: entry.action,
  })
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
}
