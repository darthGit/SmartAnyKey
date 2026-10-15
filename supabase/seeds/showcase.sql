-- SHOWCASE FIXTURE: a fictional company with a dozen branch offices, for the README
-- media and the demo install. Every name, address and number here is invented
-- (phone numbers use the 555-01xx range reserved for fiction).
--
--   node scripts/seed-showcase.mjs     # this file + encrypted credentials + bindings
--
-- Not a product default, same as dev.sql: a real installation starts empty and the
-- client builds their own taxonomy. Devices reach the demo LAN (`corp.lan`, see
-- docker/docker-compose.dev.yml): branch 142 by IP — that is the branch the scan is
-- shown on — and the rest by DNS names that resolve to the same demo containers.
-- A few hosts resolve to nothing on purpose, so health checks show a mixed picture.
--
-- Idempotent: `on conflict` where a unique key exists, `not exists` guards elsewhere.

-- ── 1. Taxonomy ─────────────────────────────────────────────────────────────
insert into public.device_types (slug, name, icon, color, default_action, sort) values
  ('gateway',     'Branch router',   '🛜', '#dc2626', 'ssh', 10),
  ('front-desk',  'Front desk',      '🖥️', '#2563eb', 'vnc', 20),
  ('back-office', 'Back office PC',  '💼', '#059669', 'rdp', 30),
  ('signage',     'Signage player',  '📺', '#d97706', 'ssh', 40),
  ('printer',     'Printer',         '🖨️', '#6b7280', 'web', 50),
  ('nvr',         'Video recorder',  '📹', '#7c3aed', 'web', 60)
on conflict (slug) do nothing;

-- ── 2. Branches ─────────────────────────────────────────────────────────────
insert into public.points (number, address, subnet, note)
select b.number, b.address, b.subnet::cidr, b.note
from (values
  (101, '14 Harbor Road, Eastport',          '10.42.101.0/26', null),
  (104, '2 Mill Street, Eastport',           '10.42.104.0/26', null),
  (117, '88 Northgate Avenue, Linden',       '10.42.117.0/26', 'Opens at 10:00 on Mondays.'),
  (123, '5 Orchard Lane, Linden',            '10.42.123.0/26', null),
  (128, '310 River Drive, Ashford',          '10.42.128.0/26', null),
  (135, '41 Station Square, Ashford',        '10.42.135.0/26', 'Shares the building with a bank — call before an on-site visit.'),
  (142, '27 Maple Avenue, Westbrook',        '10.42.142.0/26', E'Busiest branch. A router reboot fixes most "no internet" calls.\nAlarm code: ask the branch manager.'),
  (150, '9 Quarry Road, Westbrook',          '10.42.150.0/26', null),
  (163, '120 Kings Parade, Fairview',        '10.42.163.0/26', 'Back office PC is being replaced — expect it offline.'),
  (171, '3 Chapel Street, Fairview',         '10.42.171.0/26', null),
  (188, '66 Bridge End, Marlow',             '10.42.188.0/26', 'ISP outage reported, ticket open with the provider.'),
  (205, '1 Airport Way, Marlow',             '10.42.205.0/26', null)
) as b(number, address, subnet, note)
on conflict (number) do nothing;

-- ── 3. Contacts (who calls the help desk) ───────────────────────────────────
insert into public.point_contacts (point_id, kind, value, label, sort)
select p.id, c.kind, c.value, c.label, c.sort
from (values
  (101, 'phone', '+1 555 0101', 'Branch line',    10),
  (104, 'phone', '+1 555 0104', 'Branch line',    10),
  (117, 'phone', '+1 555 0117', 'Branch line',    10),
  (123, 'phone', '+1 555 0123', 'Branch line',    10),
  (128, 'phone', '+1 555 0128', 'Branch line',    10),
  (135, 'phone', '+1 555 0135', 'Branch line',    10),
  (142, 'phone', '+1 555 0142', 'Branch line',    10),
  (142, 'phone', '+1 555 0199', 'Manager, Dana',  20),
  (142, 'email', 'branch142@example.com', null,   30),
  (150, 'phone', '+1 555 0150', 'Branch line',    10),
  (163, 'phone', '+1 555 0163', 'Branch line',    10),
  (171, 'phone', '+1 555 0171', 'Branch line',    10),
  (188, 'phone', '+1 555 0188', 'Branch line',    10),
  (205, 'phone', '+1 555 0105', 'Branch line',    10)
) as c(number, kind, value, label, sort)
join public.points p on p.number = c.number
on conflict (point_id, kind, value_norm) do nothing;

-- ── 4. Devices ──────────────────────────────────────────────────────────────
-- Branch 142 knows only part of its LAN: the scan proposes the signage player,
-- printer and recorder as new, and the old printer at .45 comes up missing.
insert into public.devices (point_id, type_id, label, host, actions, sort)
select p.id, t.id, d.label, d.host, d.actions, d.sort
from (values
  (142, 'gateway',     'Router',        '10.42.142.1',  array['ssh'], 10),
  (142, 'front-desk',  'Front desk',    '10.42.142.11', array['vnc'], 20),
  (142, 'back-office', 'Back office',   '10.42.142.21', array['rdp'], 30),
  (142, 'printer',     'Old printer',   '10.42.142.45', array['web'], 60)
) as d(number, type_slug, label, host, actions, sort)
join public.points p on p.number = d.number
join public.device_types t on t.slug = d.type_slug
where not exists (
  select 1 from public.devices x where x.point_id = p.id and x.label = d.label
);

