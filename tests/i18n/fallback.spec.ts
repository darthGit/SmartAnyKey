// A key missing from the locale falls back to English (fallbackLocale: 'en'),
// instead of showing the key name / an empty string.
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { en } from './_locales'

describe('i18n fallback', () => {
  it('missing_key_falls_back_to_en', () => {
    const i18n = createI18n({
      legacy: false,
      locale: 'zz', // an empty locale without a single key
      fallbackLocale: 'en',
      messages: { en, zz: {} },
    })
    const signIn = (en as Record<string, Record<string, string>>).auth.signIn
    expect(i18n.global.t('auth.signIn')).toBe(signIn)
    expect(i18n.global.t('auth.signIn')).not.toBe('auth.signIn')
  })
})
