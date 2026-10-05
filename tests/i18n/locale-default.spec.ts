// Data + runtime: the default locale en renders English strings;
// switching to uk gives Ukrainian ones (the render part). The full check of a
// mounted page's default + persistence after reload is manual.
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { pluralRules } from '../../i18n/pluralRules'
import { en, uk } from './_locales'

describe('default locale', () => {
  it('default_en_renders_english_switch_uk_renders_ukrainian', () => {
    const { global } = createI18n({
      legacy: false,
      locale: 'en',
      fallbackLocale: 'en',
      messages: { en, uk },
      pluralRules,
    })

    // default is English
    expect(global.t('auth.signIn')).toBe('Sign in')
    expect(global.t('board.signOut')).toBe('Sign out')

    // switch → Ukrainian
    global.locale.value = 'uk'
    expect(global.t('auth.signIn')).toBe('Увійти')
    expect(global.t('board.signOut')).toBe('Вийти')
  })
})