-- Every other branch: the same four roles by name; printers and recorders on some.
-- Branch 188 has no router name (ISP outage), 163 no back-office name (replacement).
insert into public.devices (point_id, type_id, label, host, actions, sort)
select p.id, t.id, r.label, r.host_prefix || '.b' || p.number || '.corp.lan', r.actions, r.sort
from public.points p
cross join (values
  ('gateway',     'Router',      'gw',      array['ssh'], 10),
  ('front-desk',  'Front desk',  'desk',    array['vnc'], 20),
  ('back-office', 'Back office', 'office',  array['rdp'], 30),
  ('signage',     'Signage',     'signage', array['ssh'], 40)
) as r(type_slug, label, host_prefix, actions, sort)
join public.device_types t on t.slug = r.type_slug
where p.number <> 142 and p.number between 101 and 205
  and not exists (select 1 from public.devices x where x.point_id = p.id and x.label = r.label);

insert into public.devices (point_id, type_id, label, host, actions, sort)
select p.id, t.id, r.label, r.host_prefix || '.b' || p.number || '.corp.lan', r.actions, r.sort
from public.points p
cross join (values
  ('printer', 'Printer',        'printer', array['web'], 50),
  ('nvr',     'Video recorder', 'nvr',     array['web'], 60)
) as r(type_slug, label, host_prefix, actions, sort)
join public.device_types t on t.slug = r.type_slug
where p.number in (101, 117, 135, 150, 171)
  and not exists (select 1 from public.devices x where x.point_id = p.id and x.label = r.label);

-- ── 5. Auto-discovery rules (what a port pattern means on THIS network) ─────
insert into public.device_type_signatures (type_id, signal_type, pattern, weight)
select t.id, s.signal_type, s.pattern, s.weight
from (values
  ('gateway',     'port', '53',   60),
  ('gateway',     'port', '80',   30),
  ('gateway',     'port', '22',   30),
  ('front-desk',  'port', '5901', 80),
  ('back-office', 'port', '3389', 80),
  ('signage',     'port', '22',   50),
  ('printer',     'port', '9100', 80),
  ('printer',     'port', '80',   20),
  ('nvr',         'port', '8080', 60),
  ('nvr',         'port', '80',   20)
) as s(type_slug, signal_type, pattern, weight)
join public.device_types t on t.slug = s.type_slug
where not exists (
  select 1 from public.device_type_signatures x
  where x.type_id = t.id and x.signal_type = s.signal_type and x.pattern = s.pattern
);

-- ── 6. Commands in the device menu ──────────────────────────────────────────
insert into public.device_commands (type_id, name, body, interpreter, confirm, timeout_s, sort)
select t.id, c.name, c.body, 'raw', c.confirm, 15, c.sort
from (values
  ('gateway', 'Interfaces',     'ip -4 addr show eth0', false, 10),
  ('gateway', 'Uptime',         'uptime',             false, 20),
  ('signage', 'Disk usage',     'df -h /',            false, 10),
  ('signage', 'Restart player', 'echo "player restarted at $(date +%H:%M)"', true, 20)
) as c(type_slug, name, body, confirm, sort)
join public.device_types t on t.slug = c.type_slug
where not exists (
  select 1 from public.device_commands x where x.type_id = t.id and x.name = c.name
);

-- ── 7. Runbooks ─────────────────────────────────────────────────────────────
insert into public.runbooks (type_id, point_id, title, body, sort)
select t.id, null, r.title, r.body, r.sort
from (values
  ('gateway', 'No internet at the branch', E'1. Open the router terminal and run **Interfaces**.\n2. WAN down → reboot the router, wait 3 minutes.\n3. Still down → open a ticket with the ISP, branch line in the contacts.', 10),
  ('front-desk', 'Front desk frozen', E'1. Open the session — if the screen answers, close the stuck app.\n2. No answer → ask the branch to hold the power button for 10 s.', 20),
  ('printer', 'Printer offline', E'1. Check it in the scan of the branch — port 9100 must be open.\n2. Ask the branch to check paper and the network cable.', 30)
) as r(type_slug, title, body, sort)
join public.device_types t on t.slug = r.type_slug
where not exists (select 1 from public.runbooks x where x.title = r.title);

-- ── 8. A scheduled task with a visible log ──────────────────────────────────
-- Runs only where the installation registers a `bash` runtime (NUXT_TASK_RUNNERS).
insert into public.tasks (name, runtime, entrypoint, files, timeout_s)
select 'Nightly router config backup', 'bash', 'main.sh',
       jsonb_build_object('main.sh', E'for b in 101 104 117 123 128 135 142 150 163 171 188 205; do\n  sleep 1\n  if [ "$b" = 188 ]; then echo "branch $b: router unreachable, skipped"; else echo "branch $b: config saved ($(( RANDOM % 40 + 20 )) KB)"; fi\ndone\necho "done: 11 saved, 1 skipped"\n'),
       120
where not exists (select 1 from public.tasks where name = 'Nightly router config backup');

insert into public.task_triggers (task_id, kind, cron, next_run_at)
select t.id, 'cron', '0 2 * * *', date_trunc('day', now()) + interval '1 day 2 hours'
from public.tasks t
where t.name = 'Nightly router config backup'
  and not exists (select 1 from public.task_triggers x where x.task_id = t.id);
