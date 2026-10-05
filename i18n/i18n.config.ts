import { pluralRules } from './pluralRules'

// vue-i18n runtime config (ADR-006): fallback to en, Ukrainian plural.
export default defineI18nConfig(() => ({
  legacy: false,
  fallbackLocale: 'en',
  pluralRules,
}))
