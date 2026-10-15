# Installation

The [Quickstart](../README.md#quickstart) is one script. This page covers the
options around it and the same install spelled out step by step.

## Options

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

**Demo mode** — `./docker/install.sh --demo` adds the overlay
`docker/docker-compose.demo.yml` (a fictional branch LAN with SSH, VNC and RDP
targets) and loads the showcase data. The choice is stored as `SAK_DEMO=1` in
`docker/.env`, so re-running the installer keeps it; clear it and re-run to
remove the demo targets. Their passwords are public — not for a real install.

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
