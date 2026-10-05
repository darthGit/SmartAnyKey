// Data: en.json is canonical, uk.json has exactly the same key set.
// Keeps the locales paired at file level (the check-i18n script automates this in CI).
import { describe, expect, it } from 'vitest'
import { en, uk } from './_locales'

function leafPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k
    return v && typeof v === 'object' && !Array.isArray(v)
      ? leafPaths(v as Record<string, unknown>, path)
      : [path]
  })
}

describe('locale files', () => {
  it('uk_has_same_keys_as_en', () => {
    expect(leafPaths(uk as Record<string, unknown>).sort())
      .toEqual(leafPaths(en as Record<string, unknown>).sort())
  })

  it('en_defines_expected_namespaces', () => {
    const keys = leafPaths(en as Record<string, unknown>)
    // keys the components rely on after the retrofit
    for (const k of ['auth.signIn', 'auth.invalidCredentials', 'board.signOut', 'board.pointsCount', 'action.vnc'])
      expect(keys).toContain(k)
  })
})
