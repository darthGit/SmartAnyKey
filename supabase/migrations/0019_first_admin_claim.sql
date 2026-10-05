-- First admin via the `/setup` screen (ADR-021). The route is
-- unauthenticated, so the gate is DB state, and it must be atomic, not
-- "read, then write" in the service.
--
-- ⚠ `insert … where not exists` does NOT hold the race BY ITSELF: under READ COMMITTED
-- two parallel transactions both see "zero admins" and both insert —
-- their `user_id`s differ, so the primary key does not object. Hence
-- `pg_advisory_xact_lock`: the second call waits on the first, and when it proceeds
-- `not exists` is already false, and it gets 0 rows. The lock is transactional, i.e.
-- released by itself; an RPC from supabase-js runs in its own transaction.
--
-- Why not a unique partial index: the product may have many admins
-- (`/admin/users` creates them) — what is unique is not an admin but the moment "no admins
-- yet". That is a property of state, not of a row, so an index cannot express it.
create or replace function public.claim_first_admin(p_user_id uuid)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  perform pg_advisory_xact_lock(hashtext('sak:first-admin'));

  insert into public.profiles (user_id, role)
  select p_user_id, 'admin'
  where not exists (select 1 from public.profiles where role = 'admin');

  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.claim_first_admin(uuid) is
  'Makes the user the FIRST admin if there are no admins yet. Returns 1 (claimed) or 0 (too late). Serialized by an advisory lock.';
