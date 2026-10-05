// Database backup.
//
//   BACKUP_DIR=/srv/sak-backups node scripts/backup.mjs [--keep N]
//   docker compose run --rm app node scripts/backup.mjs        # the same image
//
// ⚠ A backup set is three artifacts, and this script makes only the first:
//   1. the dump (here);
//   2. `NUXT_CRED_ENCRYPTION_KEY` — without it all `password_enc` are dead after
//      a restore (ADR-009): the data is there, nothing can decrypt it;
//   3. `JWT_SECRET` from `docker/.env` — it signs ANON/SERVICE_ROLE, so on a new
//      machine with a different secret the stack simply won't come up.
// Keep the second and third separately from the dump. The script reminds about
// this every time and prints their fingerprints, so you can check that what is
// in the safe matches what this database is encrypted with.
//
// The dump is NOT encrypted (developer's decision) → permissions on the
// directory and media are the installation's responsibility. The dump holds all
// client data in plain text.
//
// We do NOT write remote shipping (S3/rclone/scp): the dump lands in staging, and
// where to send it is a step of a task the client authors in our own scheduler,
// with their own credentials via `credential_sets` (ADR-014 + ADR-018).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGzip } from 'node:zlib'
import { pgEnv } from './lib/pg.mjs'

// Dump three schemas, not only `public`: users live in `auth.*`, files in
// `storage.*`. A dump of `public` alone would give a database nobody can log
// into — i.e. "there is a backup, but nothing to restore".
const SCHEMAS = ['public', 'auth', 'storage']

const NAME_RE = /^sak-\d{8}-\d{6}\.sql\.gz$/

export function backupName(date) {
  const p = n => String(n).padStart(2, '0')
  return `sak-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.sql.gz`
}

/**
 * What to delete so that the `keep` newest remain. A pure function.
 * The name carries the time → lexicographic sort = chronological, no mtime.
 * Foreign files in the directory are not ours — rotation must not delete them.
 */
export function planRotation(names, keep) {
  if (!Number.isInteger(keep) || keep < 1)
    throw new Error(`--keep must be an integer ≥1, got: ${keep} (keep=0 would delete the backup just made)`)
  const mine = names.filter(n => NAME_RE.test(n)).sort()
  return mine.slice(0, Math.max(0, mine.length - keep))
}

/** Fingerprint of a secret — to check "same key?" without showing the key. */
export function fingerprint(secret) {
  return secret ? `sha256:${createHash('sha256').update(secret).digest('hex').slice(0, 12)}` : '—(missing)'
}

function parseArgs(argv) {
  // 30, not 7: the production-readiness checklist asked for
  // ≥30 days of retention, and the nightly cron makes one copy per day.
  let keep = Number(process.env.BACKUP_KEEP || 30)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keep') {
      keep = Number(argv[++i])
      continue
    }
    throw new Error(`unknown argument: ${argv[i]}`)
  }
  return { keep }
}

async function main(argv) {
  const { keep } = parseArgs(argv)
  const dir = process.env.BACKUP_DIR
  // Deliberately no default: any default here lands either in the working tree
  // (and in `git status` and the build context) or in the container's HOME
  // (and vanishes with the container — silent loss of backups). Say it aloud.
  if (!dir) {
    throw new Error(
      'BACKUP_DIR is not set. It is a path OUTSIDE the working tree: on the host any '
      + 'directory, in compose a mounted volume. No default on purpose: in the working '
      + 'tree a dump pollutes git status and the build context, and in the container HOME '
      + 'it disappears with the container.',
    )
  }
  if (!existsSync(dir))
    mkdirSync(dir, { recursive: true })

  const file = join(dir, backupName(new Date()))
  const args = ['--clean', '--if-exists', ...SCHEMAS.flatMap(s => ['-n', s])]

  await new Promise((resolve, reject) => {
    const child = spawn('pg_dump', args, { env: { ...process.env, ...pgEnv() }, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => { err += d })
    child.on('error', e => reject(e.code === 'ENOENT' ? new Error('pg_dump not found in PATH') : e))
    const out = createWriteStream(file)
    child.stdout.pipe(createGzip({ level: 9 })).pipe(out)
    out.on('error', reject)
    // Wait for the file's on('finish'), not the process exit: otherwise we
    // could report success while the last chunk is not on disk yet.
    let code
    child.on('close', c => { code = c })
    out.on('finish', () => {
      if (code === 0)
        resolve()
      else
        reject(new Error(`pg_dump → exit ${code}\n${err.trim()}`))
    })
  })

  const size = statSync(file).size
  console.log(`✓ ${file} (${(size / 1024 / 1024).toFixed(1)} MB, schemas: ${SCHEMAS.join(', ')})`)

  const doomed = planRotation(readdirSync(dir), keep)
  for (const n of doomed) {
    unlinkSync(join(dir, n))
    console.log(`  rotation: deleted ${n}`)
  }
  console.log(`  remaining: ${readdirSync(dir).filter(n => NAME_RE.test(n)).length} (keep=${keep})`)

  console.log('\n⚠ The dump is ONLY 1 of 3 parts of the backup set. Store SEPARATELY:')
  console.log(`  NUXT_CRED_ENCRYPTION_KEY  ${fingerprint(process.env.NUXT_CRED_ENCRYPTION_KEY)}`)
  console.log(`  JWT_SECRET                ${fingerprint(process.env.JWT_SECRET)}`)
  console.log('  Without the 1st there is no data; without the 2nd passwords will not decrypt; without the 3rd the stack will not come up.')
  console.log('  The dump is NOT encrypted: directory/media permissions are up to the installation.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2))
  }
  catch (e) {
    console.error(`backup: ${e.message}`)
    process.exit(1)
  }
}
