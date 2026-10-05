// The point counter in the correct plural. en — 2 forms (the default vue-i18n
// rule), uk — 3 forms with a custom rule (i18n/pluralRules).
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { pluralRules } from '../../i18n/pluralRules'
import { en, uk } from './_locales'

function build() {
  return createI18n({
    legacy: false,
    locale: 'en',
    fallbackLocale: 'en',
    messages: { en, uk },
    pluralRules,
  })
}

describe('pointsCount plural', () => {
  it('en_singular_and_plural', () => {
    const { global } = build()
    global.locale.value = 'en'
    expect(global.t('board.pointsCount', 1)).toBe('1 point')
    expect(global.t('board.pointsCount', 2)).toBe('2 points')
  })

  it('uk_three_forms', () => {
    const { global } = build()
    global.locale.value = 'uk'
    expect(global.t('board.pointsCount', 1)).toBe('1 точка')
    expect(global.t('board.pointsCount', 2)).toBe('2 точки')
    expect(global.t('board.pointsCount', 5)).toBe('5 точок')
  })
})
