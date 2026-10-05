-- 0012: Custom tasks Phase 2 core.
-- Three orthogonal axes on top of the ssh-commands substrate (ADR-011), no rewrite:
--   1. device_commands.target — ssh (existing conn.exec) | local (executor service, ADR-016).
--   2. Variables via env from two sources: free-form devices.meta + a form (device_commands.params).
--   3. Secrets (API key) via credential_sets (unbound + resolve-by-id, amends ADR-009);
--      cred_refs declares {set_id, env}. min_role gates RUNNING (authoring = admin).

-- devices.meta: free-form key→value of arbitrary device data (serial, internal id, ...),
-- injected into a local task's env verbatim. NOT for secrets (plaintext jsonb).
alter table public.devices add column meta jsonb not null default '{}'::jsonb;

-- device_commands: execution target + form params + task credentials + min role to run.
alter table public.device_commands
  add column target text not null default 'ssh' check (target in ('ssh', 'local'));
alter table public.device_commands
  add column params jsonb not null default '[]'::jsonb;      -- [{key,label,type?}]
alter table public.device_commands
  add column cred_refs jsonb not null default '[]'::jsonb;   -- [{set_id,env}]
alter table public.device_commands
  add column min_role text not null default 'operator' check (min_role in ('operator', 'admin'));

-- task_run.kind — free text (ADR-011 generic) → 'local-command' without a schema change.
-- RLS unchanged: device_commands select-authenticated/write-service (cred_refs = id+env,
-- not a secret); credential_sets stays deny-all (an unbound set is read only by service_role).

-- Data moved to `supabase/seeds/dev.sql` (migrations = schema only).
-- A fresh install stays empty.
