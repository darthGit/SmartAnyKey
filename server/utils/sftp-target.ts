// Controller helper (auto-imported): auth ≥operator (ADR-013) + resolving the SFTP target
// from the event. Centralizes requireRole so none of the 9 SFTP endpoints forgets the gate.
import { z } from 'zod'
import type { H3Event } from 'h3'
import { serverSupabaseServiceRole } from '#supabase/server'
import { resolveSftpTarget } from '../services/sftp'
import type { SshConnOpts } from '../repositories/ssh'

export async function resolveSftpFromEvent(
  event: H3Event,
): Promise<{ target: SshConnOpts, actor: string, deviceId: string }> {
  const { user } = await requireRole(event, 'operator')
  const deviceId = z.string().uuid().parse(getRouterParam(event, 'deviceId'))
  const actor = user.email ?? user.id
  const sr = serverSupabaseServiceRole(event)
  const target = await resolveSftpTarget(sr, deviceId, useRuntimeConfig(event).credEncryptionKey, actor)
  return { target, actor, deviceId }
}
