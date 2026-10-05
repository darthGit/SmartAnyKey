// Repository: discovered_hosts + device_type_signatures + reading a point's devices
// with stable signals (for identity). The only layer with DB access.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { HostnameFact, KnownDevice, Signature } from '../services/discovery'

export interface PointRow { id: string, number: number, subnet: string }

export async function getPoint(client: SupabaseClient, pointId: string): Promise<PointRow | null> {
  const { data, error } = await client.from('points').select('id,number,subnet').eq('id', pointId).maybeSingle()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return (data as PointRow) ?? null
}

export async function getSignatures(client: SupabaseClient): Promise<Signature[]> {
  const { data, error } = await client
    .from('device_type_signatures')
    .select('id,type_id,signal_type,pattern,capture_target,weight')
    .order('id')
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return (data ?? []) as Signature[]
}

// A point's devices + stable signals from the previous matched scan (latest per device).
export async function getKnownDevices(client: SupabaseClient, pointId: string): Promise<KnownDevice[]> {
  const { data: devs, error } = await client
    .from('devices').select('id,host,label,type_id,hostname,hostname_source,hostname_at').eq('point_id', pointId)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })

  const { data: prior } = await client
    .from('discovered_hosts')
    .select('matched_device_id,hostname,ssh_hostkey,tls_cert_sha256,observed_at')
    .eq('point_id', pointId).not('matched_device_id', 'is', null)
    .order('observed_at', { ascending: false })
  const sig = new Map<string, { hostname?: string, ssh_hostkey?: string, tls_cert_sha256?: string }>()
  for (const r of prior ?? [])
    if (!sig.has(r.matched_device_id))   // first = the freshest (order desc)
      sig.set(r.matched_device_id, r)

  return (devs ?? []).map((d): KnownDevice => ({
    id: d.id, host: d.host, label: d.label, type_id: d.type_id,
    // hostname — from the device itself (a durable fact);
    // the last scan's signal stays the fallback while the column is empty.
    hostname: d.hostname ?? sig.get(d.id)?.hostname ?? null,
    hostnameSource: d.hostname ? d.hostname_source ?? null : (sig.get(d.id)?.hostname ? 'ptr' : null),
    hostnameAt: d.hostname ? d.hostname_at ?? null : null,
    sshHostkey: sig.get(d.id)?.ssh_hostkey ?? null,
    tlsCertSha256: sig.get(d.id)?.tls_cert_sha256 ?? null,
  }))
}

// Writer of the observed name. Touches exactly three columns — never `label`/`type_id`/
// `host` (ADR-012: the scan writes nothing to
// `devices` except this fact).
export async function updateDeviceHostname(client: SupabaseClient, deviceId: string, fact: HostnameFact): Promise<void> {
  const { error } = await client.from('devices')
    .update({ hostname: fact.value, hostname_source: fact.source, hostname_at: fact.at })
    .eq('id', deviceId)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
}

export interface HostRow {
  point_id: string
  scan_run_id: string
  ip: string
  hostname: string | null        // reverse-DNS
  nse_hostname: string | null    // what the machine said about itself (NSE)
  open_ports: unknown
  ssh_hostkey: string | null
  tls_cert_sha256: string | null
  tls_cert_cn: string | null
  os_guess: string | null
  proposed_type_id: string | null
  confidence: number | null
  matched_signal: string | null
  reconcile_status: 'new' | 'matched' | 'changed' | 'rogue'
  matched_device_id: string | null
}

// v1: we keep only the point's last scan (history — deferred). Replace the rows.
export async function replaceHosts(client: SupabaseClient, pointId: string, rows: HostRow[]): Promise<void> {
  const del = await client.from('discovered_hosts').delete().eq('point_id', pointId)
  if (del.error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${del.error.message}` })
  if (rows.length === 0)
    return
  const ins = await client.from('discovered_hosts').insert(rows)
  if (ins.error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${ins.error.message}` })
}

// --- device_type_signatures CRUD (admin, service_role) ---

export interface SignatureInput {
  type_id: string
  signal_type: Signature['signal_type']
  pattern: string
  capture_target: 'hostname' | 'point_number' | null
  weight: number
}

export async function createSignature(client: SupabaseClient, input: SignatureInput) {
  const { data, error } = await client.from('device_type_signatures').insert(input).select('id').single()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return data
}

export async function updateSignature(client: SupabaseClient, id: string, patch: Partial<SignatureInput>) {
  const { data, error } = await client
    .from('device_type_signatures').update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id).select('id').single()
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return data
}

export async function removeSignature(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('device_type_signatures').delete().eq('id', id)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
}

// All recent observations (for rule preview — "matches N hosts").
// ponytail: cap 500 — enough as a test corpus; a full back-test is not needed.
export async function getAllRecentHosts(client: SupabaseClient, limit = 500) {
  const { data, error } = await client
    .from('discovered_hosts')
    .select('ip,hostname,nse_hostname,open_ports,ssh_hostkey,tls_cert_sha256,tls_cert_cn,os_guess')
    .order('observed_at', { ascending: false }).limit(limit)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return data ?? []
}

// GET: a point's latest observations (with type/device labels for the UI).
export async function listHosts(client: SupabaseClient, pointId: string) {
  const { data, error } = await client
    .from('discovered_hosts')
    .select('id,ip,hostname,nse_hostname,open_ports,ssh_hostkey,tls_cert_sha256,tls_cert_cn,os_guess,confidence,matched_signal,reconcile_status,matched_device_id,proposed_type_id,device_types(slug,name),observed_at')
    .eq('point_id', pointId).order('ip')
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })
  return data ?? []
}
