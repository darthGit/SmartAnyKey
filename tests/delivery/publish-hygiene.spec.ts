// The repository root carries no stray
// screenshots, and the env template declares each variable once — a duplicate
// key silently wins by position, and the public template must not invite that.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('publish hygiene', () => {
  it('tracks no PNG files in the repository root', () => {
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n')
    const rootPngs = tracked.filter(f => /^[^/]+\.png$/i.test(f))
    expect(rootPngs).toEqual([])
  })

  it('declares PBX_WEBHOOK_SECRET exactly once in .env.example', () => {
    const lines = readFileSync('.env.example', 'utf8').split('\n')
    expect(lines.filter(l => /^PBX_WEBHOOK_SECRET=/.test(l))).toHaveLength(1)
  })
})
