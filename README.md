# SmartAnyKey

Self-hosted remote access for technicians who support many sites.

One board shows every location and every device on it. Click a device and the
session opens in the browser — SSH, VNC or RDP — with credentials resolved and
injected for you. Nothing to install on the technician's machine, no VPN client
to hand out, no password spreadsheet.

Built for internal support work: a help desk covering dozens or hundreds of
shops, offices or branches, where the person answering the phone needs to be on
the target machine in seconds.

> **Status: early release.** The features below work and are tested, but the
> application is not yet hardened for exposure beyond a trusted network — see
> [Status and roadmap](#status-and-roadmap) for what is still missing.

## What you get

- **Browser sessions, no client software.** SSH in a real terminal (xterm.js),
  VNC and RDP through a Guacamole bridge. Several sessions at once in a tiling
  mosaic — drag panes, split, keep a terminal alive while you open another.
- **SFTP file transfer** in the same session surface.
- **Inventory by site.** Points (locations) with their devices, contacts and
  notes. Search by device name, address or phone number.
- **Credential manager.** Named credential sets resolved in four levels —
  device, device type, point, global. Passwords are encrypted at rest
  (AES-256-GCM); the key lives in the environment, never in the database.
- **Auto-discovery.** Scan a site's network, get a proposed diff (new / matched
  / changed / missing) and apply what you agree with. Nothing is written
  without your confirmation.
- **Health checks.** On-demand probes per device, with a per-point health card.
- **Scheduled tasks.** Run your own Python, Node or shell scripts on a cron or
  a webhook, with dependencies installed once into a cached environment. Useful
  for backups, reports and notifications.
- **Roles.** Viewer, operator, admin — enforced both in the database (RLS) and
  at the API.
- **Two languages** out of the box (English, Ukrainian); adding one is a single
  JSON file.

## Requirements

- Docker with Compose v2. That is all you need to run it.
- To build from source: Node 22 and pnpm 11.

## Quickstart — run the release images

Take the `docker/` directory, run one script, open a browser. No source code,
no Node, no pnpm — everything runs through the released images.

```bash
# 1. Generate your own secrets, start the stack, wait until it is healthy.
#    Safe to re-run: an existing .env is never overwritten.
./docker/install.sh

# 2. Open the address the script prints, on port 3000.

# 3. Create the first administrator on the setup screen it shows you.
```

That is the whole install. The schema is applied by the application itself on
startup, and the first administrator is created in the browser — neither is a
step you run.

**Own registry?** The script runs through the app image, so pass the
coordinates once; it writes them into the generated `docker/.env` for every
later command:

```bash
SAK_IMAGE=registry.example/smartanykey-app SAK_TAG=v0.1.0 ./docker/install.sh
```

**Unattended install** (CI, a rebuilt test stand)? Set `RBAC_ADMIN_EMAIL` and
`RBAC_ADMIN_PASSWORD` in `docker/.env` before running the script and it creates
the administrator for you — the setup screen then never appears.

> **The address matters, and the script picks it for you.** The server-side
> Supabase client uses the same public address as the browser, so `localhost`
> cannot work: inside a container it is the container itself, and every
> authenticated route answers 500. `install.sh` detects the machine's address
> and writes it to `docker/.env`; the application refuses to start on a loopback
> address rather than serving a half-broken install. A machine with several
> interfaces may get the wrong one — set `SAK_PUBLIC_SUPABASE_URL` yourself and
> re-run.

> **Running over plain HTTP?** Leave
> `NUXT_PUBLIC_SUPABASE_COOKIE_OPTIONS_SECURE=false`. The session cookie is sent
> as `Secure` only behind TLS — set it to `true` once you terminate TLS in front
> of the app, and the browser will silently drop the cookie until you do.
> The same switch turns on `Strict-Transport-Security` (one day, no subdomains):
> after you remove TLS, browsers that saw it keep using https for up to a day.

## Manual install — the steps `install.sh` performs

Use this when you want to see each step, automate it differently, or fix a
half-finished install. It is the same path, spelled out.

```bash
# 1. Generate your own secrets — all keys signed locally.
#    The project directory is mounted because this step reads the .env template
#    next to the compose file and writes the generated .env beside it.
docker compose -f docker/docker-compose.yml run --rm --no-deps \
  -u "$(id -u):$(id -g)" -v "$PWD:/work" -w /work app node /app/scripts/bootstrap.mjs
```

Two flags earn their place, both measured on a clean machine (2026-09-17):
`--no-deps`, because without it compose starts the stack first and kong dies on
the `.env` this very step is about to create; and `-u`, because the image runs
as a non-root user, so on a directory it does not own the script stops with
`EACCES: permission denied, open '.env'`. With `-u` the generated files belong
to you.

`bootstrap.mjs` writes `docker/.env` and `.env` with freshly generated secrets.
Do not skip it and do not copy `docker/.env.example` instead: the example file
contains the **real, publicly known** Supabase demo keys, so an install started
from it is an install anyone can read.

