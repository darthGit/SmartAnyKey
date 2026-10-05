-- 0013: on-demand health (ADR-005 L0).
-- Cache of the device's latest TCP-probe state, keyed by (device_id, action) —
-- VNC up / SSH down on one device = different ports, different rows
-- (state is per protocol). v1 Mid writes only the default action; the key leaves
-- room for all actions without a migration.
create table public.device_status (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices (id) on delete cascade,
  action text not null,
  status text not null check (status in ('up', 'down', 'unknown')),
  latency_ms int,
  error text,
  checked_at timestamptz not null default now(),
  unique (device_id, action)
);
create index device_status_device_id_idx on public.device_status (device_id);

alter table public.device_status enable row level security;
-- Reading the cached status — any authenticated user (like devices/points).
-- Writes only by service_role (BFF probe route) — no write policy → deny.
create policy "authenticated read device_status"
  on public.device_status for select to authenticated using (true);
