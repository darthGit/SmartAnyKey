// CI runs what a contributor runs locally, on the toolchain the image ships:
// the same checks, a frozen lockfile, the Dockerfile's Node major and pnpm.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ci = () => readFileSync('.github/workflows/ci.yml', 'utf8')
const dockerfile = readFileSync('Dockerfile', 'utf8')

describe('.github/workflows/ci.yml', () => {
  it('runs lint, the i18n check and the unit suite on a frozen lockfile', () => {
    const s = ci()
    for (const step of ['pnpm install --frozen-lockfile', 'pnpm lint', 'pnpm check:i18n', 'pnpm test:ci'])
      expect(s, step).toContain(step)
  })

  it('uses the Node major of the Dockerfile base image', () => {
    const major = dockerfile.match(/^FROM node:(\d+)/m)?.[1]
    expect(major).toBeTruthy()
    expect(ci()).toMatch(new RegExp(`node-version:\\s*${major}\\b`))
  })

  it('takes the pnpm version from the Dockerfile instead of repeating it', () => {
    expect(dockerfile).toMatch(/npm install -g pnpm@\d+\.\d+\.\d+/)
    expect(ci()).toContain('Dockerfile')
    expect(ci()).not.toMatch(/pnpm@\d/)
  })

  // Actions minutes are billed on private repositories only; the private origin
  // runs the same checks locally before every PR.
  it('skips the job on a private repository', () => {
    expect(ci()).toMatch(/if:\s*\$\{\{\s*!github\.event\.repository\.private\s*\}\}/)
  })
})
