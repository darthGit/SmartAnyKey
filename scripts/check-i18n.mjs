// ADR-006 key parity: every locale must have exactly the keys of en.json (canon).
// diffKeys is for tests; main() is for pre-commit/CI.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Leaf keys present in base and missing in target (dot-path, nested).
export function diffKeys(base, target) {
  const missing = []
  const walk = (b, t, prefix) => {
    for (const [k, v] of Object.entries(b)) {
      const path = prefix ? `${prefix}.${k}` : k
      const tv = t == null ? undefined : t[k]
      if (v && typeof v === 'object' && !Array.isArray(v))
        walk(v, tv ?? {}, path)
      else if (tv === undefined)
        missing.push(path)
    }
  }
  walk(base, target ?? {}, '')
  return missing
}

function main() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'i18n', 'locales')
  const base = JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8'))
  let bad = false
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'en.json')) {
    const loc = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    const missing = diffKeys(base, loc)
    const extra = diffKeys(loc, base)
    if (missing.length || extra.length) {
      bad = true
      console.error(`✗ ${f}: missing [${missing.join(', ')}]${extra.length ? `; extra [${extra.join(', ')}]` : ''}`)
    }
    else {
      console.log(`✓ ${f}`)
    }
  }
  if (bad) {
    console.error('i18n key-parity failed (ADR-006).')
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main()
