#!/bin/sh
# SmartAnyKey — one-command install.
#
# A literal `docker compose up -d` is impossible here, and that is measured, not
# assumed: compose interpolates variables at parse time, before any
# container starts, so a service that would generate secrets cannot help that
# same `up` (ADR-020). Hence a wrapper — but it only hides the secret-generation
# step; it does not hide migrations and the first admin, those are gone entirely:
# the app applies migrations on start, the `/setup` screen creates the admin.
set -eu

# bootstrap.mjs reads `docker/.env.example` and writes `docker/.env` relative to CWD
# (scripts/bootstrap.mjs:76,157,164), while this script lives inside docker/.
cd "$(dirname "$0")/.."

ENV_FILE=docker/.env

# Demo mode adds a fictional branch with SSH/VNC/RDP targets and seeds sample data.
# Remembered in .env: a later re-run (the upgrade path, with --remove-orphans) would
# otherwise delete the demo targets.
SAK_DEMO="${SAK_DEMO:-}"
# --update: an existing install gets new images and a restart — no secrets, address or admin
# steps. Upgrade = `git pull` + `./docker/install.sh --update` (docs/operations.md).
UPDATE=
for arg in "$@"; do
  case "$arg" in
    --demo) SAK_DEMO=1 ;;
    --update) UPDATE=1 ;;
    *) echo "unknown flag: $arg (use --demo or --update)" >&2; exit 2 ;;
  esac
done
if [ -n "$UPDATE" ] && [ ! -f "$ENV_FILE" ]; then
  echo "No installation here ($ENV_FILE is missing) — run ./docker/install.sh without --update." >&2
  exit 1
fi
if [ -z "$SAK_DEMO" ] && [ -f "$ENV_FILE" ]; then
  SAK_DEMO="$(grep -E '^SAK_DEMO=' "$ENV_FILE" | cut -d= -f2- || true)"
fi
COMPOSE_FILES="-f docker/docker-compose.yml"
if [ "$SAK_DEMO" = 1 ]; then COMPOSE_FILES="$COMPOSE_FILES -f docker/docker-compose.demo.yml"; fi

# The registry is a property of the installation (ADR-020). The bootstrap step runs through
# the image, and the image coordinates live in .env, which does not exist yet — so with a non-default
# registry they are passed inline to this very command.
SAK_IMAGE="${SAK_IMAGE:-}"
SAK_TAG="${SAK_TAG:-}"
export SAK_IMAGE SAK_TAG

say() { printf '\n==> %s\n' "$1"; }

say "Downloading images"
# `up` and `run` never re-pull a tag that exists locally (measured 2026-10-21): without
# this, re-running the installer to upgrade on `latest` restarts the old images.
docker compose $COMPOSE_FILES pull --quiet

if [ -z "$UPDATE" ]; then
say "1/3 Secrets"
# Three flags, each measured by a live run on a clean machine (DinD,
# 2026-09-17):
#   --no-deps  : otherwise compose brings up the stack before the script, and kong fails on
#                the `.env` this very step is about to create;
#   -u         : otherwise the image runs as user `node` and in a foreign directory
#                stops with `EACCES: permission denied, open '.env'`;
#   -v/-w      : the image has no `docker/` directory (.dockerignore), so without
#                the mount the script fails with `ENOENT: docker/.env.example`.
# An existing .env is not overwritten without --force and the exit stays zero —
# so re-running the script is safe.
docker compose $COMPOSE_FILES run --rm --no-deps \
  -u "$(id -u):$(id -g)" -v "$PWD:/work" -w /work \
  app node /app/scripts/bootstrap.mjs --from-installer

fi

say "1.5/3 Machine address and image coordinates"
# ⚠ Detecting the address inside a container is impossible, and that is measured, not inferred:
# in a clean room 2026-09-18 the entrypoint honestly picked the first non-loopback IPv4 —
# and it turned out to be `172.19.0.14`, the container's own address in the compose network.
# Host interfaces are invisible from a container by construction. So the resolver is the
# same (`scripts/public-address.mjs`), but runs here, in the host network.
IMAGE_REF="${SAK_IMAGE:-ghcr.io/darthgit/smartanykey-app}:${SAK_TAG:-latest}"
if ! grep -qE '^SAK_PUBLIC_SUPABASE_URL=.+' "$ENV_FILE"; then
  url="$(docker run --rm --network host "$IMAGE_REF" node /app/scripts/public-address.mjs)" || {
    echo "Could not detect the machine address — set SAK_PUBLIC_SUPABASE_URL in $ENV_FILE" >&2
    exit 1
  }
  sed -i "s|^SAK_PUBLIC_SUPABASE_URL=.*|SAK_PUBLIC_SUPABASE_URL=$url|" "$ENV_FILE"
  echo "Install address: $url"
fi

