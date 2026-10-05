-- Home page MVP schema (ADR 002).
-- Conventions: device types are a lookup table, the default action is data;
-- credentials are not reachable from the client.

create table public.device_types (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  icon text not null,
  color text not null,
  default_action text not null check (default_action in ('vnc','rdp','ssh','web')),
  sort int not null default 0
);

create table public.points (
  id uuid primary key default gen_random_uuid(),
  number int not null unique,
  name text,
  address text not null,
  subnet cidr not null,
  note text,
  created_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  point_id uuid not null references public.points (id) on delete cascade,
  type_id uuid not null references public.device_types (id),
  label text not null,
  -- host, not inet: an IP in prod, a compose-network hostname in dev fixtures
  host text not null,
  actions text[] not null default '{}',
  default_action text check (default_action in ('vnc','rdp','ssh','web')),
  sort int not null default 0
);

create index devices_point_id_idx on public.devices (point_id);

alter table public.device_types enable row level security;
alter table public.points enable row level security;
alter table public.devices enable row level security;

create policy "authenticated read device_types"
  on public.device_types for select to authenticated using (true);
create policy "authenticated read points"
  on public.points for select to authenticated using (true);
create policy "authenticated read devices"
  on public.devices for select to authenticated using (true);
