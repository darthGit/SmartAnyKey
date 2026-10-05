// Domain service: action choice and connect parameter building. json-auth was removed
// (ADR-010) — vnc/rdp go via the ws bridge to guacd (guac-bridge), ssh — via
// the terminal ws; what remains here is resolveAction + connectionParameters.
import { CredentialDecryptError } from './credentials'

export type GuacAction = 'vnc' | 'rdp' | 'ssh' | 'web'

export interface ConnectableDevice {
  actions: string[]
  default_action: string | null
  type_default_action: string
}

export interface DeviceCredentials {
  username: string | null
  password: string | null
  port: number | null
}

export class ActionUnavailableError extends Error {}

// Session open failure → the code the ws sends to the pane. Anything not recognised is
// still shown as 'host', but logged: before, a credential that did not decrypt looked
// exactly like a dead host and left no trace.
export function sessionFailCode(err: unknown, route: string): 'action' | 'cred' | 'host' {
  if (err instanceof ActionUnavailableError)
    return 'action'
  console.error(`[${route}] session open failed:`, err instanceof Error ? err.message : err)
  return err instanceof CredentialDecryptError ? 'cred' : 'host'
}

export function resolveAction(device: ConnectableDevice, requested?: string): GuacAction {
  const action = requested ?? device.default_action ?? device.type_default_action
  if (!device.actions.includes(action))
    throw new ActionUnavailableError(`Action "${action}" is not available for this device`)
  return action as GuacAction
}

export function connectionParameters(
  action: Exclude<GuacAction, 'web'>,
  host: string,
  cred: DeviceCredentials | null,
): Record<string, string> {
  const defaultPorts = { ssh: 22, vnc: 5900, rdp: 3389 } as const
  const base = {
    'hostname': host,
    'port': String(cred?.port ?? defaultPorts[action]),
    'password': cred?.password ?? '',
  }
  switch (action) {
    case 'ssh': return { ...base, username: cred?.username ?? '' }
    case 'vnc': return base
    case 'rdp': return { ...base, 'username': cred?.username ?? '', 'ignore-cert': 'true' }
  }
}
