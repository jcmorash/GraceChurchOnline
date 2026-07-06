-- Phase 2 scalable schema for attendance platform
-- Additive migration: keeps existing public.mass_counts running.
-- Run in Supabase SQL Editor.

create extension if not exists pgcrypto;

-- Timestamp helper
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Core reference tables
create table if not exists public.churches (
  church_id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  timezone text not null default 'America/New_York',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_churches_updated_at on public.churches;
create trigger trg_churches_updated_at
before update on public.churches
for each row execute function public.set_updated_at();

create table if not exists public.app_users (
  user_id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  email text unique,
  display_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_app_users_updated_at on public.app_users;
create trigger trg_app_users_updated_at
before update on public.app_users
for each row execute function public.set_updated_at();

create table if not exists public.roles (
  role_id uuid primary key default gen_random_uuid(),
  role_key text not null unique,
  description text,
  created_at timestamptz not null default now()
);

insert into public.roles (role_key, description)
values
  ('admin', 'Full admin access'),
  ('counter', 'Can enter attendance counts'),
  ('viewer', 'Read-only analytics and reports')
on conflict (role_key) do nothing;

create table if not exists public.user_roles (
  user_role_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(user_id) on delete cascade,
  role_id uuid not null references public.roles(role_id) on delete cascade,
  church_id uuid references public.churches(church_id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, role_id, church_id)
);

create index if not exists idx_user_roles_user on public.user_roles (user_id);
create index if not exists idx_user_roles_church on public.user_roles (church_id);

-- Event and schedule layer
create table if not exists public.events (
  event_id uuid primary key default gen_random_uuid(),
  church_id uuid not null references public.churches(church_id) on delete cascade,
  event_date date not null,
  event_name text not null default 'Weekend Mass',
  liturgical_season text,
  notes text,
  created_by uuid references public.app_users(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (church_id, event_date, event_name)
);

drop trigger if exists trg_events_updated_at on public.events;
create trigger trg_events_updated_at
before update on public.events
for each row execute function public.set_updated_at();

create index if not exists idx_events_church_date on public.events (church_id, event_date desc);

create table if not exists public.mass_slots (
  mass_slot_id uuid primary key default gen_random_uuid(),
  church_id uuid not null references public.churches(church_id) on delete cascade,
  slot_key text not null,
  display_name text not null,
  default_sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (church_id, slot_key),
  unique (church_id, display_name)
);

drop trigger if exists trg_mass_slots_updated_at on public.mass_slots;
create trigger trg_mass_slots_updated_at
before update on public.mass_slots
for each row execute function public.set_updated_at();

create index if not exists idx_mass_slots_active on public.mass_slots (church_id, active, default_sort_order);

create table if not exists public.attendance_sections (
  section_id uuid primary key default gen_random_uuid(),
  section_key text not null unique,
  display_name text not null,
  default_sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

insert into public.attendance_sections (section_key, display_name, default_sort_order)
values
  ('altar', 'Altar', 10),
  ('left_choir', 'Left Choir', 20),
  ('right_choir', 'Right Choir', 30),
  ('left_nave', 'Left Nave', 40),
  ('right_nave', 'Right Nave', 50),
  ('balcony', 'Balcony', 60),
  ('ushers', 'Ushers', 70)
on conflict (section_key) do nothing;

-- Attendance data model
create table if not exists public.attendance_entries (
  attendance_id uuid primary key default gen_random_uuid(),
  church_id uuid not null references public.churches(church_id) on delete cascade,
  event_id uuid references public.events(event_id) on delete set null,
  attendance_date date not null,
  mass_slot_id uuid references public.mass_slots(mass_slot_id) on delete set null,
  mass_label text not null,
  total integer not null default 0,
  entered_by uuid references public.app_users(user_id),
  source text not null default 'app' check (source in ('app', 'csv_import', 'migration', 'api')),
  version_no integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (church_id, attendance_date, mass_label)
);

drop trigger if exists trg_attendance_entries_updated_at on public.attendance_entries;
create trigger trg_attendance_entries_updated_at
before update on public.attendance_entries
for each row execute function public.set_updated_at();

create index if not exists idx_attendance_entries_lookup
  on public.attendance_entries (church_id, attendance_date desc, mass_label);

create table if not exists public.attendance_entry_counts (
  attendance_count_id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.attendance_entries(attendance_id) on delete cascade,
  section_id uuid not null references public.attendance_sections(section_id) on delete restrict,
  count_value integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (attendance_id, section_id)
);

drop trigger if exists trg_attendance_entry_counts_updated_at on public.attendance_entry_counts;
create trigger trg_attendance_entry_counts_updated_at
before update on public.attendance_entry_counts
for each row execute function public.set_updated_at();

create index if not exists idx_attendance_entry_counts_attendance
  on public.attendance_entry_counts (attendance_id);

create table if not exists public.attendance_notes (
  attendance_note_id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.attendance_entries(attendance_id) on delete cascade,
  note_text text not null,
  created_by uuid references public.app_users(user_id),
  created_at timestamptz not null default now()
);

create index if not exists idx_attendance_notes_attendance
  on public.attendance_notes (attendance_id, created_at desc);

-- Audit log (general purpose)
create table if not exists public.audit_log (
  audit_id bigserial primary key,
  table_name text not null,
  row_pk text not null,
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  old_data jsonb,
  new_data jsonb,
  changed_by text,
  changed_at timestamptz not null default now()
);

create index if not exists idx_audit_log_table_time
  on public.audit_log (table_name, changed_at desc);

-- Audit trigger for attendance entries
create or replace function public.audit_attendance_entries_changes()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (table_name, row_pk, operation, old_data, new_data, changed_by)
    values ('attendance_entries', new.attendance_id::text, 'INSERT', null, to_jsonb(new), auth.uid()::text);
    return new;
  elsif tg_op = 'UPDATE' then
    insert into public.audit_log (table_name, row_pk, operation, old_data, new_data, changed_by)
    values ('attendance_entries', new.attendance_id::text, 'UPDATE', to_jsonb(old), to_jsonb(new), auth.uid()::text);
    return new;
  else
    insert into public.audit_log (table_name, row_pk, operation, old_data, new_data, changed_by)
    values ('attendance_entries', old.attendance_id::text, 'DELETE', to_jsonb(old), null, auth.uid()::text);
    return old;
  end if;
end;
$$;

drop trigger if exists trg_attendance_entries_audit on public.attendance_entries;
create trigger trg_attendance_entries_audit
after insert or update or delete on public.attendance_entries
for each row execute function public.audit_attendance_entries_changes();

-- Compatibility view for current app shape (optional)
create or replace view public.v_mass_counts_compat as
select
  ae.attendance_date as date,
  ae.mass_label as mass,
  coalesce(max(case when s.section_key = 'altar' then c.count_value end), 0)::integer as altar,
  coalesce(max(case when s.section_key = 'left_choir' then c.count_value end), 0)::integer as left_choir,
  coalesce(max(case when s.section_key = 'right_choir' then c.count_value end), 0)::integer as right_choir,
  coalesce(max(case when s.section_key = 'left_nave' then c.count_value end), 0)::integer as left_nave,
  coalesce(max(case when s.section_key = 'right_nave' then c.count_value end), 0)::integer as right_nave,
  coalesce(max(case when s.section_key = 'balcony' then c.count_value end), 0)::integer as balcony,
  coalesce(max(case when s.section_key = 'ushers' then c.count_value end), 0)::integer as ushers,
  ae.total
from public.attendance_entries ae
left join public.attendance_entry_counts c on c.attendance_id = ae.attendance_id
left join public.attendance_sections s on s.section_id = c.section_id
group by ae.attendance_id, ae.attendance_date, ae.mass_label, ae.total;

-- Seed baseline church and mass slots if no church exists yet
insert into public.churches (code, name)
select 'grace-main', 'Grace Church'
where not exists (select 1 from public.churches);

with c as (
  select church_id from public.churches order by created_at asc limit 1
)
insert into public.mass_slots (church_id, slot_key, display_name, default_sort_order)
select c.church_id, x.slot_key, x.display_name, x.default_sort_order
from c
join (
  values
    ('0745', '7:45', 10),
    ('0900', '9:00', 20),
    ('1030', '10:30', 30),
    ('special', 'Special', 90)
) as x(slot_key, display_name, default_sort_order) on true
on conflict (church_id, slot_key) do nothing;
