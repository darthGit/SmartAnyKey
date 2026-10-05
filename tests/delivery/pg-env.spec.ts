// Postgres connection resolution (`scripts/lib/pg.mjs`) — one layer for two
// paths (host / inside the image). The live proof is
// `docker compose run --rm app node scripts/db-migrate.mjs`. Here we guard the
// fork itself, because it is silent: a wrong port gives not a "config error" but
// "FATAL: no tenant identifier provided" from someone else's service.
import { describe, expect, it } from 'vitest'
// @ts-expect-error — .mjs script without types
import { parseDotenv, resolvePgEnv } from '../../scripts/lib/pg.mjs'

const DOCKER_ENV = `
# коментар
POSTGRES_PASSWORD=secret-pw
POSTGRES_DB=postgres
POSTGRES_PORT=5432
`

describe('resolvePgEnv', () => {
  it('uses the container env as-is when PGHOST is already set', () => {
    // This is what a call inside the image looks like: compose passed PG* itself.
    expect(resolvePgEnv({ PGHOST: 'db', PGPASSWORD: 'from-compose' }, DOCKER_ENV)).toEqual({
      PGHOST: 'db',
      PGPORT: '5432',
      PGUSER: 'postgres',
      PGPASSWORD: 'from-compose',
      PGDATABASE: 'postgres',
    })
  })

  it('never lets docker/.env override an already-configured connection', () => {
    // Otherwise the host password would override the container one and the failure
    // would be "autentication failed" instead of a clear one.
    const got = resolvePgEnv({ PGHOST: 'db', PGPASSWORD: 'container-pw' }, DOCKER_ENV)
    expect(got.PGPASSWORD).toBe('container-pw')
  })

  it('falls back to the host path on the DIRECT postgres port, not 5432', () => {
    // 5432/6543 on the host are held by supavisor — psql does not connect through the pooler.
    const got = resolvePgEnv({}, DOCKER_ENV)
    expect(got.PGHOST).toBe('127.0.0.1')
    expect(got.PGPORT).toBe('5433')
    expect(got.PGPASSWORD).toBe('secret-pw')
  })

  it('respects an explicit SAK_DB_PORT', () => {
    expect(resolvePgEnv({ SAK_DB_PORT: '15432' }, DOCKER_ENV).PGPORT).toBe('15432')
  })

  it('fails loudly when no password can be found', () => {
    expect(() => resolvePgEnv({}, '')).toThrow(/password/)
  })
})

describe('parseDotenv', () => {
  it('skips comments and blanks, keeps values containing =', () => {
    const got = parseDotenv('# c\n\nA=1\nB=x=y\n  C = 3 \n')
    expect(got).toEqual({ A: '1', B: 'x=y', C: '3' })
  })

  it('ignores malformed lines instead of inventing keys', () => {
    expect(parseDotenv('=novalue\nJUSTAKEY\n')).toEqual({})
  })
})
