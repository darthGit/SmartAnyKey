-- DEMO SCALE: 300 points × 7 devices = 2100 (moved from 0002_seed.sql).
-- Separate from `dev.sql` on purpose: an end-to-end feature check does not need
-- 2100 rows, while perf checks need exactly them.
--
--   pnpm seed:demo        (requires supabase/seeds/dev.sql already applied —
--                          devices reference `device_types`)
--
-- Why this volume matters: `PGRST_DB_MAX_ROWS=1000` silently truncates selects, and
-- it was exactly at 2101 devices that PC/RPi/MikroTik once vanished from the board.
-- So this seed is a regression rig for pagination, not "lots of data
-- for the sake of it".
--
-- ⚠ No domain defaults: the "cash register 1-4 / PC / RPi / MikroTik" labels are PILOT
-- vocabulary, an engine fixture. Not product defaults.
--
-- Idempotent: points — `on conflict (number)`, devices — `not exists`
-- on (point, label), because `devices` has no unique constraint.

insert into public.points (number, address, subnet)
select n,
       'Demo address, Test St., ' || n,
       ('10.' || (n / 256) || '.' || (n % 256) || '.0/24')::cidr
from generate_series(1, 300) as n
on conflict (number) do nothing;

insert into public.devices (point_id, type_id, label, host, actions, sort)
select p.id, t.id, d.label,
       ('10.' || (p.number / 256) || '.' || (p.number % 256) || d.hostsuf),
       d.actions, d.sort
from public.points p
cross join lateral (values
  ('POS 1',       '.11', array['vnc', 'rdp'], 'pos',             10),
  ('POS 2',       '.12', array['vnc', 'rdp'], 'pos',             20),
  ('POS 3',       '.13', array['vnc', 'rdp'], 'pos-self',        30),
  ('POS 4',       '.14', array['vnc', 'rdp'], 'pos-self',        40),
  ('PC',          '.21', array['vnc', 'rdp'], 'pc',              50),
  ('RPi music',   '.31', array['ssh'],        'rpi-music',       60),
  ('MikroTik',    '.1',  array['web', 'ssh'], 'router-mikrotik', 70)
) as d(label, hostsuf, actions, type_slug, sort)
join public.device_types t on t.slug = d.type_slug
where p.number between 1 and 300
  and not exists (
    select 1 from public.devices x where x.point_id = p.id and x.label = d.label
  );

-- Free-form meta (from 0012): a unique SERIAL from the id — differs per device,
-- which validates meta substitution into a command. An already filled meta is not overwritten,
-- otherwise a repeated seed would wipe what admin set by hand.
update public.devices d
  set meta = jsonb_build_object('SERIAL', 'SN-' || left(d.id::text, 8))
  from public.device_types t
  where d.type_id = t.id
    and t.slug = 'rpi-music'
    and (d.meta is null or d.meta = '{}'::jsonb);
