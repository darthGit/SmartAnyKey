// Key parity. The script function must find keys present in the base
// locale (en) and missing in the checked one, including nested ones (dot-path).
import { describe, expect, it } from 'vitest'
// @ts-expect-error — .mjs has no types; contract: diffKeys(base, target) → string[]
import { diffKeys } from '../../scripts/check-i18n.mjs'

describe('check-i18n parity', () => {
  it('flags_missing_leaf_keys', () => {
    const base = { a: 1, nested: { b: 2, c: 3 } }
    const target = { a: 1, nested: { b: 2 } }
    expect(diffKeys(base, target)).toEqual(['nested.c'])
  })

  it('empty_when_all_present', () => {
    const base = { a: 1, nested: { b: 2 } }
    expect(diffKeys(base, { a: 1, nested: { b: 2 } })).toEqual([])
  })
})
