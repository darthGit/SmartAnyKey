-- 0014: runbooks + point note limit (tier Mid).
-- Runbook = a "how to fix X" procedure, bound per device type (applies to all
-- devices of the type) with an optional point override (point-specific). Both fks
-- nullable: type-only (point_id null), point-only (type_id null), or narrowed
-- (both). Body is markdown text, rendered admin-trusted (marked, no sanitize).
create table public.runbooks (
  id uuid primary key default gen_random_uuid(),
  type_id uuid references public.device_types (id) on delete cascade,
  point_id uuid references public.points (id) on delete cascade,
  title text not null,
  body text not null,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index runbooks_type_id_idx on public.runbooks (type_id);
create index runbooks_point_id_idx on public.runbooks (point_id);

alter table public.runbooks enable row level security;
-- Read — require-profile (like device_commands/points, 0009). Writes only by
-- service_role (admin BFF routes) — no write policy → deny-by-default.
create policy "read runbooks requires profile" on public.runbooks
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = auth.uid()));

-- Point note limit: operator memory, not a document (long text = runbook).
-- 2000 is the DB ceiling; duplicated in zod (BFF) + maxlength (client). Tuned by changing it here.
alter table public.points
  add constraint points_note_len check (char_length(note) <= 2000);
