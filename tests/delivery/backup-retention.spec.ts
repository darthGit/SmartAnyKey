// Retention default. The production-readiness item asked for ≥30 days, but the
// default was 7 — with a nightly cron that is a week, not a month. Three places
// must match, otherwise `printenv` in the container says one thing and the script
// does another.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const EXPECTED = 30

describe('backup retention default (AC-8)', () => {
  it('script_default_is_at_least_thirty', () => {
    const m = readFileSync('scripts/backup.mjs', 'utf8').match(/BACKUP_KEEP\s*\|\|\s*(\d+)/)
    expect(m, 'scripts/backup.mjs has no BACKUP_KEEP default').not.toBeNull()
    expect(Number(m![1])).toBe(EXPECTED)
  })

  it('compose_default_matches_the_script', () => {
    const m = readFileSync('docker/docker-compose.yml', 'utf8').match(/BACKUP_KEEP:\s*\$\{BACKUP_KEEP:-(\d+)\}/)
    expect(m, 'docker-compose.yml has no BACKUP_KEEP default').not.toBeNull()
    expect(Number(m![1])).toBe(EXPECTED)
  })

  it('env_template_matches_the_script', () => {
    const line = readFileSync('docker/.env.example', 'utf8')
      .split('\n').find(l => l.startsWith('BACKUP_KEEP='))
    expect(line, 'docker/.env.example has no BACKUP_KEEP').toBeDefined()
    expect(Number(line!.split('=')[1])).toBe(EXPECTED)
  })
})
