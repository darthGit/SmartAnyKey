# Runner / local-task executor (ADR-016).
# Isolated image: toolchains + a generic harness, zero Supabase credentials.
#
# Application libs are NOT baked in any more: a task carries its own dependencies, the harness
# installs them into a cached environment on a volume (`RUNNER_CACHE_DIR`). That is why one
# image for several runtimes is no longer "fat" — only toolchains here.
# Another runner type (ansible) = a separate image with its own recipes.json + a line in
# the BFF registry (`NUXT_TASK_RUNNERS`), not an edit of this file.
FROM python:3.12-slim

# Node comes from the official binaries: apt `nodejs` in bookworm is v20, and the
# `node22` runtime key must not lie about the version.
ARG NODE_VERSION=22.11.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash curl ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 --no-same-owner \
    && node --version \
    # pnpm: content-addressable store + hardlinks → identical packages of different tasks
    # sit on disk once (the cache otherwise eats the disk).
    # NOT via corepack: it caches the activated version in the $HOME of whoever ran
    # `prepare` (root at build), while runtime is user `runner` with HOME=a per-job dir
    # → the shim would go to the network for "latest" and fail on stale signing keys
    # (verified on node 22.11). `npm i -g` gives a plain binary in /usr/local/bin.
    && npm install -g pnpm@9.15.0 \
    && pnpm --version \
    && npm cache clean --force

# `requests` stays — existing device local commands may rely on it
# (legacy /run). For tasks, packages come from `deps`, not from here.
RUN pip install --no-cache-dir requests

WORKDIR /app
COPY server.py /app/server.py
COPY recipes.json /app/recipes.json

# Environment cache — a volume (compose). The directory must belong to the non-root user.
ENV RUNNER_CACHE_DIR=/cache
RUN useradd --create-home runner \
    && mkdir -p /cache \
    && chown runner:runner /cache

# Non-root: the user's script does not get container privileges.
USER runner

EXPOSE 8090
CMD ["python3", "/app/server.py"]
