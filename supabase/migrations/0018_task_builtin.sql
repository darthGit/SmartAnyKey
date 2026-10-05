-- 0018: built-in task — an action run by the BFF ITSELF, not by a runner
-- (ADR-018 amendment 2026-09-17 #4).
--
-- Why this is not a regular task: the backup is done by `pg_dump`, and the executor image
-- does NOT have it (measured: `which pg_dump psql` in the image → nothing) — postgres client 17
-- is in the `app` image, the `BACKUP_DIR` volume is mounted on `app` too, and ADR-016
-- deliberately keeps zero DB credentials in the runner. So `builtin` = a key in the CODE
-- registry of built-in actions: the list of built-ins is product knowledge (there are as many
-- as we wrote), unlike `NUXT_TASK_RUNNERS`, which is a property of the
-- installation. The rest of the run machinery (task_run, phases, log, retries, overlap,
-- sink, panel) does not change at all.
alter table public.tasks add column builtin text;

alter table public.tasks add constraint tasks_builtin_len
  check (builtin is null or char_length(builtin) between 1 and 60);

-- Files/entrypoint are a RUNNER requirement. A built-in action has neither files nor an
-- environment, so both CHECKs are narrowed to rows without `builtin`.
alter table public.tasks drop constraint tasks_entrypoint_in_files;
alter table public.tasks drop constraint tasks_files_not_empty;
alter table public.tasks add constraint tasks_entrypoint_in_files
  check (builtin is not null or files ? entrypoint);
alter table public.tasks add constraint tasks_files_not_empty
  check (builtin is not null or files <> '{}'::jsonb);

-- One built-in action = one row: two "backups" in the panel is not a choice but a bug.
create unique index tasks_builtin_uniq on public.tasks (builtin) where builtin is not null;

-- Ready-made backup recipe: admin turns it on with a toggle, writing nothing.
-- `enabled=false` on purpose: the backup writes to the installation's disk, and we have no
-- right to turn it on for the client (`BACKUP_DIR` may not be mounted).
-- min_role='admin' — a manual run is admin-only too (the dump = all client data).
insert into public.tasks (name, builtin, runtime, entrypoint, files, timeout_s, min_role, enabled)
values ('Database backup', 'backup', 'builtin', '', '{}'::jsonb, 3600, 'admin', false)
on conflict (name) do nothing;

-- Schedule — nightly at 03:00, and it is ENABLED despite the disabled task: admin
-- must click ONE toggle, not two. This is safe by construction —
-- the tick takes the trigger, moves the time and runs nothing on a disabled task
-- (`dispatchDueTriggers`: `if (!task || !task.enabled) continue`).
-- `next_run_at` in the past is safe too: an overdue slot with misfire='skip'
-- only moves the time to the next 03:00 (zero backlog burst — ADR-018).
insert into public.task_triggers (task_id, kind, cron, next_run_at, misfire_policy, enabled)
select id, 'cron', '0 3 * * *', now(), 'skip', true
from public.tasks where builtin = 'backup'
on conflict do nothing;
