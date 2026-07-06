# Supabase Phase 2 Rollout Guide

This rollout introduces scalable schema components without breaking the current app.

## Goals

- Keep current `mass_counts` table working.
- Introduce scalable entities: users, roles, events, sections, notes, audit log.
- Prepare for future app features with minimal rework.

## Step 1: Run the schema script

In Supabase SQL Editor, run:

- [docs/supabase-phase2-schema.sql](docs/supabase-phase2-schema.sql)

## Step 2: Optional baseline migration from mass_counts

Run this once to copy current attendance data into new tables:

```sql
with base_church as (
  select church_id
  from public.churches
  order by created_at asc
  limit 1
), upsert_entries as (
  insert into public.attendance_entries (
    church_id,
    attendance_date,
    mass_label,
    total,
    source
  )
  select
    bc.church_id,
    mc.date,
    mc.mass,
    mc.total,
    'migration'
  from public.mass_counts mc
  cross join base_church bc
  on conflict (church_id, attendance_date, mass_label)
  do update set
    total = excluded.total,
    source = 'migration',
    updated_at = now()
  returning attendance_id, attendance_date, mass_label
)
insert into public.attendance_entry_counts (attendance_id, section_id, count_value)
select
  ae.attendance_id,
  s.section_id,
  case s.section_key
    when 'altar' then mc.altar
    when 'left_choir' then mc.left_choir
    when 'right_choir' then mc.right_choir
    when 'left_nave' then mc.left_nave
    when 'right_nave' then mc.right_nave
    when 'balcony' then mc.balcony
    when 'ushers' then mc.ushers
    else 0
  end
from public.mass_counts mc
join base_church bc on true
join public.attendance_entries ae
  on ae.church_id = bc.church_id
 and ae.attendance_date = mc.date
 and ae.mass_label = mc.mass
join public.attendance_sections s on true
on conflict (attendance_id, section_id)
do update set
  count_value = excluded.count_value,
  updated_at = now();
```

## Step 3: Validate data parity

```sql
select count(*) as old_count from public.mass_counts;
select count(*) as new_count from public.attendance_entries;

select
  mc.date,
  mc.mass,
  mc.total as old_total,
  vc.total as view_total
from public.mass_counts mc
left join public.v_mass_counts_compat vc
  on vc.date = mc.date
 and vc.mass = mc.mass
order by mc.date desc, mc.mass asc
limit 50;
```

## Step 4: Keep current app unchanged for now

- Continue using existing app endpoints on `mass_counts`.
- Build new features against `attendance_entries` + related tables.
- Switch app write path only when phase-2 UI/API is ready.

## Step 5: Recommended next implementation slices

1. Auth and role assignment UI for `app_users` + `user_roles`.
2. Event planning UI for `events` and `mass_slots`.
3. Per-entry notes UI using `attendance_notes`.
4. Admin audit viewer from `audit_log`.
5. New API endpoints that read/write `attendance_entries` and counts.

## Safety

- Keep using snapshot and rollback process in:
  - [docs/supabase-admin-runbook.md](docs/supabase-admin-runbook.md)
- Keep 25-version controls from:
  - [docs/supabase-versioning.sql](docs/supabase-versioning.sql)
