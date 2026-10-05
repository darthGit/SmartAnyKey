// Domain service: resolves a device's SFTP target
// (host+cred for the ssh action) and maps ssh2/repo errors to HTTP statuses.
// Mirrors ssh-bridge (ADR-007): no direct HTTP/DB — orchestrates repo/services.
// ssh2 lives only in repositories/ssh (3-tier).
import type { SupabaseClient } from '@supabase/supabase-js'
import { getDeviceForConnection } from '../repositories/devices'
import { SftpBinary, SftpTooLarge } from '../repositories/ssh'
import type { SshConnOpts } from '../repositories/ssh'
import { resolveCredentials } from './credentials'
import { resolveSshConnection } from './ssh-bridge'

export class SftpNoDevice extends Error {}
export class SftpNoAction extends Error {}

export async function resolveSftpTarget(
  client: SupabaseClient,
  deviceId: string,
  keyHex: string,
  actor: string,
): Promise<SshConnOpts> {
  const device = await getDeviceForConnection(client, deviceId)
  if (!device)
    throw new SftpNoDevice('Device not found')
  try {
    resolveSshConnection(device) // throws if 'ssh' is not in actions
  }
  catch {
    throw new SftpNoAction('SSH not available for this device')
  }
  const cred = await resolveCredentials(client, deviceId, 'ssh', keyHex, { actor })
  return {
    host: device.host,
    port: cred?.port ?? 22,
    username: cred?.username ?? '',
    password: cred?.password ?? '',
  }
}

// Error (typed/ssh2/repo) → HTTP. Passes already-H3 errors through
// (requireRole), so 401/403 are not swallowed into 502. ssh2 SFTP codes: 2=no-file, 3=perm.
export function sftpHttpError(err: unknown): { statusCode: number, statusMessage: string } {
  const e = err as {
    statusCode?: number
    statusMessage?: string
    level?: string
    code?: string | number
    message?: string
  }
  if (typeof e?.statusCode === 'number')
    return { statusCode: e.statusCode, statusMessage: e.statusMessage ?? 'error' }
  if (err instanceof SftpNoDevice)
    return { statusCode: 404, statusMessage: 'device-not-found' }
  if (err instanceof SftpNoAction)
    return { statusCode: 409, statusMessage: 'no-ssh-action' }
  if (err instanceof SftpTooLarge)
    return { statusCode: 413, statusMessage: 'file-too-large' }
  if (err instanceof SftpBinary)
    return { statusCode: 415, statusMessage: 'binary-file' }
  if (e?.level === 'client-authentication')
    return { statusCode: 502, statusMessage: 'ssh-auth' }
  const msg = e?.message ?? ''
  if (e?.code === 2 || /no such file/i.test(msg))
    return { statusCode: 404, statusMessage: 'not-found' }
  if (e?.code === 3 || /permission denied/i.test(msg))
    return { statusCode: 403, statusMessage: 'permission-denied' }
  if (typeof e?.code === 'string' && /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND/.test(e.code))
    return { statusCode: 502, statusMessage: 'host-unreachable' }
  return { statusCode: 502, statusMessage: 'sftp-error' }
}
