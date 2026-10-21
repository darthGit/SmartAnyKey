# Operations

## Running it

**Upgrade by re-running the installer** from the new release's `docker/`
directory — compose files change between releases, so update it first
(`git pull` in a clone):

```bash
git pull
./docker/install.sh                # the tag in docker/.env (latest by default)
SAK_TAG=v0.2.0 ./docker/install.sh # or move to a specific release
```

It downloads the new images, keeps your `docker/.env` and removes containers of
services a release no longer ships.

**Admins see when a release is out.** Once a day (and at start) the server asks
`api.github.com` for the latest release; the admin menu shows the running version,
and a newer release adds an "Update available" button with its notes and the
commands above. This is the only request the app makes to the internet on its own:
set `SAK_UPDATE_REPO=` (empty) in `docker/.env` and re-run the installer to switch
it off.

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

**Replace the demo keys.** This is what `bootstrap.mjs` is for — see
[Manual install, step 1](installation.md#manual-install--the-steps-installsh-performs).
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
