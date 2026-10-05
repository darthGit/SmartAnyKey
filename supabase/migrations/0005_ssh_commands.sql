-- 0005: SSH commands/scripts in the context menu (Phase 1 #4).
-- device_commands — definitions bound to a device TYPE (not portable between types).
-- task_run — a GENERIC execution+audit row (seam for Phase 2 custom tasks):
-- kind + result jsonb + input jsonb absorb the SSH command now and flows later,
-- without a schema change. Not merged with device_commands — the definition stays concrete.

create table public.device_commands (
  id uuid primary key default gen_random_uuid(),
  type_id uuid not null references public.device_types (id) on delete cascade,
  name text not null,
  body text not null,
  interpreter text not null default 'raw' check (interpreter in ('raw', 'bash', 'python', 'node')),
  confirm boolean not null default false,
  timeout_s int not null default 45 check (timeout_s > 0 and timeout_s <= 3600),
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index device_commands_type on public.device_commands (type_id, sort);
alter table public.device_commands enable row level security;
-- menu content, not a secret: every authenticated user reads; only the BFF (service_role) writes.
create policy device_commands_read on public.device_commands
  for select to authenticated using (true);

create table public.task_run (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                    -- 'ssh-command' (Phase 2 adds others)
  actor text not null,                   -- email/id of whoever started it
  device_id uuid,                        -- target (null for Phase 2 non-device tasks)
  ref_id uuid,                           -- definition id (device_commands.id); may disappear
  label text not null,                   -- name snapshot (the audit survives deletion of the definition)
  input jsonb,                           -- snapshot of what ran: {body, interpreter}
  status text not null check (status in ('running', 'done', 'failed')),
  result jsonb,                          -- {stdout, stderr, exitCode, durationMs} (truncated); per-step in Phase 2
  error text,                            -- reason when failed: action|auth|host|timeout|error|stale
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index task_run_actor on public.task_run (actor, started_at desc);
alter table public.task_run enable row level security;
-- an actor sees only their own runs (output may be sensitive); only the BFF writes.
create policy task_run_own on public.task_run
  for select to authenticated using (actor = (auth.jwt() ->> 'email'));

-- Realtime: the client modal subscribes to UPDATE of its row (running→done/failed).
alter publication supabase_realtime add table public.task_run;

-- Data moved to `supabase/seeds/dev.sql` (migrations = schema only).
-- A fresh install stays empty.
