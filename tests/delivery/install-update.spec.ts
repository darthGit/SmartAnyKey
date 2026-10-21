// `install.sh --update`: an upgrade must not redo the install. Runs the real script with a
// fake `docker` on PATH that logs every call, so the test sees what the upgrade executes.
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function run(args: string[], withEnv: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'sak-upd-'))
  cpSync('docker/install.sh', join(dir, 'docker/install.sh'))
  if (withEnv)
    writeFileSync(join(dir, 'docker/.env'), 'SAK_PUBLIC_SUPABASE_URL=http://192.0.2.10:8000\nSAK_TAG=latest\n')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const log = join(dir, 'docker.log')
  // printenv answers the version query; everything else just succeeds
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$*" >> ${log}\ncase "$*" in *printenv*) echo v9.9.9 ;; esac\nexit 0\n`)
  chmodSync(join(bin, 'docker'), 0o755)
  const res = spawnSync('sh', [join(dir, 'docker/install.sh'), ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : ''
  rmSync(dir, { recursive: true, force: true })
  return { ...res, calls }
}

describe('install.sh --update', () => {
  it('pulls and restarts, but generates no secrets and creates no admin', () => {
    const r = run(['--update'], true)
    expect(r.status, r.stderr).toBe(0)
    expect(r.calls).toMatch(/compose[^\n]* pull/)
    expect(r.calls).toMatch(/compose[^\n]* up -d --remove-orphans --wait/)
    expect(r.calls).not.toMatch(/bootstrap\.mjs/)
    expect(r.calls).not.toMatch(/seed-admin|seed-showcase|public-address/)
    expect(r.stdout).toMatch(/v9\.9\.9/)
  })

  it('refuses when there is no installation to update', () => {
    const r = run(['--update'], false)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/without --update/)
    expect(r.calls).toBe('')
  })

  it('rejects an unknown flag instead of installing', () => {
    const r = run(['--upgrade'], true)
    expect(r.status).not.toBe(0)
    expect(r.calls).toBe('')
  })
})
