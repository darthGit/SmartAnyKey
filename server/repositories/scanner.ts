// Repository: nmap wrapper. The ONLY place that knows about nmap (a seam for
// a future agent/WinRM — services see domain Observations). nmap is mature;
// our value is the integration, not a home-grown scanner.
//
// Security: execFile with an argv array (no shell) + target validation (CIDR/IP).
// The target never enters a command string — only as a separate argv element, and
// only after assertTarget. Two phases: a fast liveness sweep → service/NSE on
// live hosts. Unprivileged (-sT -sV +NSE); -O only when CAP_NET_RAW is granted.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Curated port set (generic, not domain-specific — typical admin/device ports).
// A full -p- is a separate on-demand deep-profile action (performance).
export const CURATED_PORTS = '21,22,23,53,80,139,161,443,445,3389,5900,5901,8080,8443,9100'

const IPV4 = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}`
const CIDR_RE = new RegExp(`^${IPV4}(?:/(?:3[0-2]|[12]?\\d))?$`)

// Accept ONLY IPv4 or IPv4/CIDR. Anything else (hostname, spaces,
// ;| , shell metacharacters, flags like --script) → rejected before execFile.
export function assertTarget(target: string): void {
  if (!CIDR_RE.test(target))
    throw new Error(`Invalid scan target: ${target}`)
}

export interface PortObs {
  port: number
  proto: string
  service?: string
  product?: string
  version?: string
  banner?: string
}

export interface Observation {
  ip: string
  hostname?: string        // reverse DNS (what DNS thinks) — source of the `ptr` rank
  nseHostname?: string     // what the machine calls itself (NSE, no creds) — rank `nse`
  ports: PortObs[]
  sshHostkey?: string      // ssh-hostkey NSE fingerprint — a stable identifier
  tlsCertSha256?: string   // ssl-cert NSE — a stable identifier
  tlsCertCn?: string       // CN/SAN for cert rules
  osGuess?: string         // privileged only (-O)
}

const ENT: Record<string, string> = { quot: '"', apos: '\'', amp: '&', lt: '<', gt: '>' }
function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(quot|apos|amp|lt|gt);/g, (_, n) => ENT[n])
}
const attr = (tag: string, name: string): string | undefined =>
  tag.match(new RegExp(`${name}="([^"]*)"`))?.[1]

// NSE script element. Empty value = "the script learned nothing" → undefined.
// A trailing `\x00` is how nmap returns NetBIOS strings (`SAK-FIXTURE\x00`, live
// output in tests/fixtures/nmap/service-nse-hostname.xml), so we strip it.
const elem = (block: string, key: string): string | undefined => {
  const raw = block.match(new RegExp(`<elem key="${key}">([^<]*)</elem>`))?.[1]
  const v = raw && decode(raw).replace(/\\x00$/, '').trim()
  return v || undefined
}

