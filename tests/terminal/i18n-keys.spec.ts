// RED: terminal strings are localised — terminal.* keys are present in en
// and uk (parity). The keys do not exist yet → fails. Locales via fs (_locales), because
// the i18n vite plugin precompiles JSON on import (ADR-006 impl-notes).
import { describe, expect, it } from 'vitest'
import { en, uk } from '../i18n/_locales'

// The terminal key schema (pinned by the test, as the i18n foundation pinned board.*)
const KEYS = [
  'connecting',
  'closed',
  'error',
  'authError',
  'hostUnreachable',
  'actionUnavailable',
  'closePane',
  'newSession',
]

describe('terminal i18n keys', () => {
  it.each([['en', en], ['uk', uk]] as const)('%s has all terminal.* keys', (loc, locale) => {
    expect(locale.terminal, `${loc}.terminal`).toBeTypeOf('object')
    for (const k of KEYS)
      expect(locale.terminal, `${loc}.terminal.${k}`).toHaveProperty(k)
  })
})
