-- 0018 seeded the built-in backup trigger with `next_run_at = now()`: the first slot is
-- already in the past, so `/setup` showed a "Next run" that had passed until the first
-- tick moved it. Move such a slot to the next 03:00 — the trigger's own cron.
--
-- UTC on purpose: the scheduler computes slots in the app process's local time
-- (`nextRunAt`, server/utils/cron.ts), and the app image runs in UTC.
-- Only a past slot of the untouched built-in trigger is moved: an install whose tick
-- already advanced it, or whose admin changed the cron, is left alone (re-run safe).
update public.task_triggers t
set next_run_at = case
  when (date_trunc('day', now() at time zone 'UTC') + interval '3 hours') at time zone 'UTC' > now()
    then (date_trunc('day', now() at time zone 'UTC') + interval '3 hours') at time zone 'UTC'
  else (date_trunc('day', now() at time zone 'UTC') + interval '1 day 3 hours') at time zone 'UTC'
end
from public.tasks k
where k.id = t.task_id
  and k.builtin = 'backup'
  and t.kind = 'cron'
  and t.cron = '0 3 * * *'
  and t.next_run_at <= now();
