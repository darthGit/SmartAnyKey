-- 0010: Tier-B internal probe (amends ADR-011).
-- Probe = client-authored device_command with purpose='probe', run over the SSH
-- substrate (task_run kind='probe'); its stable output hashes into the device's
-- internal fingerprint (hash + last-raw), the strongest DHCP/OS-reinstall-proof
-- identity key. No new machinery — device_commands + task_run + devices columns.

-- device_commands: purpose splits menu-actions from identity probes; stable marks
-- a probe whose output must be reproducible (run-twice-diff at execution, variant A).
alter table public.device_commands
  add column purpose text not null default 'action' check (purpose in ('action', 'probe'));
alter table public.device_commands
  add column stable boolean not null default false;

-- Tier-B fingerprint lives ON the device (variant A — last-vs-current is enough for
-- drift; history deferred to the drift work). Distinct from Tier-A observation
-- (discovered_hosts.ssh_hostkey): that is external recon, this is authenticated.
alter table public.devices add column probe_fp_hash text;
alter table public.devices add column probe_fp_raw text;
alter table public.devices add column probe_fp_at timestamptz;

-- task_run.kind is free text → 'probe' needs no schema change (ADR-011 generic row).

-- Data moved to `supabase/seeds/dev.sql` (migrations = schema only).
-- A fresh install stays empty.
