-- 0006: Auto-discovery (v1 core loop).
-- Two tables, zero changes to existing devices/points/device_types (no backward-compat impact).
--
-- device_type_signatures — the CLIENT'S RULES: what a domain-neutral signal (port,
-- banner, cert-CN, ssh-hostkey, OS-guess) MEANS for the client's own device_types.
-- Ships EMPTY — zero domain defaults (pilot data validates the engine,
-- it is not a product default). A fresh install classifies everything as "unknown" until rules exist.
--
-- discovered_hosts — observations from the point's latest scan (propose-don't-write:
-- a scan NEVER writes to devices, it only proposes; a human confirms).

create table public.device_type_signatures (
  id uuid primary key default gen_random_uuid(),
  type_id uuid not null references public.device_types (id) on delete cascade,
  -- 5 signal types: ip_range→CIDR; port→number; banner/cert/os→regex.
  signal_type text not null check (signal_type in ('ip_range', 'port', 'banner', 'cert', 'os')),
  pattern text not null,               -- CIDR | port number | regex (depending on signal_type)
  -- regex capture group → where to map it (point number / hostname); null = no capture
  capture_target text check (capture_target in ('hostname', 'point_number')),
  confidence int not null default 50 check (confidence between 0 and 100),
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index device_type_signatures_type on public.device_type_signatures (type_id, sort);
alter table public.device_type_signatures enable row level security;
-- rules are not a secret (like device_commands): every authenticated user reads; the BFF writes.
create policy device_type_signatures_read on public.device_type_signatures
  for select to authenticated using (true);

create table public.discovered_hosts (
  id uuid primary key default gen_random_uuid(),
  point_id uuid not null references public.points (id) on delete cascade,
  scan_run_id uuid references public.task_run (id) on delete cascade,  -- the scan that produced it (kind=discovery-scan)
  -- ip/hostname — text (like devices.host); identity via STABLE signals, not IP
  ip text not null,
  hostname text,
  open_ports jsonb,                    -- [{port, proto, service, product, version, banner}]
  ssh_hostkey text,                    -- fingerprint (ssh-hostkey NSE) — stable identifier
  tls_cert_sha256 text,                -- ssl-cert NSE — stable identifier
  tls_cert_cn text,                    -- CN/SAN signal for cert rules
  os_guess text,                       -- privileged only (-O); null when unprivileged
  proposed_type_id uuid references public.device_types (id) on delete set null,  -- null = unknown
  confidence int,                      -- 0-100; null for unknown
  -- host-backed reconcile statuses; Missing is derived (device without a host), computed on read
  reconcile_status text check (reconcile_status in ('new', 'matched', 'changed', 'rogue')),
  matched_device_id uuid references public.devices (id) on delete set null,
  observed_at timestamptz not null default now()
);
create index discovered_hosts_point on public.discovered_hosts (point_id, observed_at desc);
alter table public.discovered_hosts enable row level security;
-- observations are not a secret (like device_commands): authenticated users read; the BFF writes.
create policy discovered_hosts_read on public.discovered_hosts
  for select to authenticated using (true);

-- Deliberately NO seed: device_type_signatures stays empty.