// Parse nmap -oX (fixtures are real nmap output, not synthetic).
export function parseNmapXml(xml: string): Observation[] {
  const out: Observation[] = []
  for (const m of xml.matchAll(/<host\b[\s\S]*?<\/host>/g)) {
    const block = m[0]
    if (!/<status[^>]*state="up"/.test(block))
      continue
    const ip = attr(block.match(/<address[^>]*addrtype="ipv4"[^>]*>/)?.[0] ?? '', 'addr')
    if (!ip)
      continue
    const obs: Observation = { ip, ports: [] }
    const hn = block.match(/<hostname[^>]*name="([^"]*)"/)
    if (hn) obs.hostname = hn[1]

    for (const pm of block.matchAll(/<port\b[^>]*portid="(\d+)"[^>]*protocol="(\w+)"[\s\S]*?<\/port>|<port\b[^>]*protocol="(\w+)"[^>]*portid="(\d+)"[\s\S]*?<\/port>/g)) {
      const pblock = pm[0]
      if (!/<state[^>]*state="open"/.test(pblock))
        continue
      const port = Number(pm[1] ?? pm[4])
      const proto = pm[2] ?? pm[3]
      const svc = pblock.match(/<service\b[^>]*>/)?.[0] ?? ''
      const product = attr(svc, 'product')
      const version = attr(svc, 'version')
      const extra = attr(svc, 'extrainfo')
      const banner = [product, version, extra].filter(Boolean).map(decode).join(' ') || undefined
      obs.ports.push({ port, proto, service: attr(svc, 'name'), product: product && decode(product), version, banner })

      // ssl-cert NSE → sha256 + commonName (the first = subject CN)
      const cert = pblock.match(/<script id="ssl-cert"[\s\S]*?<\/script>/)?.[0]
      if (cert && !obs.tlsCertSha256) {
        obs.tlsCertSha256 = cert.match(/<elem key="sha256">([0-9a-fA-F]+)<\/elem>/)?.[1]
        obs.tlsCertCn = cert.match(/<elem key="commonName">([^<]*)<\/elem>/)?.[1]
      }
      // ssh-hostkey NSE → fingerprint (structure: <elem key="fingerprint">…)
      const hk = pblock.match(/<script id="ssh-hostkey"[\s\S]*?<\/script>/)?.[0]
      if (hk && !obs.sshHostkey)
        obs.sshHostkey = hk.match(/<elem key="fingerprint">([0-9a-f:]+)<\/elem>/)?.[1]

      // rdp-ntlm-info (port script, 3389) → the machine gives its name in the NTLM blob.
      // Keys come from upstream `/usr/share/nmap/scripts/rdp-ntlm-info.nse` (@xmloutput),
      // not from memory; there is no NLA target in dev, so there is no live fixture for
      // this script either (smb-os-discovery below is covered by a live run).
      const ntlm = pblock.match(/<script id="rdp-ntlm-info"[\s\S]*?<\/script>/)?.[0]
      if (ntlm && !obs.nseHostname)
        obs.nseHostname = elem(ntlm, 'NetBIOS_Computer_Name') ?? elem(ntlm, 'DNS_Computer_Name')
    }

    // smb-os-discovery is a HOST script (`<hostscript>`), not a port script: nmap puts
    // it outside `<port>`. Keys checked against live output: os/lanmanager/server/
    // date/fqdn/domain_dns/workgroup.
    const smb = block.match(/<script id="smb-os-discovery"[\s\S]*?<\/script>/)?.[0]
    if (smb && !obs.nseHostname)
      obs.nseHostname = elem(smb, 'fqdn') ?? elem(smb, 'server')

    const osm = block.match(/<osmatch[^>]*name="([^"]*)"/)
    if (osm) obs.osGuess = decode(osm[1])
    out.push(obs)
  }
  return out
}

async function runNmap(args: string[], timeoutMs: number): Promise<string> {
  // execFile: arguments are an array, NOT a string → no shell is involved.
  const { stdout } = await execFileAsync('nmap', args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

// Phase 1: liveness sweep of a /24 (no ports). Returns live IPs.
export async function sweep(subnet: string, timeoutMs = 60_000): Promise<string[]> {
  assertTarget(subnet)
  const xml = await runNmap(['-sn', '-T3', '-oX', '-', subnet], timeoutMs)
  return parseNmapXml(xml).map(o => o.ip)
}

export interface ServiceScanOpts {
  privileged?: boolean   // CAP_NET_RAW → add -O (OS guess). Default: unprivileged
  ports?: string
  timeoutMs?: number
}

// argv builder extracted for a unit test (no shell, target as a separate element).
export function buildServiceArgs(ips: string[], opts: ServiceScanOpts = {}): string[] {
  ips.forEach(assertTarget)
  // NSE: ssh-hostkey/ssl-cert = stable identity; rdp-ntlm-info/smb-os-discovery =
  // the machine gives its own name without creds. On hosts without
  // 3389/445 both are no-ops.
  const args = ['-sT', '-sV', '-T3', '-p', opts.ports ?? CURATED_PORTS, '--script', 'ssh-hostkey,ssl-cert,rdp-ntlm-info,smb-os-discovery']
  if (opts.privileged)
    args.push('-O')
  args.push('-oX', '-', ...ips)
  return args
}

// Phase 2: service/banner/NSE on live hosts.
export async function serviceScan(ips: string[], opts: ServiceScanOpts = {}): Promise<Observation[]> {
  if (ips.length === 0)
    return []
  const xml = await runNmap(buildServiceArgs(ips, opts), opts.timeoutMs ?? 300_000)
  return parseNmapXml(xml)
}

// Top level: sweep → service scan of live hosts. Services see only Observation[].
export async function scanSubnet(subnet: string, opts: ServiceScanOpts = {}): Promise<Observation[]> {
  const live = await sweep(subnet)
  return serviceScan(live, opts)
}
