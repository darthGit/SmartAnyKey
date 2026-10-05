// Shared Postgres access for the ops scripts. Previously each script called
// `docker compose exec -T db psql`, which made them unusable exactly where they
// are needed most — inside the app image (no docker CLI, no compose context
// there). Now it is plain `psql` driven by PG* variables, so one script works
// both ways:
//
//   in a container: PG* come from docker-compose.yml (PGHOST=db, port 5432)
//   from the host:  PG* not set → password from docker/.env + 127.0.0.1:SAK_DB_PORT
//
// ⚠ The host port is 5433 (`SAK_DB_PORT`), NOT 5432: 5432/6543 on the host are
// held by supavisor, and psql through the pooler does not even connect ("FATAL:
// no tenant identifier provided" — it needs user `postgres.<tenant>`). The dev
// overlay publishes the direct `db` port; production needs none, since ops run
// inside the compose network.
//
// `psql` must be in PATH: on the host a system package, in the image
// `postgresql-client-17` (the version is not arbitrary: the server is 17.6, and
// client 15 refuses to talk to it).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** `KEY=value` parser (dotenv subset: no quotes, no export, no interpolation). */
export function parseDotenv(text) {
  const out = {}
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#'))
      continue
    const eq = t.indexOf('=')
    if (eq < 1)
      continue
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
  return out
}

/**
 * Connection resolution. A pure function — testable without a DB or files.
 * Priority: explicit PG* (container or manual override) → POSTGRES_* from docker/.env.
 * PGHOST in the process means "I am already configured" — then docker/.env is
 * not read at all, otherwise the host password would override the container's.
 */
export function resolvePgEnv(processEnv = {}, dockerEnvText = '') {
  if (processEnv.PGHOST) {
    return {
      PGHOST: processEnv.PGHOST,
      PGPORT: processEnv.PGPORT || '5432',
      PGUSER: processEnv.PGUSER || 'postgres',
      PGPASSWORD: processEnv.PGPASSWORD || '',
      PGDATABASE: processEnv.PGDATABASE || 'postgres',
    }
  }
  const d = parseDotenv(dockerEnvText)
  const password = processEnv.PGPASSWORD || d.POSTGRES_PASSWORD
  if (!password) {
    throw new Error(
      'Postgres password not found: set PGPASSWORD or POSTGRES_PASSWORD in docker/.env '
      + '(from the host the script connects to 127.0.0.1:$SAK_DB_PORT, in a container to PGHOST=db).',
    )
  }
  return {
    PGHOST: '127.0.0.1',
    // NOT d.POSTGRES_PORT: in docker/.env that is the container's internal
    // port (5432) supavisor is configured with, not the one published to the host.
    PGPORT: processEnv.PGPORT || processEnv.SAK_DB_PORT || '5433',
    PGUSER: processEnv.PGUSER || 'postgres',
    PGPASSWORD: password,
    PGDATABASE: processEnv.PGDATABASE || d.POSTGRES_DB || 'postgres',
  }
}

function readDockerEnv() {
  try {
    return readFileSync('docker/.env', 'utf8')
  }
  catch {
    return ''
  }
}

let cached

export function pgEnv() {
  cached ??= resolvePgEnv(process.env, readDockerEnv())
  return cached
}

/**
 * Run psql. `ON_ERROR_STOP=1` always — otherwise a failure mid-file stays only
 * in stderr and the script "successfully" carries on.
 */
export function psql(args, input) {
  const res = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...pgEnv() },
  })
  if (res.error) {
    throw new Error(
      res.error.code === 'ENOENT'
        ? 'psql not found in PATH (host: install postgresql-client; image: already included)'
        : `psql: ${res.error.message}`,
    )
  }
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout)
    process.exit(1)
  }
  return res.stdout
}

/** SQL literal: single quotes are doubled (the text comes from arbitrary fields). */
export const q = s => `'${String(s).replace(/'/g, "''")}'`
