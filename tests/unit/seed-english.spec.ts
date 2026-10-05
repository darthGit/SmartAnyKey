// The dev seed ships in the public repo: its data (type names, command names) is
// English like the rest of the code. Comments are not data and may stay as they are.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('dev seed', () => {
  it('dev_seed_has_no_cyrillic_data', () => {
    const data = readFileSync('supabase/seeds/dev.sql', 'utf8')
      .split('\n')
      .map(l => l.replace(/--.*$/, ''))
      .filter(l => /[Ѐ-ӿ]/.test(l))
    expect(data).toEqual([])
  })
})
