// The customer's compose holds what the product uses and nothing else: every extra
// service is a pulled image, RAM, and attack surface (the pooler published Postgres
// on the host; Studio was a full DB admin behind one basic-auth). Developer tools
// live in the dev overlay. These tests pin the composition so a vendored update
// cannot quietly bring a service back.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const compose = readFileSync('docker/docker-compose.yml', 'utf8')
const overlay = readFileSync('docker/docker-compose.dev.yml', 'utf8')
const demo = readFileSync('docker/docker-compose.demo.yml', 'utf8')
const kong = readFileSync('docker/config/api/kong.yml', 'utf8')
const envExample = readFileSync('docker/.env.example', 'utf8')

const CLIENT_SERVICES = ['app', 'auth', 'db', 'executor', 'guacd', 'kong', 'realtime', 'rest', 'storage']
// What the browser reaches through Kong: login, data, live task log, task artifacts.
const BROWSER_SERVICES = ['auth', 'realtime', 'rest', 'storage']

/** Top-level services of a compose file, mapped to their body. */
function services(yml: string): Map<string, string> {
  const top = yml.match(/^services:\n([\s\S]*?)(?=^\S)/m)?.[1] ?? ''
  const out = new Map<string, string>()
  for (const m of top.matchAll(/^ {2}([a-z][\w-]*):\n([\s\S]*?)(?=^ {2}[a-z][\w-]*:\n|(?![\s\S]))/gm))
    out.set(m[1], m[2])
  return out
}

describe('client compose composition', () => {
  it('client_compose_has_only_used_services', () => {
    expect([...services(compose).keys()].sort()).toEqual(CLIENT_SERVICES)
  })

  it('dev_overlay_brings_studio_and_meta', () => {
    const dev = services(overlay)
    expect(dev.has('studio') && dev.has('meta'), 'Studio and its meta API belong to the dev overlay').toBe(true)
  })

  it('kong_routes_and_services_match_both_ways', () => {
    const svc = services(compose)
    const hosts = new Set(kong.split('\n').filter(l => !l.trimStart().startsWith('#'))
      .flatMap(l => [...l.matchAll(/url:\s*https?:\/\/([^:/\s]+)/g)].map(m => m[1])))
    // A host is a service name or a network alias declared inside a service.
    const routed = [...hosts].map(h => svc.has(h)
      ? h
      : [...svc].find(([, body]) => new RegExp(`^ +- ${h.replace(/\./g, '\\.')}\\s*$`, 'm').test(body))?.[0] ?? `unresolved:${h}`)
    expect([...new Set(routed)].sort()).toEqual(BROWSER_SERVICES)
  })

  it('every_env_example_var_has_a_consumer', () => {
    // Read by a compose service, or it is a promise the install does not keep:
    // a value set in docker/.env that reaches no container changes nothing.
    const vars = [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(m => m[1])
    const unread = vars.filter(v => !new RegExp(`\\$\\{${v}[:}-]`).test(`${compose}\n${overlay}`))
    expect(unread).toEqual([])
  })

  it('self_signup_is_off_whatever_the_env_says', () => {
    expect(services(compose).get('auth')).toMatch(/^ +GOTRUE_DISABLE_SIGNUP: "true"$/m)
  })

  it('config_dir_holds_only_mounted_files_and_data_is_in_named_volumes', () => {
    // Customer data bind-mounted into docker/ is lost with the directory; named volumes are not.
    const svc = services(compose)
    const target = (name: string, path: string) =>
      (svc.get(name) ?? '').match(new RegExp(`- ([^\\s:]+):${path}[:\\s]`))?.[1]
    expect(target('db', '/var/lib/postgresql/data'), 'PGDATA').toMatch(/^[a-z][\w-]*$/)
    expect(target('storage', '/var/lib/storage'), 'Storage files').toMatch(/^[a-z][\w-]*$/)

    const mounts = [...`${compose}\n${overlay}\n${demo}`.matchAll(/^\s+- \.\/config\/([^:\s]+):/gm)].map(m => m[1])
    const tracked = execFileSync('git', ['ls-files', 'docker/config'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map(f => f.slice('docker/config/'.length))
    expect(tracked.length, 'docker/config holds the mounted configs').toBeGreaterThan(0)
    expect(tracked.filter(f => !mounts.some(m => f === m || f.startsWith(`${m}/`)))).toEqual([])
  })
})
