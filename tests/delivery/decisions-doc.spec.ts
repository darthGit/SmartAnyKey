// Code comments cite architecture decisions as ADR-NNN; docs/DECISIONS.md is
// where a reader resolves them. Every number cited in the code needs a row.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ROW = /^\| (\d{3}) \| .+ \| (ACCEPTED|SUPERSEDED by \d{3}) \|$/gm

describe('docs/DECISIONS.md', () => {
  it('has a row for every ADR number cited in the code', () => {
    const doc = readFileSync('docs/DECISIONS.md', 'utf8')
    const rows = new Set([...doc.matchAll(ROW)].map(m => m[1]))
    const cited = execFileSync('git', ['grep', '-ohE', 'ADR-[0-9]{3}', '--', ':!ai', ':!docs/DECISIONS.md'], { encoding: 'utf8' })
      .split('\n').filter(s => /^ADR-\d{3}$/.test(s)).map(s => s.slice(4))
    const missing = [...new Set(cited)].filter(n => !rows.has(n)).sort()
    expect(missing).toEqual([])
  })
})