# The image coordinates must be saved into .env, otherwise they live only in this
# run: the customer's next `up -d`/restart/ops goes to the default registry and
# fails with `denied` (caught live in the same place). The README used to ask to set them
# by hand — exactly the manual step this install removes.
# BACKUP_HOST_DIR goes here too: it is a host thing (a directory or a volume name), and
# the app cannot write it — compose reads it when the container starts.
# Empty = the managed volume `sak-backups`; an absolute path = bind mount.
for pair in "SAK_DEMO=${SAK_DEMO:-}" "SAK_IMAGE=${SAK_IMAGE:-}" "SAK_EXECUTOR_IMAGE=${SAK_EXECUTOR_IMAGE:-}" "SAK_TAG=${SAK_TAG:-}" "BACKUP_HOST_DIR=${BACKUP_HOST_DIR:-}"; do
  key="${pair%%=*}"; val="${pair#*=}"
  [ -n "$val" ] || continue
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
done

say "2/3 Stack"
# `--wait` instead of our own polling loop: compose already knows the healthchecks
# (kong `CMD kong health`, app — an HTTP probe), and waits exactly on them.
# `--remove-orphans`: re-running the installer is the upgrade path, and a service a
# release dropped would otherwise keep running (the old pooler kept Postgres on 5432).
docker compose $COMPOSE_FILES --env-file "$ENV_FILE" up -d --remove-orphans --wait

# Permissions on the dump directory. Measured 2026-09-21 in a clean room: the image runs
# as `node` (uid 1000), and docker creates the `/backups` mount point — both
# a managed volume (no directory in the image) and a bind land as `root:root`. So
# `pg_dump` gets EACCES while the backup toggle is green. The path inside the
# container is the same in both branches, so one chown fixes both.
docker compose $COMPOSE_FILES --env-file "$ENV_FILE" exec -T -u 0 app \
  chown node:node /backups \
  || echo "⚠ could not fix permissions on /backups — backups will fail with EACCES"

if [ -n "$UPDATE" ]; then
  say "Updated"
  echo "Running $(docker compose $COMPOSE_FILES --env-file "$ENV_FILE" exec -T app printenv NUXT_APP_VERSION 2>/dev/null || echo 'unknown version')."
  exit 0
fi

say "3/3 First admin"
# Empty RBAC_ADMIN_* is the default after bootstrap. Then a person creates the admin on
# the `/setup` screen, and that is the normal path. Non-empty = an unattended install
# (CI, a repeatable test bench) → the seeder runs silently. The `/setup` gate is the same
# in both cases: is there at least one `profiles.role='admin'`.
RBAC_ADMIN_EMAIL="$(grep -E '^RBAC_ADMIN_EMAIL=' "$ENV_FILE" | cut -d= -f2- || true)"
RBAC_ADMIN_PASSWORD="$(grep -E '^RBAC_ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2- || true)"
# A re-run (an upgrade, adding --demo) finds the admin already there: ask the app
# whether /setup is still open instead of sending the person to a closed screen.
SETUP_OPEN="$(docker compose $COMPOSE_FILES --env-file "$ENV_FILE" exec -T app node -e \
  "fetch('http://127.0.0.1:3000/api/setup/status').then(r => r.json()).then(j => process.stdout.write(String(j.open)))" \
  2>/dev/null || true)"
if [ -n "$RBAC_ADMIN_EMAIL" ] && [ -n "$RBAC_ADMIN_PASSWORD" ]; then
  docker compose $COMPOSE_FILES --env-file "$ENV_FILE" \
    run --rm app node scripts/seed-admin.mjs
  echo "Admin created from RBAC_ADMIN_* — the /setup screen will not appear."
elif [ "$SETUP_OPEN" = true ]; then
  echo "Create the first administrator in the browser — the app opens on the setup screen."
else
  echo "An administrator already exists — sign in."
fi

if [ "$SAK_DEMO" = 1 ]; then
  say "Demo data"
  docker compose $COMPOSE_FILES --env-file "$ENV_FILE" run --rm app node scripts/seed-showcase.mjs
  # xrdp checks the system password inside the target; the app image has no docker CLI.
  docker compose $COMPOSE_FILES --env-file "$ENV_FILE" exec -T demo-office \
    bash -c "echo 'abc:demo-secret-pass' | chpasswd" \
    || echo "⚠ could not set the back-office RDP password — RDP to the demo PC will ask for one"
  echo "Demo branch network ready — search for 142 on the board. Demo passwords are public."
fi

say "Done"
# The address step above (or the person) stored the install address; the app is the
# same host on its own port. Reading the stored value, not detecting it a second time.
APP_HOST="$(grep -E '^SAK_PUBLIC_SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2- | sed -E 's|^https?://||; s|[:/].*$||')"
APP_PORT="$(grep -E '^SAK_PORT=' "$ENV_FILE" | cut -d= -f2- || true)"
echo "Open http://${APP_HOST}:${APP_PORT:-3000}"
