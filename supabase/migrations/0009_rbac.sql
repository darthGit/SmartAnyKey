-- RBAC — coarse global roles (ADR-013 pending).
-- profiles 1:1 with auth.users; deny-by-default (no profile → no board, no actions).
-- Action enforcement lives in the BFF (requireRole); here only visibility (RLS) + the model.

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('viewer', 'operator', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
-- a user reads ONLY their own profile (client UX gate for nav); only the BFF (service_role) writes.
create policy profiles_self_read on public.profiles
  for select to authenticated using (user_id = auth.uid());

-- Retrofit of board policies: `using (true)` → require-profile. Coarse roles = no
-- per-point scope (any provisioned user sees the whole board); a user without a
-- profile sees nothing. The real action gate is server-side (BFF).
drop policy if exists "authenticated read device_types" on public.device_types;
create policy "read device_types requires profile" on public.device_types
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = auth.uid()));

drop policy if exists "authenticated read points" on public.points;
create policy "read points requires profile" on public.points
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = auth.uid()));

drop policy if exists "authenticated read devices" on public.devices;
create policy "read devices requires profile" on public.devices
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = auth.uid()));

drop policy if exists device_commands_read on public.device_commands;
create policy device_commands_read on public.device_commands
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = auth.uid()));

-- Data moved to `supabase/seeds/dev.sql` (migrations = schema only).
-- A fresh install stays empty.
-- Prod admin: `scripts/seed-admin.mjs` with env `RBAC_ADMIN_*` (ADR-013).
