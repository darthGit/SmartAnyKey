// Loads the root .env into process.env for integration tests (no dotenv dependency).
import { readFileSync } from 'node:fs'

try {
  for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
    const i = line.indexOf('=')
    if (i < 1 || line.startsWith('#')) continue
    const key = line.slice(0, i)
    if (!(key in process.env)) process.env[key] = line.slice(i + 1)
  }
}
catch {
  // .env missing — integration tests will fail with a clear error below
}
