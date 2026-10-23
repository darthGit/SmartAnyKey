// RED: scanner repo. assertTarget/buildServiceArgs are pure functions
// (injection guard + argv without a shell); parseNmapXml runs against real nmap
// fixtures (tests/fixtures/nmap/*.xml — real output, not synthetic).
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertTarget, buildServiceArgs, buildSweepArgs, CURATED_PORTS, livenessPorts, parseNmapXml, progressReader, runNmap } from '../../server/repositories/scanner'

const fx = (n: string) => readFileSync(fileURLToPath(new URL(`../fixtures/nmap/${n}`, import.meta.url)), 'utf8')

describe('assertTarget (injection guard)', () => {
  it('accepts IPv4 and IPv4/CIDR', () => {
    expect(() => assertTarget('10.0.6.0/24')).not.toThrow()
    expect(() => assertTarget('192.168.1.10')).not.toThrow()
  })

  it('rejects non-CIDR/non-IP and shell injection', () => {
    for (const bad of ['10.0.6.0/24; rm -rf /', '$(whoami)', 'localhost', '10.0.6.0 --script vuln', '10.0.999.0/24', '10.0.6.0/33', ''])
      expect(() => assertTarget(bad), bad).toThrow()
  })
})

describe('buildServiceArgs (argv without shell, -O only when privileged)', () => {
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

// Unprivileged nmap -sn pings only TCP 80/443, so a host with ICMP and 80/443 filtered
// looked down and was never scanned (public issue: Windows box with 135/445/3306/5900 open).
describe('sweep: liveness by TCP connect to the curated ports', () => {
  const list = (spec: string) => spec.split(',')

  it('curated ports cover the reported host (135, 445, 3306, 5800, 5900) and stay unique', () => {
    expect(list(CURATED_PORTS)).toEqual(expect.arrayContaining(['135', '445', '3306', '5800', '5900', '80', '443']))
    expect(new Set(list(CURATED_PORTS)).size).toBe(list(CURATED_PORTS).length)
  })

  it('probes with -PS on the given ports, one retry, target as its own argv element', () => {
    const args = buildSweepArgs('10.0.6.0/24', '445,3306')
    expect(args).toContain('-sn')
    expect(args).toContain('-PS445,3306')
    // --max-retries 0 drops probes ("retransmission cap hit (0)") — measured: host missed
    expect(args.slice(args.indexOf('--max-retries'), args.indexOf('--max-retries') + 2)).toEqual(['--max-retries', '1'])
    expect(args.at(-1)).toBe('10.0.6.0/24')
    expect(() => buildSweepArgs('10.0.6.0/24; reboot', '445')).toThrow()
  })

  it('phase 2 skips its own host discovery (-Pn): the sweep already proved the host live', () => {
    // without -Pn nmap re-pings 80/443 and drops the same filtered host again (measured)
    expect(buildServiceArgs(['10.0.6.1'])).toContain('-Pn')
  })

  it('liveness ports = curated, plus a short custom list; a range never widens the sweep', () => {
    expect(livenessPorts(CURATED_PORTS)).toBe(CURATED_PORTS)
    expect(list(livenessPorts('7000,3306'))).toEqual([...list(CURATED_PORTS), '7000'])
    expect(livenessPorts('1-65535')).toBe(CURATED_PORTS)
    expect(livenessPorts('22,8000-8100')).toBe(CURATED_PORTS)
  })
})

describe('parseNmapXml (service/banner/cert, unprivileged)', () => {
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
describe('NSE hostname harvest', () => {
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

// Scan progress: nmap --stats-every writes <taskprogress> into the same
// XML stream; runNmap streams stdout so the run can report it while nmap is still working.
describe('scan progress', () => {
  it('reads task + percent from real nmap output, also across a chunk split mid-element', () => {
    const xml = fx('sweep-progress.xml')
    const seen: Array<{ task: string, percent: number }> = []
    const feed = progressReader(p => seen.push(p))
    const cut = xml.indexOf('percent="32.56"') // split inside the second <taskprogress>
    feed(xml.slice(0, cut))
    feed(xml.slice(cut))
    expect(seen[0]).toEqual({ task: 'Ping Scan', percent: 7.24 })
    expect(seen).toContainEqual({ task: 'Ping Scan', percent: 32.56 })
    expect(seen).toHaveLength(8)
    const svc: Array<{ task: string, percent: number }> = []
    progressReader(p => svc.push(p))(fx('service-progress.xml'))
    expect(svc).toContainEqual({ task: 'Service scan', percent: 33.33 })
  })

  it('progress elements do not change the parsed hosts', () => {
    const hosts = parseNmapXml(fx('service-progress.xml'))
    expect(hosts.map(h => h.ip)).toEqual(['10.42.142.1', '10.42.142.41', '10.42.142.51'])
    expect(hosts.find(h => h.ip === '10.42.142.41')?.ports.map(p => p.port)).toEqual([80, 9100])
  })

  it('both nmap invocations ask for progress', () => {
    expect(buildSweepArgs('10.0.6.0/24', '22')).toEqual(expect.arrayContaining(['--stats-every', '2s']))
    expect(buildServiceArgs(['10.0.6.1'])).toEqual(expect.arrayContaining(['--stats-every', '2s']))
  })

  describe('runNmap against a stub nmap in PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sak-nmap-'))
    const stub = (body: string) => {
      writeFileSync(join(dir, 'nmap'), `#!/bin/sh\n${body}\n`)
      chmodSync(join(dir, 'nmap'), 0o755)
    }
    const PATH = process.env.PATH
    beforeEach(() => { process.env.PATH = `${dir}:${PATH}` })
    afterEach(() => { process.env.PATH = PATH })

    it('streams progress and resolves with the full output', async () => {
      stub(`cat '${fileURLToPath(new URL('../fixtures/nmap/sweep-progress.xml', import.meta.url))}'`)
      const seen: number[] = []
      const out = await runNmap([], 5000, p => seen.push(p.percent))
      expect(out).toBe(fx('sweep-progress.xml'))
      expect(seen).toHaveLength(8)
    })

    it('kills nmap past the timeout and rejects', async () => {
      stub(`echo $$ > '${dir}/pid'; sleep 30`)
      await expect(runNmap([], 300)).rejects.toThrow(/timed out/)
      const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
      await new Promise(r => setTimeout(r, 100))
      expect(() => process.kill(pid, 0)).toThrow()
    })

    it('an abort kills nmap at once and rejects as stopped', async () => {
      stub(`echo $$ > '${dir}/pid'; sleep 30`)
      const stop = new AbortController()
      const run = runNmap([], 30_000, undefined, stop.signal)
      await new Promise(r => setTimeout(r, 200))
      stop.abort()
      await expect(run).rejects.toThrow(/stopped/)
      const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
      await new Promise(r => setTimeout(r, 100))
      expect(() => process.kill(pid, 0)).toThrow()
    })

    it('an already aborted signal never starts nmap', async () => {
      stub(`echo started > '${dir}/started'; sleep 30`)
      const stop = new AbortController()
      stop.abort()
      await expect(runNmap([], 30_000, undefined, stop.signal)).rejects.toThrow(/stopped/)
      expect(() => readFileSync(join(dir, 'started'))).toThrow()
    })

    it('a non-zero exit rejects with nmap\'s stderr', async () => {
      stub('echo "Failed to resolve target" >&2; exit 1')
      await expect(runNmap([], 5000)).rejects.toThrow(/Failed to resolve target/)
    })
  })
})
