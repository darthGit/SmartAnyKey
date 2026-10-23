// Repository: nmap wrapper. The ONLY place that knows about nmap (a seam for
// a future agent/WinRM — services see domain Observations). nmap is mature;
// our value is the integration, not a home-grown scanner.
//
// Security: spawn with an argv array (no shell) + target validation (CIDR/IP).
// The target never enters a command string — only as a separate argv element, and
// only after assertTarget. Two phases: a fast liveness sweep → service/NSE on
// live hosts. Unprivileged (-sT -sV +NSE); -O only when CAP_NET_RAW is granted.
import { spawn } from 'node:child_process'

// Curated port set (generic, not domain-specific — typical admin/device ports).
// It is also the liveness probe of the sweep, so it reaches past 80/443: Windows (135,
// 5985), databases, cameras (554), IoT/MQTT (1883), CUPS (631), common web/admin ports.
// A full -p- is a separate on-demand deep-profile action (performance).
export const CURATED_PORTS = '21,22,23,25,53,80,110,135,139,143,161,389,443,445,554,631,993,995,'
  + '1433,1521,1723,1883,2049,3306,3389,5000,5060,5432,5800,5900,5901,5985,6379,7547,8000,8008,'
  + '8080,8081,8443,8888,9000,9100,9443,10000,27017,49152'

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

export interface ScanProgress { task: string, percent: number }
export type OnProgress = (p: ScanProgress) => void

const PROGRESS_RE = /<taskprogress task="([^"]+)"[^>]*?percent="([\d.]+)"[^>]*\/>/g

// nmap --stats-every writes <taskprogress …/> into the XML stream; a chunk may end mid-element,
// so the unparsed tail is carried into the next chunk.
export function progressReader(onProgress: OnProgress): (chunk: string) => void {
  let tail = ''
  return (chunk) => {
    const text = tail + chunk
    let end = 0
    for (const m of text.matchAll(PROGRESS_RE)) {
      onProgress({ task: m[1]!, percent: Number(m[2]) })
      end = m.index + m[0].length
    }
    const open = text.lastIndexOf('<taskprogress')
    tail = open >= end ? text.slice(open) : ''
  }
}

const MAX_OUTPUT = 32 * 1024 * 1024

// spawn (not execFile) so progress arrives while nmap runs. Same contract as before: argv
// array, no shell; reject on timeout (nmap killed), non-zero exit (stderr in the message)
// or output past MAX_OUTPUT.
export function runNmap(args: string[], timeoutMs: number, onProgress?: OnProgress, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(new Error('stopped'))
    const child = spawn('nmap', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let size = 0
    let stderr = ''
    let failure: Error | null = null
    const feed = onProgress ? progressReader(onProgress) : null
    const stop = (e: Error) => {
      failure ??= e
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => stop(new Error(`nmap timed out after ${timeoutMs} ms`)), timeoutMs)
    // Stop takes the same path as the timeout: SIGKILL, settle at exit.
    signal?.addEventListener('abort', () => stop(new Error('stopped')), { once: true })
    child.stdout.on('data', (b: Buffer) => {
      size += b.length
      if (size > MAX_OUTPUT)
        return stop(new Error('nmap output exceeded 32 MB'))
      out.push(b)
      feed?.(b.toString('utf8'))
    })
    child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString('utf8')).slice(-4000) })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    // on a kill, settle at exit: a grandchild holding the pipes would delay 'close'
    child.on('exit', () => {
      if (!failure)
        return
      clearTimeout(timer)
      child.stdout.destroy()
      child.stderr.destroy()
      reject(failure)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failure)
        return
      if (code !== 0)
        return reject(new Error(`nmap exited with ${code}: ${stderr.trim()}`))
      resolve(Buffer.concat(out).toString('utf8'))
    })
  })
}

