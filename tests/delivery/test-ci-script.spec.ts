// The automatable half: `pnpm test:ci` must run without a live
// Supabase, i.e. must NOT collect tests/integration/**.
//
// ⚠ The first version of this test checked that the script line contains "integration"
// — and was green while the exclusion did not actually work (CLI `vitest run
// --exclude` filters nothing; measured with `vitest list --filesOnly`). The test
// encoded my model ("the command contains the word") instead of the contract
// ("integration files are not collected"). Now we check the glob itself with the
// same matcher the file collector uses.
import { readFileSync } from 'node:fs'
import picomatch from 'picomatch'
import { describe, expect, it } from 'vitest'
import { CI_EXCLUDE } from '../../vitest.config'

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>
}

describe('test:ci', () => {
  it('excludes every integration spec and nothing else', () => {
    const matches = picomatch(CI_EXCLUDE)

    // Real paths from the tree, not invented ones.
    expect(matches('tests/integration/credential-bindings.spec.ts')).toBe(true)
    expect(matches('tests/integration/scheduled-tasks.spec.ts')).toBe(true)

    // The other suites must stay — otherwise "green CI" would mean
    // "nothing ran".
    expect(matches('tests/delivery/migrations-are-ddl-only.spec.ts')).toBe(false)
    expect(matches('tests/unit/discovery.spec.ts')).toBe(false)
    expect(matches('tests/board/layout.spec.ts')).toBe(false)
  })

  it('is wired through the config switch, not a no-op CLI flag', () => {
    const ci = pkg.scripts['test:ci']
    expect(ci, 'package.json has no test:ci script').toBeTruthy()
    expect(ci).toMatch(/vitest/)
    // An env switch specifically: CLI `--exclude` silently does nothing here.
    expect(ci).toContain('SAK_TEST_CI')
    expect(ci, 'CLI --exclude does not filter — do not bring it back').not.toMatch(/--exclude/)
  })

  it('exposes dev:seed and seed:demo — the commands the README promises', () => {
    expect(pkg.scripts['dev:seed']).toBeTruthy()
    expect(pkg.scripts['seed:demo']).toBeTruthy()
  })
})
