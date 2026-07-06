-- Bridge SQL: keep current app (mass_counts) and phase-2 tables in sync
-- Run this in Supabase SQL Editor.

-- 1) Ensure legacy table exists for current app writes
create table if not exists public.mass_counts (
  date date not null,
  mass text not null,
  altar integer not null default 0,
  left_choir integer not null default 0,
  right_choir integer not null default 0,
  left_nave integer not null default 0,
  right_nave integer not null default 0,
  balcony integer not null default 0,
  ushers integer not null default 0,
  total integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mass_counts_pkey primary key (date, mass)
);

-- 2) Keep updated_at current
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_mass_counts_updated_at on public.mass_counts;
create trigger trg_mass_counts_updated_at
before update on public.mass_counts
for each row execute function public.set_updated_at();

-- 3) Mirror mass_counts writes into phase-2 tables
create or replace function public.sync_mass_counts_to_phase2()
returns trigger
language plpgsql
as $$
declare
  v_church_id uuid;
  v_attendance_id uuid;
begin
  select church_id into v_church_id
  from public.churches
  order by created_at asc
  limit 1;

  if v_church_id is null then
    raise exception 'No church found in public.churches';
  end if;

  insert into public.attendance_entries (
    church_id,
    attendance_date,
    mass_label,
    total,
    source
  )
  values (
    v_church_id,
    new.date,
    new.mass,
    new.total,
    'app'
  )
  on conflict (church_id, attendance_date, mass_label)
  do update set
    total = excluded.total,
    source = 'app',
    updated_at = now()
  returning attendance_id into v_attendance_id;

  insert into public.attendance_entry_counts (attendance_id, section_id, count_value)
  select
    v_attendance_id,
    s.section_id,
    case s.section_key
      when 'altar' then new.altar
      when 'left_choir' then new.left_choir
      when 'right_choir' then new.right_choir
      when 'left_nave' then new.left_nave
      when 'right_nave' then new.right_nave
      when 'balcony' then new.balcony
      when 'ushers' then new.ushers
      else 0
    end
  from public.attendance_sections s
  on conflict (attendance_id, section_id)
  do update set
    count_value = excluded.count_value,
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists trg_sync_mass_counts_to_phase2 on public.mass_counts;
create trigger trg_sync_mass_counts_to_phase2
after insert or update on public.mass_counts
for each row execute function public.sync_mass_counts_to_phase2();

-- 4) Optional smoke test insert
insert into public.mass_counts
(date, mass, altar, left_choir, right_choir, left_nave, right_nave, balcony, ushers, total)
values
(current_date, 'Test 9:00', 1, 2, 3, 4, 5, 6, 7, 28)
on conflict (date, mass) do update set
  altar = excluded.altar,
  left_choir = excluded.left_choir,
  right_choir = excluded.right_choir,
  left_nave = excluded.left_nave,
  right_nave = excluded.right_nave,
  balcony = excluded.balcony,
  ushers = excluded.ushers,
  total = excluded.total;

-- 5) Optional smoke test verification
select attendance_date, mass_label, total, source
from public.attendance_entries
where attendance_date = current_date
  and mass_label = 'Test 9:00';