// Sweep probe = curated ports, plus a short explicit list the scan asked for (custom mode).
// A range (or a long list) never widens it: it would turn the sweep into a port scan.
export function livenessPorts(scanPorts: string): string {
  const own = scanPorts.split(',')
  if (scanPorts.includes('-') || own.length > 100)
    return CURATED_PORTS
  const curated = CURATED_PORTS.split(',')
  return [...curated, ...own.filter(p => !curated.includes(p))].join(',')
}

// Unprivileged -sn pings only TCP 80/443, so a host with ICMP and both filtered looked down
// and never reached phase 2. -PS connects to every probe port; the first answer marks it up.
// Timing measured on a /24 with 46 ports (2026-10-22): defaults ~60 s, this ~12 s, the
// filtered test host found 3/3. --max-retries 0 silently drops probes — keep 1.
// Kept simple: --max-rtt-timeout 300ms assumes a LAN/VPN round trip under that; raise it for
// slower links (a branch behind satellite) rather than dropping the probe list.
export function buildSweepArgs(subnet: string, probePorts: string): string[] {
  assertTarget(subnet)
  return ['-sn', '-T4', '--max-retries', '1', '--max-rtt-timeout', '300ms', '--min-hostgroup', '256',
    '--min-parallelism', '512', `-PS${probePorts}`, '--stats-every', '2s', '-oX', '-', subnet]
}

// Phase 1: liveness sweep of a /24. Returns live IPs.
export async function sweep(subnet: string, probePorts = CURATED_PORTS, timeoutMs = 60_000, onProgress?: OnProgress, signal?: AbortSignal): Promise<string[]> {
  const xml = await runNmap(buildSweepArgs(subnet, probePorts), timeoutMs, onProgress, signal)
  return parseNmapXml(xml).map(o => o.ip)
}

export interface ServiceScanOpts {
  privileged?: boolean   // CAP_NET_RAW → add -O (OS guess). Default: unprivileged
  ports?: string
  timeoutMs?: number
  onProgress?: OnProgress
  signal?: AbortSignal
}

// argv builder extracted for a unit test (no shell, target as a separate element).
export function buildServiceArgs(ips: string[], opts: ServiceScanOpts = {}): string[] {
  ips.forEach(assertTarget)
  // NSE: ssh-hostkey/ssl-cert = stable identity; rdp-ntlm-info/smb-os-discovery =
  // the machine gives its own name without creds. On hosts without
  // 3389/445 both are no-ops.
  // -Pn: the targets are the sweep's live hosts; nmap's own 80/443 ping would drop the
  // filtered ones the sweep just found.
  const args = ['-sT', '-sV', '-Pn', '-T3', '-p', opts.ports ?? CURATED_PORTS, '--script', 'ssh-hostkey,ssl-cert,rdp-ntlm-info,smb-os-discovery']
  if (opts.privileged)
    args.push('-O')
  args.push('--stats-every', '2s', '-oX', '-', ...ips)
  return args
}

// Phase 2: service/banner/NSE on live hosts.
export async function serviceScan(ips: string[], opts: ServiceScanOpts = {}): Promise<Observation[]> {
  if (ips.length === 0)
    return []
  const xml = await runNmap(buildServiceArgs(ips, opts), opts.timeoutMs ?? 300_000, opts.onProgress, opts.signal)
  return parseNmapXml(xml)
}

export type ScanStage = 'sweep' | 'services'

// Top level: sweep → service scan of live hosts. Services see only Observation[].
// onStage tags nmap's progress with which of the two invocations it belongs to.
export async function scanSubnet(subnet: string, opts: ServiceScanOpts = {}, onStage?: (stage: ScanStage, p: ScanProgress) => void): Promise<Observation[]> {
  onStage?.('sweep', { task: '', percent: 0 })
  const live = await sweep(subnet, livenessPorts(opts.ports ?? CURATED_PORTS), 60_000, onStage && (p => onStage('sweep', p)), opts.signal)
  onStage?.('services', { task: '', percent: 0 }) // the next nmap reports only after 2 s
  return serviceScan(live, { ...opts, onProgress: onStage && (p => onStage('services', p)) })
}
