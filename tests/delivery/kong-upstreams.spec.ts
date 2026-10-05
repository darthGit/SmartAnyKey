// Kong reaches every service by hostname. The vendored compose dropped upstream's
// container_name lines (fixed names collide across projects), so a hostname Kong
// uses must exist as a compose service name or a network alias — otherwise the
// route answers 503. Realtime is the case that bit: it also parses its tenant id
// from the first label of that hostname, so the upstream name has to stay.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const kong = readFileSync('docker/config/api/kong.yml', 'utf8')
const compose = readFileSync('docker/docker-compose.yml', 'utf8')

const upstreamHosts = () => [...new Set(
  kong.split('\n').filter(l => !l.trimStart().startsWith('#'))
    .flatMap(l => [...l.matchAll(/url:\s*https?:\/\/([^:/\s]+)/g)].map(m => m[1])),
)]

const resolvableNames = () => {
  const services = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map(m => m[1])
  const aliases = [...compose.matchAll(/^ {10}- ([a-z0-9.-]+)\s*$/gm)].map(m => m[1])
  return new Set([...services, ...aliases])
}

describe('kong upstreams', () => {
  it('every active upstream host is a compose service or a network alias', () => {
    const names = resolvableNames()
    expect(upstreamHosts().filter(h => !names.has(h))).toEqual([])
  })
})
