// Repository: a point's devices → probe targets
// (host + default action + port). Port = credential binding (resolvePort, no
// decrypt/audit) with a fallback to the action's standard port.
import { createError } from 'h3'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DeviceTarget } from '../services/health'
import type { GuacAction } from '../services/remote-session'
import { resolvePort } from '../services/credentials'

export const STANDARD_PORT: Record<GuacAction, number> = { ssh: 22, rdp: 3389, vnc: 5900, web: 80 }

export async function listPointTargets(client: SupabaseClient, pointId: string): Promise<DeviceTarget[]> {
  const { data, error } = await client
    .from('devices')
    .select('id,host,default_action,device_types(default_action)')
    .eq('point_id', pointId)
  if (error)
    throw createError({ statusCode: 502, statusMessage: `DB: ${error.message}` })

  const targets: DeviceTarget[] = []
  for (const d of data ?? []) {
    const action = ((d.default_action as string | null)
      ?? (d.device_types as { default_action: string }).default_action) as GuacAction
    const port = (await resolvePort(client, d.id as string, action)) ?? STANDARD_PORT[action] ?? STANDARD_PORT.ssh
    targets.push({ id: d.id as string, action, host: d.host as string, port })
  }
  return targets
}
