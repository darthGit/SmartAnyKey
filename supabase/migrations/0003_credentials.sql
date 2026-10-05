-- 0003: Credential manager (ADR-009).
-- Reusable named sets + binding at 4 levels (device/type/point/global)
-- + audit log. The password is stored ENCRYPTED (bytea = iv|tag|ciphertext,
-- AES-256-GCM app-level) — Postgres never sees plaintext, the key lives outside the DB.
--
-- Data from the old device_credentials is moved by scripts/migrate-credentials.mjs
-- (encryption is done in Node with the key from env), which drops the old table
-- AFTER the move. Only DDL here (SQL has neither the key nor GCM).

create table public.credential_sets (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  username text,
  password_enc bytea,                 -- iv(12)|authTag(16)|ciphertext; NULL = no password
  port int,
  is_global_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one global default (partial-unique among is_global_default=true).
create unique index credential_sets_one_global
  on public.credential_sets (is_global_default) where is_global_default;

-- Binding at 4 levels: nullable FK. on delete set null — deleting a set does
-- not cascade into devices/types/points, it only removes the binding.
alter table public.devices
  add column cred_set_id uuid references public.credential_sets (id) on delete set null;
alter table public.device_types
  add column cred_set_id uuid references public.credential_sets (id) on delete set null;
alter table public.points
  add column cred_set_id uuid references public.credential_sets (id) on delete set null;

create table public.credential_access_log (
  id uuid primary key default gen_random_uuid(),
  actor text not null,                -- user email from the Supabase session
  device_id uuid references public.devices (id) on delete set null,
  cred_set_id uuid references public.credential_sets (id) on delete set null,
  action text not null check (action in ('resolve', 'copy')),
  at timestamptz not null default now()
);
create index credential_access_log_device_idx
  on public.credential_access_log (device_id, at desc);

-- RLS deny-all: sets and the log are reachable ONLY by service_role (BFF). The client
-- does not read them directly — set metadata is served by a BFF route (without password_enc).
-- Same pattern as device_credentials had (BFF-only, ADR-002).
alter table public.credential_sets enable row level security;
alter table public.credential_access_log enable row level security;
