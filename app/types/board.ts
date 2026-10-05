export interface Point {
  id: string
  number: number
  address: string
  subnet: string
  note: string | null // operator note; searchable
  scan_cadence_minutes: number | null // drift: null = no schedule
  next_scan_at: string | null
}

// A point contact: one row = one contact — phone, email or anything else.
// There is no "person with channels" entity.
// `kind` is free: the code knows the render scheme (tel:/mailto:)
// (utils/contact-link), and the list of kinds is client data (no domain defaults).
// `value_norm` is a generated column (0017): phone → digits only, other →
// lower+trim. Used by the board search and the lookup route.
export interface PointContact {
  id: string
  point_id: string
  kind: string
  value: string
  value_norm: string
  label: string | null
  sort: number
}

// Runbook: a procedure per device type (+ optional point override).
export interface Runbook {
  id: string
  type_id: string | null
  point_id: string | null
  title: string
  body: string
  sort: number
}

export interface DeviceType {
  id: string
  slug: string
  name: string
  icon: string
  color: string
  default_action: string
  sort: number
}

export interface Device {
  id: string
  point_id: string
  type_id: string
  label: string
  host: string
  actions: string[]
  default_action: string | null
  sort: number
  // The machine's observed name — for the tree tooltip; source/time are NOT
  // pulled into the board (2k+ devices, the value is enough for a tooltip).
  hostname: string | null
}

// Auto-discovery (ADR-012)
export type ReconcileStatus = 'new' | 'matched' | 'changed' | 'rogue'

export interface DiscoveredHost {
  id: string
  ip: string
  hostname: string | null        // reverse-DNS
  nse_hostname: string | null    // the name the machine reported itself
  open_ports: { port: number, proto: string, service?: string, banner?: string }[] | null
  ssh_hostkey: string | null
  tls_cert_sha256: string | null
  tls_cert_cn: string | null
  os_guess: string | null
  confidence: number | null
  matched_signal: string | null
  reconcile_status: ReconcileStatus
  matched_device_id: string | null
  proposed_type_id: string | null
  device_types: { slug: string, name: string } | null
  observed_at: string
}

export interface DiscoveryDiff {
  hosts: DiscoveredHost[]
  missing: { id: string, label: string, host: string }[]
}

export interface DeviceTypeSignature {
  id: string
  type_id: string
  signal_type: 'ip_range' | 'port' | 'banner' | 'cert' | 'os'
  pattern: string
  capture_target: 'hostname' | 'point_number' | null
  weight: number
}

// Phase 2: a form parameter + a task credential ref.
export interface CommandParam { key: string, label: string, type?: string }
export interface CredRef { set_id: string, env: string }

export interface DeviceCommand {
  id: string
  type_id: string
  name: string
  body: string
  interpreter: 'raw' | 'bash' | 'python' | 'node'
  confirm: boolean
  timeout_s: number
  sort: number
  purpose: 'action' | 'probe'
  stable: boolean
  // Phase 2: execution target, form parameters (pre-exec form), task credentials, min role.
  target: 'ssh' | 'local'
  params: CommandParam[]
  cred_refs: CredRef[]
  min_role: 'operator' | 'admin'
}
