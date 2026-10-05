-- 0011: scheduled rescan + drift-inbox.
-- Per-point rescan cadence (Nitro scheduled task picks due points — ADR-005 L1,
-- no new service) + drift_events log (reconcile diff over time; discovered_hosts
-- keeps only the latest scan, so drift needs its own table). ADR-015 records the
-- scheduler choice.

-- Per-point schedule. null cadence = no schedule (admin opts a point in). next_scan_at
-- is the due marker the tick selects on; null = never scheduled / not yet due-computed.
alter table public.points add column scan_cadence_minutes int check (scan_cadence_minutes is null or scan_cadence_minutes > 0);
alter table public.points add column next_scan_at timestamptz;

-- drift_events: one row per non-matched reconcile entry per scan. Aggregated
-- into the inbox by point; rogue rows across ≥N distinct scan_run_ids escalate
-- (derived — no separate counter). acknowledged_at null = unresolved (inbox).
create table public.drift_events (
  id uuid primary key default gen_random_uuid(),
  point_id uuid not null references public.points (id) on delete cascade,
  device_id uuid references public.devices (id) on delete set null,   -- changed/missing carry the device
  host_ip text,                                                       -- new/changed/rogue carry the observed IP
  change_type text not null check (change_type in ('new', 'changed', 'missing', 'rogue')),
  scan_run_id uuid references public.task_run (id) on delete set null, -- scan that detected it (kind=discovery-scan|probe)
  detected_at timestamptz not null default now(),
  acknowledged_at timestamptz
);
-- inbox query = unacknowledged, per point.
create index drift_events_unacked on public.drift_events (point_id) where acknowledged_at is null;

alter table public.drift_events enable row level security;
-- Mirror the board tables (0009): read requires a profile (deny-by-default, ADR-013);
-- write is service_role only (BFF), which bypasses RLS. App reads via service_role
-- through the admin-gated inbox route — this policy is defense-in-depth.
create policy drift_events_read on public.drift_events
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = auth.uid()));
