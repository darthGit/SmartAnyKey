#!/bin/sh
# Installs a release the way a user does and checks it answers with the right version.
#
#   sh scripts/release-test.sh fresh   <tag>          new install of <tag>
#   sh scripts/release-test.sh upgrade <prev> <tag>   install <prev> from the public registry,
#                                                     then update to <tag> with the new docker/
#
# <tag> images come from $SAK_IMAGE / $SAK_EXECUTOR_IMAGE (the release workflow points them at
# a local registry, so nothing is published before this passes); <prev> from the defaults.
# Uses the fixed compose project name — run it only on a Docker daemon with no other install.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
COMPOSE="docker compose -f docker/docker-compose.yml --env-file docker/.env"

cleanup() {
  [ -f "$WORK/docker/.env" ] && (cd "$WORK" && $COMPOSE down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# docker/ as the user gets it: tracked files only, never a local docker/.env.
unpack() { (cd "$ROOT" && git archive "$1" docker) | tar -x -C "$WORK"; }

# The app answering over HTTP is the proof; "healthy" alone is not.
check() {
  i=0
  until curl -fsS http://127.0.0.1:3000/api/setup/status >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 60 ] || { echo "release-test: app did not answer on :3000" >&2; exit 1; }
    sleep 2
  done
  version=$(cd "$WORK" && $COMPOSE exec -T app printenv NUXT_APP_VERSION | tr -d '\r')
  [ "$version" = "$1" ] || { echo "release-test: running $version, expected $1" >&2; exit 1; }
  echo "release-test: $1 answers on :3000"
}

case "${1:-}" in
  fresh)
    unpack HEAD
    (cd "$WORK" && SAK_TAG="$2" sh docker/install.sh)
    check "$2"
    ;;
  upgrade)
    unpack "$2"
    (cd "$WORK" && env -u SAK_IMAGE -u SAK_EXECUTOR_IMAGE SAK_TAG="$2" sh docker/install.sh)
    check "$2"
    cp "$WORK/docker/.env" "$WORK/.env.keep"
    rm -rf "$WORK/docker" && unpack HEAD && mv "$WORK/.env.keep" "$WORK/docker/.env"
    (cd "$WORK" && SAK_TAG="$3" sh docker/install.sh --update)
    check "$3"
    ;;
  *)
    echo "usage: release-test.sh fresh <tag> | upgrade <prev> <tag>" >&2
    exit 2
    ;;
esac
