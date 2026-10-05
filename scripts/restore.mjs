// Database restore from a dump.
// One procedure for two cases — "move to another machine" and "rebuild from
// scratch after a loss": no difference, both = a clean stack + this script.
//
//   node scripts/restore.mjs <file.sql.gz> --yes
//   docker compose run --rm app node scripts/restore.mjs /backups/sak-….sql.gz --yes
//
// The order matters (otherwise the restore hits live service connections):
//   1. docker compose up -d db          ← only the database
//   2. node scripts/restore.mjs … --yes
//   3. docker compose up -d             ← the rest of the stack
//   4. put `NUXT_CRED_ENCRYPTION_KEY` and `JWT_SECRET` from the backup set into the environment
//
// Why the script checks decryption specifically, not "are there rows": rows
// without the key are worth nothing (ADR-009). "The data is restored" and "the
// install works" are different claims, and proof of the second is a decrypted
// password, not count(*).
import { spawn } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createGunzip } from 'node:zlib'
import { pgEnv, psql } from './lib/pg.mjs'

/** PostgREST/psql return bytea as the string `\x<hex>`; ADR-009 format = iv(12)|tag(16)|ct. */
export function decryptFromBytea(value, keyHex) {
  const hex = String(value).startsWith('\\x') ? String(value).slice(2) : String(value)
  const buf = Buffer.from(hex, 'hex')
  if (buf.length < 29)
    throw new Error(`ciphertext too short (${buf.length} bytes) — not iv|tag|ct`)
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
}

function parseArgs(argv) {
  const file = argv.find(a => !a.startsWith('--'))
  const yes = argv.includes('--yes')
  const unknown = argv.filter(a => a.startsWith('--') && a !== '--yes')
  if (unknown.length)
    throw new Error(`unknown flag: ${unknown.join(', ')}`)
  if (!file)
    throw new Error('specify the dump file: node scripts/restore.mjs <file.sql.gz> --yes')
  return { file, yes }
}

async function loadDump(file) {
  await new Promise((resolve, reject) => {
    // ON_ERROR_STOP=1: the restore either succeeds or fails visibly. Without it psql
    // runs through errors and leaves a half-alive DB that "seems restored".
    const child = spawn('psql', ['-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '-'], {
      // `postgres` in self-host is NOT a superuser, and auth/storage belong to
      // their own roles → `--clean` drops what is not ours.
      env: { ...process.env, ...pgEnv(), PGUSER: process.env.PG_RESTORE_USER || 'supabase_admin' },
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    child.on('error', e => reject(e.code === 'ENOENT' ? new Error('psql not found in PATH') : e))
    child.on('close', c => (c === 0 ? resolve() : reject(new Error(`psql → exit ${c}`))))
    createReadStream(file).pipe(createGunzip()).pipe(child.stdin)
  })
}

function verify() {
  const users = Number(psql(['-tAc', 'select count(*) from auth.users']).trim())
  const points = Number(psql(['-tAc', 'select count(*) from public.points']).trim())
  console.log(`\n✓ data: auth.users=${users}, points=${points}`)
  if (!users)
    console.warn('⚠ auth.users is empty — nobody will be able to sign in')

  const key = process.env.NUXT_CRED_ENCRYPTION_KEY
  if (!key) {
    console.warn('⚠ NUXT_CRED_ENCRYPTION_KEY not set → decryption NOT verified.')
    console.warn('  That is the second part of the backup set. Without it every password_enc is dead (ADR-009).')
    return
  }
  const row = psql(['-tAF', '\t', '-c',
    'select name, password_enc from public.credential_sets where password_enc is not null limit 1']).trim()
  if (!row) {
    console.log('  (no credential set with a password in the DB — nothing to decrypt)')
    return
  }
  const [name, enc] = row.split('\t')
  try {
    const plain = decryptFromBytea(enc, key)
    console.log(`✓ DECRYPTION: set "${name}" → password of ${plain.length} chars.`)
    console.log('  i.e. both data and key restored — a working install, not just "rows in place".')
  }
  catch (e) {
    console.error(`✗ DECRYPTION FAILED for "${name}": ${e.message}`)
    console.error('  Most likely NUXT_CRED_ENCRYPTION_KEY is NOT the key this DB was encrypted with.')
    process.exit(1)
  }
}

async function main(argv) {
  const { file, yes } = parseArgs(argv)
  if (!existsSync(file))
    throw new Error(`file not found: ${file}`)
  if (!yes) {
    throw new Error(
      `restore OVERWRITES schemas public/auth/storage in the target DB (${pgEnv().PGHOST}:${pgEnv().PGPORT}`
      + `/${pgEnv().PGDATABASE}). If that is really what you want, add --yes.`,
    )
  }
  console.log(`▶ restore ${file} → ${pgEnv().PGHOST}:${pgEnv().PGPORT}/${pgEnv().PGDATABASE}`)
  await loadDump(file)
  verify()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2))
  }
  catch (e) {
    console.error(`restore: ${e.message}`)
    process.exit(1)
  }
}
