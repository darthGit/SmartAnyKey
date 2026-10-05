// Locales are read via fs (raw JSON), NOT import — because the @nuxtjs/i18n vite plugin
// precompiles `i18n/locales/*.json` into an AST on import, and the test would see the AST,
// not the strings.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../i18n/locales')

export const en = JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8'))
export const uk = JSON.parse(readFileSync(join(dir, 'uk.json'), 'utf8'))
