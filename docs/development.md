# Development

## Run from source

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

`pnpm seed:showcase` loads the fictional branch network the README media are
recorded on — twelve branches, contacts, scan rules and a scheduled task; its
devices live on the demo LAN `corp.lan` (`10.42.142.0/24`) of `docker/docker-compose.demo.yml`
— add that file to the compose command to bring the targets up.

Adding `--profile app` to the compose command runs the application in a
container as well, instead of `pnpm dev`. The dev overlay also brings up Supabase
Studio on `http://127.0.0.1:54323` (`STUDIO_PORT`); the release compose does not
carry it.

```bash
pnpm test         # full suite
pnpm test:ci      # the subset that needs no live database
pnpm lint
```

### Recording the README media

The GIFs and screenshots in `docs/media/` are recorded by a script, so they can be
redone after a UI change. Record on the in-compose stack with the dev overlay and
a database that holds **only** the showcase data — anything else ends up in the
frames. This wipes the development database:

```bash
dc() { docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml -f docker/docker-compose.demo.yml --env-file docker/.env --profile app "$@"; }
dc down && docker volume rm smartanykey_db-data && dc up -d --no-build --wait
SUPABASE_URL=http://localhost:8000 SUPABASE_SERVICE_KEY=$(grep ^SERVICE_ROLE_KEY= docker/.env | cut -d= -f2-) \
  RBAC_ADMIN_EMAIL=helpdesk@example.com RBAC_ADMIN_PASSWORD=showcase-demo-pass node scripts/seed-admin.mjs
pnpm seed:showcase
for l in en uk; do
  SHOWCASE_EMAIL=helpdesk@example.com SHOWCASE_PASSWORD=showcase-demo-pass \
    node tests/e2e/showcase-drive.mjs http://localhost:3000 docs/media/$l $l
  node tests/e2e/showcase-gif.mjs docs/media/$l 900 && rm docs/media/$l/*.webm
done
pnpm dev:seed   # back to the development data
```

`SCENES=hero,tiling` records only the named scenes (`hero`, `tiling`, `discovery`,
`{board,credentials,tasks,files}-{dark,light}`). Waits such as a running scan are
cut from the GIFs: the page shows a small magenta square in the corner while
waiting, and `showcase-gif.mjs` drops every frame that carries it. Look through
the frames before committing — no check can tell a real address on a screenshot
from a fictional one.

### Producing a release

`scripts/release.mjs` builds and publishes both images, tagged from the
argument you give it (or `git describe` if you give none). It runs unattended,
so any CI runner can call it without a workflow file of ours; `--no-push`
builds without publishing.

```bash
node scripts/release.mjs v1.2.3
```
