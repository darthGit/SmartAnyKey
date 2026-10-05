// mountSuspended does not inject a vue-i18n instance → useI18n() in components throws.
// We install a global i18n (real locales + Ukrainian plural) for all mount tests,
// so components with t()/te() mount. `locale`/`setLocale`/`locales`
// (@nuxtjs/i18n extensions) are not needed here — the components that use them
// (index.vue) are not mounted in these tests.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { pluralRules } from '../../i18n/pluralRules'

// process.cwd() (the project root) — reliable in both the node and nuxt env, unlike
// import.meta.url (not file:// in the nuxt env).
const dir = join(process.cwd(), 'i18n', 'locales')
const en = JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8'))
const uk = JSON.parse(readFileSync(join(dir, 'uk.json'), 'utf8'))

config.global.plugins.push(
  createI18n({ legacy: false, locale: 'en', fallbackLocale: 'en', messages: { en, uk }, pluralRules }),
)
