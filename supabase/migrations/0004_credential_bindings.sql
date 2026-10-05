-- 0004: per-protocol credential resolve (amendment to ADR-009). On one device
-- VNC/SSH/RDP always have different credentials, so a set binding is now keyed
-- by action.
--
-- credential_bindings replaces the scalar cred_set_id on 3 tables. target_id is
-- polymorphic (device/type/point, null for global), hence NO FK to the target
-- (orphaned bindings after a target is deleted are cleaned up by the app; rare).

create table public.credential_bindings (
  id uuid primary key default gen_random_uuid(),
  level text not null check (level in ('device', 'type', 'point', 'global')),
  target_id uuid,                       -- null only for level='global'
  action text not null check (action in ('vnc', 'rdp', 'ssh')),
  cred_set_id uuid not null references public.credential_sets (id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((level = 'global') = (target_id is null))
);
-- Exactly one binding per (level, target, action). For global (target_id null)
-- a plain unique does not catch NULL duplicates → separate partial-unique on (action).
create unique index credential_bindings_uni
  on public.credential_bindings (level, target_id, action) where target_id is not null;
create unique index credential_bindings_global_uni
  on public.credential_bindings (action) where level = 'global';

alter table public.credential_bindings enable row level security; -- deny-all: BFF-only

-- Migrate existing scalar bindings → bindings rows. Action = default_action of
-- the matching type (the only deterministic signal at the data level). A device with
-- several actions and one old set gets a binding only for the default —
-- other actions resolve to null (session without password, no crash); the admin fills them in.
insert into public.credential_bindings (level, target_id, action, cred_set_id)
select 'device', d.id, dt.default_action, d.cred_set_id
from public.devices d join public.device_types dt on dt.id = d.type_id
where d.cred_set_id is not null and dt.default_action in ('vnc', 'rdp', 'ssh');

insert into public.credential_bindings (level, target_id, action, cred_set_id)
select 'type', dt.id, dt.default_action, dt.cred_set_id
from public.device_types dt
where dt.cred_set_id is not null and dt.default_action in ('vnc', 'rdp', 'ssh');

-- points have no action of their own → take ssh as a safe default (there are no point
-- bindings in dev; in prod the admin rebinds deliberately).
insert into public.credential_bindings (level, target_id, action, cred_set_id)
select 'point', p.id, 'ssh', p.cred_set_id
from public.points p where p.cred_set_id is not null;

alter table public.devices drop column cred_set_id;
alter table public.device_types drop column cred_set_id;
alter table public.points drop column cred_set_id;

-- is_global_default (0003) is superseded: the global default is now a binding of
-- level 'global' per action. Drop the dead column (the partial-unique index goes with it).
alter table public.credential_sets drop column is_global_default;
