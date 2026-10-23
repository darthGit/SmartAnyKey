-- At most one running discovery scan per point, whoever starts it (an admin, a second admin,
-- the scheduled rescan). The index is the guarantee: the app inserts and, on a unique
-- violation, returns the run already in progress — no check-then-insert race.
--
-- Not DDL only, on purpose: an install upgraded while two scans of one point were running
-- would fail to create the index, and a failed migration stops the app from starting. So
-- the duplicates are closed first — every running scan of a point but the newest becomes
-- failed/stale, the same mark the boot-time reaper uses.
update public.task_run t
set status = 'failed', error = 'stale', finished_at = now()
where t.kind = 'discovery-scan' and t.status = 'running'
  and exists (
    select 1 from public.task_run n
    where n.kind = 'discovery-scan' and n.status = 'running'
      and n.ref_id = t.ref_id and (n.started_at, n.id) > (t.started_at, t.id)
  );

create unique index task_run_one_running_scan on public.task_run (ref_id)
  where kind = 'discovery-scan' and status = 'running';
