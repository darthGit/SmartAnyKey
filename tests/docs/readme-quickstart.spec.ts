// Quickstart is the artifact a client reads first, and that is where six manual
// steps hide. The requirement is "exactly three", so the test counts them rather
// than taking it on faith.
//
// The other side of the same requirement: the full step-by-step path must stay
// (existing installs live by it) and must not contradict the script.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const README = readFileSync('README.md', 'utf8')

/** Section body from its `## ` to the next `## ` of the same level. */
function section(title: string): string {
  const re = new RegExp(`^## ${title}[^\\n]*$([\\s\\S]*?)(?=^## |\\z)`, 'm')
  const m = README.match(re)
  if (!m)
    throw new Error(`README.md has no "## ${title}" section`)
  return m[1]
}

describe('README quickstart (AC-6)', () => {
  it('quickstart_is_exactly_three_steps', () => {
    const body = section('Quickstart')
    const steps = body.match(/^#\s*\d+\.\s/gm) ?? []
    expect(steps, `expected 3 steps, found ${steps.length}`).toHaveLength(3)
  })

  it('quickstart_runs_the_installer_not_the_six_manual_commands', () => {
    const body = section('Quickstart')
    // The call form depends on where the client stands (`./docker/install.sh`
    // from the parent directory or `./install.sh` from inside) — both work, since
    // the script moves up a level itself. We check that it is called at all.
    expect(body, 'Quickstart must call install.sh').toMatch(/\.\/(docker\/)?install\.sh/)
    for (const gone of ['bootstrap.mjs', 'db-migrate.mjs', 'seed-admin.mjs']) {
      expect(body, `${gone} is no longer a client step — it lives in install.sh or the app`)
        .not.toContain(gone)
    }
  })

  it('manual_install_section_keeps_the_full_path', () => {
    // Existing installs and automation live by this path — removing it would mean
    // hiding unfinished work by silence.
    const body = section('Manual install')
    for (const kept of ['bootstrap.mjs', 'db-migrate.mjs', 'seed-admin.mjs'])
      expect(body, `Manual install must keep ${kept}`).toContain(kept)
  })
})
