-- 0015: tasks as a standalone entity (tier Full).
-- Slot 0015 was reserved for this change back in 0017 (see its header) — the
-- db-migrate.mjs journal is keyed by file name, so apply order does not matter here.
--
-- NOTHING OUTSIDE task_run IS REWRITTEN (ADR-011): `task_run` stays a generic
-- substrate (`kind` free, `result jsonb`), tasks only add columns.
-- `device_commands` is NOT touched — existing ssh/local device commands work as
-- they did (backward-compatible).
--
-- Model dimensions, listed before the schema:
--   * task × trigger    → separate `task_triggers`, because one task can be cron AND
--                         webhook at once (a scalar `tasks.cron` would be a defect);
--   * run × file        → separate `task_artifacts`, one row = ONE file;
--   * run × attempt     → `task_run.attempt` (retries are rows, not an array in result);
--   * task × credential → `cred_refs jsonb` [{set_id, env}], like `device_commands`
--                         (amends ADR-009: resolve-by-id, the set may be unbound).

-- Task definition -------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  -- Runtime is a KEY IN THE deployment's REGISTRY, not an enum (amended 2026-08-13).
  -- The list of available runners is a property of the installation (`NUXT_TASK_RUNNERS`),
  -- not our knowledge: adding `python313` or `ansible` = a line in config + an image with
  -- its own `recipes.json`, NO migration. There is deliberately no CHECK list here —
  -- otherwise every new runner would drag a schema change (deployment-specific, belongs in config).
  -- Validation "this runner is configured" happens at the BFF boundary (services/task-runner).
  runtime text not null,
  entrypoint text not null,
  -- {file name: body}. Multiple files inline; a git source is out of scope,
  -- but `entrypoint` separate from files leaves a seam for `source='git'`.
  files jsonb not null default '{}'::jsonb,
  deps text not null default '',            -- requirements.txt / package.json (contents)
  deps_lock text not null default '',       -- optional lock file; part of the environment hash
  env jsonb not null default '{}'::jsonb,   -- NON-secret variables (plaintext — not for passwords)
  cred_refs jsonb not null default '[]'::jsonb, -- [{set_id, env}] → PREFIX_USER/_PASSWORD/_PORT
  timeout_s int not null default 600 check (timeout_s > 0 and timeout_s <= 86400),
  retries int not null default 0 check (retries >= 0 and retries <= 10),
  backoff_s int not null default 0 check (backoff_s >= 0 and backoff_s <= 3600),
  overlap_policy text not null default 'skip' check (overlap_policy in ('skip', 'queue')),
  -- Gates RUNNING (ADR-013); authoring tasks is always admin.
  min_role text not null default 'operator' check (min_role in ('operator', 'admin')),
  enabled boolean not null default true,
  -- Result sink (tier Full): a plain HTTP POST with the run summary.
  -- Empty = do not notify. SMTP is deliberately not done (tier Full).
  -- Dimension stated out loud: "task × sink" is scalar FOR NOW, because
  -- the domain asks for one sink per task and notification is optional. If
  -- Slack AND monitoring are needed at once — that is not a second column but a table
  -- `task_sinks(task_id, event, url)`, mirroring `task_triggers`.
  sink_url text not null default '',
  sink_on text not null default 'failed' check (sink_on in ('failed', 'always')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_name_len check (char_length(name) <= 120),
  constraint tasks_sink_url_len check (char_length(sink_url) <= 500),
  constraint tasks_runtime_len check (char_length(runtime) between 1 and 60),
  constraint tasks_entrypoint_len check (char_length(entrypoint) <= 200),
  -- Entrypoint must be AMONG the files, otherwise the task cannot run.
  constraint tasks_entrypoint_in_files check (files ? entrypoint),
  constraint tasks_files_not_empty check (files <> '{}'::jsonb)
);

