-- 0015: device hostname as an OBSERVED fact (tier Full; ADR-012 amended
-- 2026-08-11). Number 0015 is reserved for this change — see the header of
-- 0017_point_contacts.sql; migrations apply in file-name order.
--
-- Two fields with DIFFERENT owners: `label` — the human caption (edited by a person),
-- `hostname` — what the machine calls itself (written only by us). `label` is
-- NEVER overwritten automatically by this — copying over only by explicit human action.
--
-- Dimensions of the fact (listed before the migration): SOURCE (PTR says what
-- DNS thinks; NSE/SSH — what the machine itself thinks: different trust) and TIME
-- (staleness is visible). Source priority lives in code (`pickHostname`,
-- ssh > nse > ptr), not in the schema: the rank is a domain rule, not a row invariant.
--
-- `hostname_source` — NO enum/CHECK list: the transport is a data dimension, a new one
-- (winrm/agent) must not require a migration (same approach as `tasks.runtime`
-- in 0015_tasks and `point_contacts.kind` in 0017 — no hardcoded lists in the schema).
alter table public.devices
  add column if not exists hostname text,
  add column if not exists hostname_source text,
  add column if not exists hostname_at timestamptz;

-- Identity lookup (`findDevice` matches an observation to a device by name, not
-- by IP). Partial — empty values are not needed in the index.
create index if not exists devices_hostname_idx
  on public.devices (hostname) where hostname is not null;

-- An observation also has TWO name channels, not one: `discovered_hosts.hostname`
-- = reverse-DNS (what DNS thinks), `nse_hostname` = what the machine said about itself
-- (rdp-ntlm-info / smb-os-discovery). One row may have both and they may
-- DIVERGE — hence two columns, not overwriting one (different signals,
-- not different rows).
alter table public.discovered_hosts
  add column if not exists nse_hostname text;

comment on column public.discovered_hosts.nse_hostname is
  'Name the machine reported itself (NSE, no creds). Different from hostname = PTR.';

comment on column public.devices.hostname is
  'Observed machine name (NOT the label). Written by scan/ssh check; label untouched.';
comment on column public.devices.hostname_source is
  'Source: ssh | nse | ptr (free text — ranked in code, pickHostname).';
comment on column public.devices.hostname_at is
  'When captured — so the fact''s staleness is visible.';

-- RLS unchanged: `devices` is already select-for-authenticated (require-profile,
-- 0009), writes — service_role (BFF).
