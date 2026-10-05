// Moving migrations into app start created a dependency the manual flow did not
// have: `0015_tasks.sql` provisions a bucket in the `storage` schema, and that
// schema is created by the storage-api service on its own start. While the client
// ran `db-migrate` by hand — after everything was already up — there was no race.
//
// Measured in a clean room 2026-09-18: without `storage: service_healthy` the first
// install fails with `relation "storage.buckets" does not exist`.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Body of the `app` service up to the next service of the same level. */
function appService(): string {
  const yml = readFileSync('docker/docker-compose.yml', 'utf8')
  const m = yml.match(/^ {2}app:$([\s\S]*?)(?=^ {2}[a-z][\w-]*:$)/m)
  if (!m)
    throw new Error('docker-compose.yml has no app service')
  return m[1]
}

describe('app depends_on (AC-4)', () => {
  it('waits_for_storage_to_be_healthy_before_migrating', () => {
    const body = appService()
    const deps = body.match(/depends_on:([\s\S]*?)(?=\n {4}[a-z])/)?.[1] ?? ''
    expect(deps, 'storage missing from depends_on — migration 0015 will fail on storage.buckets')
      .toMatch(/storage:\s*\n\s*condition:\s*service_healthy/)
  })

  it('still_waits_for_kong', () => {
    const deps = appService().match(/depends_on:([\s\S]*?)(?=\n {4}[a-z])/)?.[1] ?? ''
    expect(deps).toMatch(/kong:\s*\n(\s*#[^\n]*\n)*\s*condition:\s*service_healthy/)
  })
})
