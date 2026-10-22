-- Protocols on the device type: a type lists every protocol its devices get on creation
-- (discovery confirm, import, manual add), instead of only default_action.
-- Same shape as devices.actions. Empty = "just default_action": existing types, seeds and API
-- clients that insert a type without this column stay valid and behave as before — so no
-- backfill (migrations are DDL only).
alter table public.device_types add column actions text[] not null default '{}';

alter table public.device_types add constraint device_types_actions_check check (
  actions <@ array['vnc', 'rdp', 'ssh', 'web']
  and (cardinality(actions) = 0 or default_action = any (actions))
);

-- The type's effective set, as the app computes it (typeActions).
create or replace function public.type_effective_actions(t public.device_types)
returns text[]
language sql
immutable
as $$
  select case when cardinality(t.actions) = 0 then array[t.default_action] else t.actions end
$$;

-- "Apply to existing": add the type's protocols a device of that type is missing. Adds only —
-- a protocol set by hand on one device stays. Returns how many devices changed (0 on repeat).
create or replace function public.apply_type_actions(p_type_id uuid, p_dry_run boolean default false)
returns integer
language plpgsql
as $$
declare
  want text[];
  n integer;
begin
  select public.type_effective_actions(t) into want from public.device_types t where t.id = p_type_id;
  if want is null then
    return 0;
  end if;
  if p_dry_run then
    select count(*) into n from public.devices d where d.type_id = p_type_id and not (d.actions @> want);
    return n;
  end if;
  update public.devices d
  set actions = array(select distinct unnest(d.actions || want) order by 1)
  where d.type_id = p_type_id and not (d.actions @> want);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Writes devices: BFF (service role) only, like every other device write.
revoke execute on function public.apply_type_actions(uuid, boolean) from public, anon, authenticated;
grant execute on function public.apply_type_actions(uuid, boolean) to service_role;
