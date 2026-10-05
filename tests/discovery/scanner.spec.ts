// RED: scanner repo. assertTarget/buildServiceArgs are pure functions
// (injection guard + argv without a shell); parseNmapXml runs against real nmap
// fixtures (tests/fixtures/nmap/*.xml — real output, not synthetic).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertTarget, buildServiceArgs, CURATED_PORTS, parseNmapXml } from '../../server/repositories/scanner'

const fx = (n: string) => readFileSync(fileURLToPath(new URL(`../fixtures/nmap/${n}`, import.meta.url)), 'utf8')

describe('assertTarget (AC-6 injection-guard)', () => {
  it('accepts IPv4 and IPv4/CIDR', () => {
    expect(() => assertTarget('10.0.6.0/24')).not.toThrow()
    expect(() => assertTarget('192.168.1.10')).not.toThrow()
  })

  it('rejects non-CIDR/non-IP and shell injection', () => {
    for (const bad of ['10.0.6.0/24; rm -rf /', '$(whoami)', 'localhost', '10.0.6.0 --script vuln', '10.0.999.0/24', '10.0.6.0/33', ''])
      expect(() => assertTarget(bad), bad).toThrow()
  })
})

describe('buildServiceArgs (AC-6 argv without shell, AC-7 -O only when privileged)', () => {
  it('target as separate argv elements, curated port set, no shell metacharacters', () => {
    const args = buildServiceArgs(['10.0.6.1', '10.0.6.6'])
    expect(args).toContain('-sT')                 // unprivileged connect scan
    expect(args).toContain(CURATED_PORTS)
    expect(args.at(-1)).toBe('10.0.6.6')          // target is a separate element, not inside a string
    expect(args).not.toContain('-O')              // default: no OS fingerprint
    expect(args.join(' ')).not.toMatch(/[;&|`$]/) // no shell metacharacter
  })

  it('-O is added only when privileged', () => {
    expect(buildServiceArgs(['10.0.6.1'], { privileged: true })).toContain('-O')
  })

  it('invalid target in the list → throw (guard fires before nmap)', () => {
    expect(() => buildServiceArgs(['10.0.6.1', 'evil; reboot'])).toThrow()
  })
})

describe('parseNmapXml (AC-7 service/banner/cert unprivileged)', () => {
  it('sweep: live hosts → IP + hostname', () => {
    const obs = parseNmapXml(fx('sweep.xml'))
    expect(obs.map(o => o.ip).sort()).toEqual(['127.0.0.1', '127.0.0.2'])
    expect(obs.find(o => o.ip === '127.0.0.1')?.hostname).toBe('localhost')
  })

  it('service scan: open ports with banner + ssl-cert (CN + sha256), no OS when unprivileged', () => {
    const [h] = parseNmapXml(fx('service.xml'))
    const ssh = h.ports.find(p => p.port === 2222)
    expect(ssh?.service).toBe('ssh')
    expect(ssh?.banner).toContain('OpenSSH')
    expect(h.tlsCertCn).toBe('localhost')
    expect(h.tlsCertSha256).toBe('0249a13c96ae0324d253edbac56072afc46208cf2c5e06e290d8b1ff06e26c03')
    expect(h.osGuess).toBeUndefined()             // -sT without -O → no OS guess
  })

  it('counts only open ports (closed are dropped)', () => {
    const [h] = parseNmapXml(fx('service.xml'))
    expect(h.ports.every(p => p.port === 2222 || p.port === 8443)).toBe(true)
  })
})

// RED: the machine reports its own name via NSE without credentials. The fixture
// is real nmap output (element keys come from a live run, not from memory).
describe('NSE hostname harvest (AC-2)', () => {
  it('buildServiceArgs requests rdp-ntlm-info and smb-os-discovery', () => {
    const script = buildServiceArgs(['10.0.6.6'])[buildServiceArgs(['10.0.6.6']).indexOf('--script') + 1]
    expect(script.split(',')).toEqual(expect.arrayContaining(['ssh-hostkey', 'ssl-cert', 'rdp-ntlm-info', 'smb-os-discovery']))
  })

  it('the parser returns the machine name from NSE separately from reverse DNS', () => {
    const [h] = parseNmapXml(fx('service-nse-hostname.xml'))
    expect(h.nseHostname).toBe('471c747456e6')   // <elem key="fqdn"> of a live smb-os-discovery
    expect(h.nseHostname).not.toBe(h.hostname)   // NSE = what the machine says, hostname = what DNS says
  })

  it('NetBIOS tail `\\x00` is trimmed (as nmap returns the string)', () => {
    // same live output: <elem key="server">SAK-FIXTURE\x00</elem>
    expect(fx('service-nse-hostname.xml')).toContain('SAK-FIXTURE\\x00')
    const [h] = parseNmapXml(fx('service-nse-hostname.xml'))
    expect(h.nseHostname).not.toContain('\\x00')
  })

  // rdp-ntlm-info keys come from upstream `/usr/share/nmap/scripts/rdp-ntlm-info.nse`
  // (@xmloutput in the script header, nmap 7.99), NOT from memory. No live fixture for
  // this script: no NLA-capable RDP target exists in dev (xrdp does not return NTLM).
  it('rdp-ntlm-info: name from NetBIOS_Computer_Name (port script 3389)', () => {
    const xml = `<nmaprun><host><status state="up"/><address addr="10.0.6.60" addrtype="ipv4"/>
      <ports><port protocol="tcp" portid="3389"><state state="open"/><service name="ms-wbt-server"/>
      <script id="rdp-ntlm-info" output="x"><elem key="Target_Name">W2016</elem>
      <elem key="NetBIOS_Computer_Name">W16GA-SRV01</elem>
      <elem key="DNS_Computer_Name">W16GA-SRV01.W2016.lab</elem></script></port></ports></host></nmaprun>`
    expect(parseNmapXml(xml)[0]?.nseHostname).toBe('W16GA-SRV01')
  })
})
