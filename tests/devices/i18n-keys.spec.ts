// RED: strings of the devices admin page are localized — devices.* keys
// exist in en and uk (parity). The keys do not exist yet → fails. Locales via fs
// (_locales) — the vite i18n plugin precompiles JSON on import (ADR-006).
import { describe, expect, it } from 'vitest'
import { en, uk } from '../i18n/_locales'

const KEYS = [
  'title',
  'subtitle',
  'search',
  'searchPlaceholder',
  'protocols',
  'label',
  'host',
  'defaultAction',
  'defaultActionAuto',
  'save',
  'saved',
  'empty',
  'saveError',
  'loadError',
]

describe('devices i18n keys (AC-6)', () => {
  it.each([['en', en], ['uk', uk]] as const)('%s has all devices.* keys', (loc, locale) => {
    expect(locale.devices, `${loc}.devices`).toBeTypeOf('object')
    for (const k of KEYS)
      expect(locale.devices, `${loc}.devices.${k}`).toHaveProperty(k)
  })
})
