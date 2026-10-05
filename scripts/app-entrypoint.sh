#!/bin/sh
# Entrypoint of the application image.
#
# ⚠ The address is NOT detected here, and that is the conclusion of a live run, not taste.
# The original plan put auto-detection in the entrypoint; in a clean room
# 2026-09-18 it honestly ran and picked `172.19.0.14` — the container's own
# address in the compose network. Host interfaces are invisible from a container by
# construction, so at this point the problem is unsolvable in principle. The resolver
# (`scripts/public-address.mjs`) runs on the host, in `docker/install.sh`, and
# writes the result into `docker/.env`.
#
# What stays here is a guard: the address must exist, and it must not be loopback.
set -eu

# The same image carries all ops commands (ADR-020: `compose run --rm app node
# scripts/*.mjs`), and `bootstrap.mjs` runs before `.env` even exists. A gate on
# them would mean the first install step fails on an address check that nobody
# could have set yet.
case "${1:-}${2:-}" in
  *".output/server/index.mjs") ;;
  *) exec "$@" ;;
esac

url="${NUXT_PUBLIC_SUPABASE_URL:-}"
case "$url" in
  "")
    echo "[entrypoint] SAK_PUBLIC_SUPABASE_URL is empty — nothing to start with." >&2
    echo "[entrypoint] Set the machine address in docker/.env or rerun ./install.sh" >&2
    exit 1
    ;;
  # ⚠ The quoted patterns are deliberate. Without quotes `[::1]` in `case` is not a literal but
  # a glob character class {:, 1}, so any address with a colon (i.e. any
  # with a port) matched as loopback and the container never started. Measured in
  # a clean room 2026-09-18 on `http://172.17.0.2:8000`.
  *localhost*|*127.0.0.1*|*"[::1]"*)
    # ponytail: refusal, not a warning. `localhost` in a container is the container
    # itself, so the server-side Supabase client calls itself and every
    # gated route returns 500 (`profiles count: TypeError: fetch failed` —
    # measured 2026-09-18). A half-working install costs more than an honest refusal.
    echo "[entrypoint] SAK_PUBLIC_SUPABASE_URL=$url points to loopback." >&2
    echo "[entrypoint] Inside the container that is the container itself → every gated" >&2
    echo "[entrypoint] route returns 500. Use the machine's IP or DNS name." >&2
    exit 1
    ;;
esac

echo "[entrypoint] public address: $url"
exec "$@"