```bash
# 2. Put this machine's address in docker/.env (the script does this for you):
#    SAK_PUBLIC_SUPABASE_URL=http://192.0.2.10:8000

# 3. Start the stack (pulls both images)
docker compose -f docker/docker-compose.yml --env-file docker/.env up -d --wait

# 3.5. Give the dump directory to the application user. Docker creates the
#      mount point as root, the image runs as `node`, so without this the
#      backup task fails with EACCES while the UI shows it enabled.
docker compose -f docker/docker-compose.yml --env-file docker/.env \
  exec -T -u 0 app chown node:node /backups

# 4. Create the schema — only needed if you skipped the automatic migration
#    (SAK_SKIP_AUTO_MIGRATE=1); otherwise the application already did it.
docker compose -f docker/docker-compose.yml run --rm app node scripts/db-migrate.mjs

# 5. Create the first administrator from the environment instead of the setup
#    screen — set RBAC_ADMIN_EMAIL and RBAC_ADMIN_PASSWORD in docker/.env first
docker compose -f docker/docker-compose.yml run --rm app node scripts/seed-admin.mjs
```

## Development — run from source

```bash
pnpm install
pnpm build

# infrastructure + three fake targets to practise against (SSH, VNC, RDP)
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
  --env-file docker/.env up -d

pnpm dev:seed     # schema + demo taxonomy + the three dev targets
pnpm dev          # the app itself, on :3000
```

`pnpm dev:seed` prints the development login it creates. To also generate a
large inventory to test against (300 points, ~2100 devices): `pnpm seed:demo`.

Adding `--profile app` to the compose command runs the application in a
container as well, instead of `pnpm dev`. The dev overlay also brings up Supabase
Studio on `http://127.0.0.1:54323` (`STUDIO_PORT`); the release compose does not
carry it.

```bash
pnpm test         # full suite
pnpm test:ci      # the subset that needs no live database
pnpm lint
```

### Producing a release

`scripts/release.mjs` builds and publishes both images, tagged from the
argument you give it (or `git describe` if you give none). It runs unattended,
so any CI runner can call it without a workflow file of ours; `--no-push`
builds without publishing.

```bash
node scripts/release.mjs v1.2.3
```

## Operating notes

**Upgrade by re-running the installer** with the new tag:
`SAK_TAG=<new> ./docker/install.sh`. It keeps your `docker/.env` and removes
containers of services a release no longer ships.

**Your data lives in Docker volumes, not in `docker/`.** The database and stored
files are the `db-data` and `storage-data` volumes of the `smartanykey` project.
Replacing the `docker/` directory leaves them intact; `docker compose down -v`
deletes them.

**What runs:** Postgres; Supabase Auth, PostgREST, Realtime and Storage behind
the Kong gateway; guacd; the app and its task executor — nine containers.

**Only Kong (8000/8443) and the app (3000) listen on the host.** Postgres is
reachable only inside the compose network.

**Sign-in is rate-limited per client address** (`SAK_LOGIN_RATE_PER_MIN`, 10 a
minute), and opening remote sessions per user (`SAK_SESSION_OPEN_PER_MIN`). Behind
a reverse proxy every client arrives from the proxy's address and shares one
sign-in budget — raise the limit or rate-limit at the proxy. There is no
self-signup: administrators create users.

**Run exactly one replica of `app`.** The scheduler lives inside the
application process, so a second replica makes every cron job fire twice.
`--scale app=2` is not supported.

**Replace the demo keys.** This is what `bootstrap.mjs` is for — see step 1.
Worth repeating because the failure is silent: a stack started from
`.env.example` works perfectly and is readable by anyone who knows the
published demo keys.

**Keep two secrets outside the database.** `NUXT_CRED_ENCRYPTION_KEY` decrypts
every stored password and `JWT_SECRET` signs the API keys. Lose the first and
the credentials are gone even though the rows survive; lose the second and the
stack will not come up elsewhere.

## Backup and restore

```bash
# Dump public + auth + storage, gzipped, with rotation
docker compose -f docker/docker-compose.yml run --rm \
  -v /your/backup/dir:/backups -e BACKUP_DIR=/backups \
  app node scripts/backup.mjs --keep 7
```

**A backup is three artifacts, and the dump is only the first.** Store
`NUXT_CRED_ENCRYPTION_KEY` and `JWT_SECRET` separately from it — the script
prints their SHA-256 fingerprints so you can check a safe copy against the live
install without revealing the keys themselves.

**The dump is not encrypted.** Every customer record in it is in plain text.
Protecting the file and the medium it sits on is the installation's
responsibility, not the tool's.

To restore, the order matters:

```bash
docker compose -f docker/docker-compose.yml up -d db     # the database alone
docker compose -f docker/docker-compose.yml run --rm --no-deps \
  -v /your/backup/dir:/backups \
  app node scripts/restore.mjs /backups/<dump>.sql.gz --yes
docker compose -f docker/docker-compose.yml --env-file docker/.env up -d
```

Restore into a database that has **not** been migrated — the dump carries the
schema itself. Put the two secrets from the backup set back into the
environment before you rely on the result; `restore.mjs` finishes by decrypting
one credential, so a wrong key fails loudly instead of leaving you with rows
you cannot read.

## Status and roadmap

**Works today:** everything listed under [What you get](#what-you-get), a
one-command install from release images, backup and restore, and an English and
Ukrainian interface.

**Before you expose it beyond a trusted network** — not done yet:

- Rate limiting on sign-in and on the endpoints that open remote sessions.
- Security headers: Content-Security-Policy, HSTS, frame protection.
- Server error messages are English only (the interface itself is translated).

**Operations:**

- One-command rollback to the previous release, verified end to end.
- A browser smoke test in CI: sign in → board → open a session.

**Planned:**

- A board that stays fast with hundreds of sites.
- Accessibility pass: automated audit and full keyboard navigation.

Monitoring and error tracking are left to your own stack: the services expose
health checks, and logs go to Docker.

## License

Apache License 2.0 — see [LICENSE](./LICENSE). Copyright 2026 darthGit.