-- Task triggers ---------------------------------------------------------------
-- A SEPARATE table, because the trigger is a dimension along which a task multiplies.
create table public.task_triggers (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  kind text not null check (kind in ('cron', 'webhook')),
  -- cron trigger: expression + materialized next time (due marker, like
  -- points.next_scan_at — ADR-015). Expression validity is checked by the BFF
  -- (server/utils/cron.ts) — SQL has no parser.
  cron text,
  next_run_at timestamptz,
  -- BFF downtime: an overdue slot runs ONCE ('run') or only
  -- moves the time ('skip'); the next time is always from now → zero backlog burst.
  misfire_policy text not null default 'run' check (misfire_policy in ('run', 'skip')),
  -- webhook trigger: the raw token is shown ONCE at creation, the DB holds a hash.
  token_hash text,
  sync boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  -- Shape depends on kind: cron needs an expression, webhook a token hash.
  constraint task_triggers_cron_shape check (
    kind <> 'cron' or (cron is not null and next_run_at is not null)
  ),
  constraint task_triggers_webhook_shape check (
    kind <> 'webhook' or token_hash is not null
  )
);

-- The tick selects due triggers: index only on enabled ones (like the drift-inbox partial).
create index task_triggers_due on public.task_triggers (next_run_at)
  where enabled and kind = 'cron';
create index task_triggers_task_id on public.task_triggers (task_id);
-- The token is an entry point, looked up on every webhook.
create unique index task_triggers_token_hash on public.task_triggers (token_hash)
  where token_hash is not null;

-- task_run: tasks on top of the generic substrate (ADR-011) ---------------------
alter table public.task_run add column task_id uuid references public.tasks (id) on delete set null;
-- Run phase: 'preparing_env' is visible separately from 'running'.
alter table public.task_run add column phase text;
-- Truncated TAIL of the log (the full log goes to artifacts).
-- Grows during the run → the client sees progress via Realtime.
alter table public.task_run add column log text;
-- Attempt number: retries are separate rows, visible in the run detail.
alter table public.task_run add column attempt int not null default 1;
-- Webhook idempotency key: a repeat with the same key does not create a run.
alter table public.task_run add column idempotency_key text;

create index task_run_task_id on public.task_run (task_id, started_at desc);
create unique index task_run_idempotency
  on public.task_run (task_id, idempotency_key)
  where idempotency_key is not null;

-- 'skipped' is a RESULT, not silence: overlaps are visible in the log.
alter table public.task_run drop constraint task_run_status_check;
alter table public.task_run add constraint task_run_status_check
  check (status in ('running', 'done', 'failed', 'skipped'));

-- RLS -------------------------------------------------------------------------
alter table public.tasks enable row level security;
alter table public.task_triggers enable row level security;

-- Reading definitions — require-profile (like point_contacts/runbooks). There is NO
-- write policy → deny-by-default, only service_role writes, via the BFF (ADR-013).
create policy "read tasks requires profile" on public.tasks
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = auth.uid()));

-- Only admin reads triggers: `token_hash` is not a secret by itself, but an operator
-- has no need for the list of entry points (deny-by-default).
create policy "read task_triggers admin only" on public.task_triggers
  for select to authenticated
  using (exists (
    select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'admin'
  ));

-- task_run policy REISSUED. It was: actor = jwt email — i.e. a scheduler
-- run (actor='scheduler') belongs to NOBODY and would be visible to
-- nobody, and admin would not see others' runs. Now: own runs — everyone, all runs — admin.
drop policy task_run_own on public.task_run;
create policy task_run_own_or_admin on public.task_run
  for select to authenticated using (
    actor = (auth.jwt() ->> 'email')
    or exists (
      select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'admin'
    )
  );

-- Run artifacts ---------------------------------------------------------------
-- One row = ONE file (not "a set with files" — the mirror side of the model dimensions).
create table public.task_artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.task_run (id) on delete cascade,
  path text not null,                      -- path in the task-artifacts bucket
  size bigint not null default 0,
  content_type text,
  created_at timestamptz not null default now(),
  constraint task_artifacts_path_len check (char_length(path) <= 400)
);

create index task_artifacts_run_id on public.task_artifacts (run_id);
create unique index task_artifacts_uni on public.task_artifacts (run_id, path);

alter table public.task_artifacts enable row level security;
-- Artifact visibility = visibility of its run (same policy, no duplicated rules).
create policy "read task_artifacts follows run" on public.task_artifacts
  for select to authenticated using (
    exists (select 1 from public.task_run r where r.id = run_id)
  );

-- Realtime: the run detail listens to UPDATE of its row (the log grows).
-- `task_run` is already in the publication since 0005 — not added again.

-- Storage bucket for artifacts: PRIVATE (download only via the BFF —
-- RBAC + signed URL).
insert into storage.buckets (id, name, public)
values ('task-artifacts', 'task-artifacts', false)
on conflict (id) do nothing;
