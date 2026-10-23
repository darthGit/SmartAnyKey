-- Second factor (TOTP) enforced by the database, not only by the sign-in form: a token that
-- passed only the password must not read the board straight from PostgREST.
--
-- Who must be at aal2: anyone with a verified factor, and anyone whose role is at or above
-- app_settings.mfa_required_role (null = nobody is forced). The default is 'admin', for new
-- and upgraded installs alike: this database holds credentials to every site.

create table public.app_settings (
  id boolean primary key default true check (id),
  mfa_required_role text default 'admin' check (mfa_required_role in ('viewer', 'operator', 'admin'))
);
insert into public.app_settings default values;

alter table public.app_settings enable row level security;
-- Readable before aal2: the client needs it to send an unenrolled user to enrollment.
create policy app_settings_read on public.app_settings for select to authenticated using (true);

create function public.role_rank(r text) returns int
language sql immutable set search_path = ''
as $$ select case r when 'viewer' then 1 when 'operator' then 2 when 'admin' then 3 else 0 end $$;

-- One answer for the server (via the service role) and for the policies below.
create function public.mfa_state(p_user uuid)
returns table (enrolled boolean, role text, required_role text)
language sql stable security definer set search_path = ''
as $$
  select
    exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified'),
    (select p.role from public.profiles p where p.user_id = p_user),
    (select s.mfa_required_role from public.app_settings s)
$$;
revoke execute on function public.mfa_state(uuid) from public, anon, authenticated;
grant execute on function public.mfa_state(uuid) to service_role;

-- Users with a verified factor, for the admin list (the auth admin API's user list carries no factors).
create function public.mfa_enrolled_users() returns setof uuid
language sql stable security definer set search_path = ''
as $$ select distinct f.user_id from auth.mfa_factors f where f.status = 'verified' $$;
revoke execute on function public.mfa_enrolled_users() from public, anon, authenticated;
grant execute on function public.mfa_enrolled_users() to service_role;

create function public.mfa_ok() returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    or exists (
      select 1 from public.mfa_state(auth.uid()) m
      where not m.enrolled
        and (m.required_role is null or public.role_rank(m.role) < public.role_rank(m.required_role))
    )
$$;

-- Restrictive = AND-ed with the existing read policies, so none of them is rewritten. Every
-- new table the browser reads gets the same line in its own migration (a test lists them).
-- profiles stays out: a user reads their own role before aal2.
do $$
declare t text;
begin
  foreach t in array array[
    'device_commands', 'device_status', 'device_type_signatures', 'device_types', 'devices',
    'discovered_hosts', 'drift_events', 'point_contacts', 'points', 'runbooks',
    'task_artifacts', 'task_run', 'task_triggers', 'tasks'
  ] loop
    execute format(
      'create policy second_factor on public.%I as restrictive for select to authenticated using ((select public.mfa_ok()))', t);
  end loop;
end $$;
