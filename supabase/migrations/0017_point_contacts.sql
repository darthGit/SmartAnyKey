-- 0017: point contacts + removal of a dead column (tier Full).
-- One row = ONE contact: a phone, or an email, or anything else. There is no separate
-- "person with channels" entity — a point simply has several contacts.
-- `label` — optional caption ("director", "on duty"), not a mandatory name.
--
-- 0015/0016 were left for work still in draft: scheduled tasks (0015_tasks) and
-- device hostname (0015_device_hostname) — both claimed 0015;
-- migrations apply in file-name order (scripts/db-migrate.mjs).
--
-- No domain defaults: `kind` is FREE text, not an enum. The code knows a render scheme only
-- for kinds the platform has one for (phone→tel:, email→mailto:); Telegram/Viber/
-- radio work without a migration. The list of kinds is client data, not our knowledge.
create table public.point_contacts (
  id uuid primary key default gen_random_uuid(),
  point_id uuid not null references public.points (id) on delete cascade,
  kind text not null,
  value text not null,
  label text,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Normalized value for search/lookup. The 'phone' branch is a MECHANISM
  -- (the same kind we render as tel:), not knowledge about the client.
  -- The length of the "national part" of a number is NOT baked in: tail matching is done by
  -- code via env PHONE_MATCH_TAIL (deployment-specific, belongs in config — 9 is the length of a Ukrainian number).
  value_norm text generated always as (
    case when kind = 'phone'
      then regexp_replace(value, '\D', '', 'g')
      else lower(btrim(value))
    end
  ) stored,
  constraint point_contacts_value_len check (char_length(value) <= 200),
  constraint point_contacts_kind_len check (char_length(kind) <= 30),
  constraint point_contacts_label_len check (label is null or char_length(label) <= 100)
);

create index point_contacts_point_id_idx on public.point_contacts (point_id);
-- For reverse lookup "caller number → point" (roadmap Phase 2, north star).
create index point_contacts_value_norm_idx on public.point_contacts (value_norm);
-- Makes future auto-capture of a number from a PBX webhook idempotent
-- (insert … on conflict do nothing), and the same number cannot be entered twice by hand.
create unique index point_contacts_uni
  on public.point_contacts (point_id, kind, value_norm);

alter table public.point_contacts enable row level security;
-- Read — require-profile (like points/runbooks, 0009/0014). There is NO write
-- policy → deny-by-default: only service_role writes, via the BFF (ADR-013).
create policy "read point_contacts requires profile" on public.point_contacts
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = auth.uid()));

-- Dead column: `points.name` exists since 0001 but is never read or
-- written (app/, server/, tests/, scripts/seed-dev-targets.mjs, 0002_seed.sql).
-- The human label of a point = `address`.
alter table public.points drop column if exists name;
