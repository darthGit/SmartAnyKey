-- DEV FIXTURE ("migrations = schema only, data = explicit seeds").
-- This file is NOT applied automatically:
-- `db-migrate.mjs` sees only `supabase/migrations/*`, so a fresh install
-- stays EMPTY, without an admin with a known password.
--
--   node scripts/seed-dev.mjs          # the whole dev environment in one command
--   psql -f supabase/seeds/dev.sql     # this file only
--
-- ⚠ No domain defaults: these device types, commands and wording are a PILOT fixture
-- that validates the engine, NOT product defaults. For a client the tables `device_types` /
-- `device_commands` / `device_type_signatures` ship empty, and what
-- signals mean is decided by THEIR data. Do not move anything from here into
-- migrations "for convenience".
--
-- Idempotent: `device_commands` and `devices` have no unique constraints
-- (checked `pg_constraint` 2026-09-04), so they use a `not exists` guard, not
-- `on conflict`.

-- ── 1. Taxonomy ─────────────────────────────────────────────────────────────
insert into public.device_types (slug, name, icon, color, default_action, sort) values
  ('pos',              'Cash register',        'cash-register', '#2563eb', 'vnc', 10),
  ('pos-self',         'Self-checkout',        'self-checkout', '#7c3aed', 'vnc', 20),
  ('pc',               'PC',                   'desktop',       '#059669', 'vnc', 30),
  ('rpi-music',        'RPi (music)',          'music',         '#d97706', 'ssh', 40),
  ('router-mikrotik',  'MikroTik router',      'router',        '#dc2626', 'web', 50)
on conflict (slug) do nothing;

-- ── 2. Dev user: dev@smartanykey.local / devpassword123 ──────────────────────
-- ⚠ GoTrue crashes on NULL in *_token columns ("converting NULL to string is
-- unsupported") — when seeding via SQL they MUST be '' (all 8).
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token,
  email_change, email_change_token_new, email_change_token_current,
  phone_change, phone_change_token, reauthentication_token
)
select
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated', 'dev@smartanykey.local',
  crypt('devpassword123', gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}', '{}',
  '', '', '', '', '', '', '', ''
where not exists (
  select 1 from auth.users where email = 'dev@smartanykey.local'
);

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
)
select gen_random_uuid(), u.id, u.id::text,
       jsonb_build_object('sub', u.id::text, 'email', u.email,
                          'email_verified', true),
       'email', now(), now(), now()
from auth.users u
where u.email = 'dev@smartanykey.local'
  and not exists (
    select 1 from auth.identities i
    where i.user_id = u.id and i.provider = 'email'
  );

-- ── 3. RBAC: dev user → admin (moved from 0009_rbac.sql) ────────────────────
-- The prod admin is created DIFFERENTLY — `scripts/seed-admin.mjs` with `RBAC_ADMIN_*`
-- (the unattended bootstrap). That is exactly why this grant must not live in a migration: it
-- gave EVERY fresh deploy an admin with a publicly known password.
insert into public.profiles (user_id, role)
select id, 'admin' from auth.users where email = 'dev@smartanykey.local'
on conflict (user_id) do nothing;

-- Dev and the test suite sign in as this admin with a password only; the shipped default
-- (2FA required for admins) would send every run to enrollment first. Tests of the policy
-- set it themselves.
update public.app_settings set mfa_required_role = null;

-- ── 4. Dev commands (moved from 0005 / 0010 / 0012) ─────────────────────────
-- The client authors its own commands; this is a fixture for end-to-end checks.
insert into public.device_commands (type_id, name, body, interpreter, confirm, timeout_s, sort)
select t.id, c.name, c.body, c.interpreter, c.confirm, c.timeout_s, c.sort
from (values
  ('rpi-music',       'Uptime',           'uptime',                          'raw',    false, 10, 10),
  ('rpi-music',       'Disk usage',       'df -h',                           'raw',    false, 10, 20),
  ('rpi-music',       'Python version',   'import sys; print(sys.version)',  'python', false, 10, 30),
  ('rpi-music',       'Restart audio',    'systemctl restart music.service', 'raw',    true,  30, 40),
  ('router-mikrotik', 'Interfaces',       '/interface print',                'raw',    false, 15, 10),
  ('router-mikrotik', 'Resources',        '/system resource print',          'raw',    false, 15, 20)
) as c(type_slug, name, body, interpreter, confirm, timeout_s, sort)
join public.device_types t on t.slug = c.type_slug
where not exists (
  select 1 from public.device_commands x where x.type_id = t.id and x.name = c.name
);

-- Tier-B probe fixture (from 0010): machine-id is stable across reboot and
-- reinstall. NOT a domain default — real probes are written by the client.
insert into public.device_commands (type_id, name, body, interpreter, confirm, timeout_s, sort, purpose, stable)
select t.id, 'Machine-id (fingerprint)', 'cat /etc/machine-id', 'raw', false, 10, 100, 'probe', true
from public.device_types t
where t.slug = 'rpi-music'
  and not exists (
    select 1 from public.device_commands x
    where x.type_id = t.id and x.name = 'Machine-id (fingerprint)'
  );

-- ── 5. Unbound credential_set (from 0012) ───────────────────────────────────
-- Demonstrates: a set WITHOUT a binding is valid (task credentials resolve by id).
-- `password_enc` null — the real secret is set by admin
-- via the UI, because encryption needs the runtime key.
insert into public.credential_sets (name, username, password_enc, port)
values ('Task API key (dev)', 'api', null, null)
on conflict (name) do nothing;

-- ── 6. Local command (from 0012): form param + meta + injected secret ──────
insert into public.device_commands
  (type_id, name, body, interpreter, confirm, timeout_s, sort, purpose, stable, target, params, cred_refs, min_role)
select
  t.id,
  'Cash status (HTTP)',
  E'echo "register=$REGISTER serial=$SERIAL"\n# curl -fsS -H "Authorization: Bearer $APIKEY" "$API_URL/status/$REGISTER"',
  'bash', false, 30, 200, 'action', false, 'local',
  '[{"key":"REGISTER","label":"Register #"}]'::jsonb,
  jsonb_build_array(jsonb_build_object('set_id', s.id::text, 'env', 'APIKEY')),
  'operator'
from public.device_types t
cross join (select id from public.credential_sets where name = 'Task API key (dev)') s
where t.slug = 'rpi-music'
  and not exists (
    select 1 from public.device_commands x
    where x.type_id = t.id and x.name = 'Cash status (HTTP)'
  );
