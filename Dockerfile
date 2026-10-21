# SmartAnyKey application image — SPA (ssr:false) + Nitro BFF in one process
# (ADR-001). ONE image serves both runtime and ops — that is why it contains
# Node and our `scripts/*.mjs`, and a customer without sources can run
# `docker compose run --rm app node scripts/db-migrate.mjs`.
# No separate ops image is needed.
#
# Debian slim, not alpine: `@parcel/watcher` builds from source (see
# `pnpm-workspace.yaml` allowBuilds), and some native packages lack musl
# prebuilds → alpine would turn the build into roulette. Same choice as
# `executor/Dockerfile` (python:3.12-slim) — one family of base images.

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /src

# pnpm as a plain binary, NOT via corepack: the repo has no `packageManager` field
# (corepack fails without it), and the version must be ≥11 — settings live in
# `pnpm-workspace.yaml` (`allowBuilds`), which pnpm 10 does not read.
RUN npm install -g pnpm@11.21.0

# The whole context in one layer: `postinstall` = `nuxt prepare`, which needs
# `nuxt.config.ts` and `app/` — install and copy cannot be split here.
# What does NOT ship is in `.dockerignore` (the private AI layer).
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm build

# The only runtime dependency outside the Nitro bundle: `scripts/seed-admin.mjs` calls
# GoTrue via supabase-js (the first admin). The version comes from
# package.json so it does not drift from the app.
RUN mkdir -p /deps && cd /deps \
    && npm init -y > /dev/null \
    && npm install --omit=dev \
       "@supabase/supabase-js@$(node -p "require('/src/package.json').dependencies['@supabase/supabase-js']")"

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# nmap — a system binary for recon (ADR-012: `execFile('nmap', argv)`), together with
# NSE scripts (`ssh-hostkey`, `ssl-cert`, `rdp-ntlm-info`, `smb-os-discovery`).
# The scan is unprivileged (`-sT -sV`); `-O` would need CAP_NET_RAW — not granted.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       nmap nmap-common ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# psql/pg_dump/pg_restore — ops inside the image.
# Version 17, not Debian's 15: the stack server is `supabase/postgres:17.6.x`, and
# `pg_dump 15` refuses to work against a 17 server ("server version …;
# pg_dump version …") — backup would fail, not "almost work". Hence the official
# PGDG repository. When upgrading `supabase/postgres`, bump this number too.
ARG PG_MAJOR=17
RUN install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
       https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}" \
    && rm -rf /var/lib/apt/lists/* \
    && pg_dump --version

WORKDIR /app
ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000

COPY --from=build /src/.output ./.output
COPY --from=build /deps/node_modules ./node_modules
# Ops inside the image: migrations = DDL, seeds = data.
COPY --from=build /src/scripts ./scripts
COPY --from=build /src/supabase ./supabase
COPY --from=build /src/package.json ./package.json

EXPOSE 3000
# The image creates the dump directory, otherwise docker makes the mount point itself —
# both a managed volume and a bind land as `root:root`, while the process runs as `node` (uid
# 1000) and gets EACCES with the backup toggle on (measured 2026-09-21).
# A bind onto a foreign directory is not fixed by this — there `install.sh` sets permissions.
RUN mkdir -p /backups && chown node:node /backups

USER node

# Gives compose a real "app is up" signal instead of "container is alive".
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NITRO_PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The public address is resolved right before Nitro starts — in compose this is
# impossible (interpolation happens before containers start, ADR-020).
# Last, so a new tag rebuilds only this layer. `release.mjs` passes the tag; a plain build
# says `unknown`, which the update badge never treats as outdated.
ARG SAK_VERSION=unknown
ENV NUXT_APP_VERSION=$SAK_VERSION

ENTRYPOINT ["/app/scripts/app-entrypoint.sh"]
CMD ["node", ".output/server/index.mjs"]
