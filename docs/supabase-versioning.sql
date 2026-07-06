-- Supabase versioning for public.mass_counts
-- This script gives you two safety layers:
-- 1) Automatic row history for every UPDATE/DELETE (keeps latest 25 per date+mass)
-- 2) Full-table snapshots you can create on demand (keeps latest 25 snapshots)

create extension if not exists pgcrypto;

-- 1) Row-level history (automatic)
create table if not exists public.mass_counts_history (
  history_id bigserial primary key,
  date date not null,
  mass text not null,
  altar integer not null,
  left_choir integer not null,
  right_choir integer not null,
  left_nave integer not null,
  right_nave integer not null,
  balcony integer not null,
  ushers integer not null,
  total integer not null,
  operation text not null check (operation in ('UPDATE', 'DELETE')),
  changed_at timestamptz not null default now(),
  changed_by text
);

create index if not exists idx_mass_counts_history_lookup
  on public.mass_counts_history (date, mass, changed_at desc);

create or replace function public.capture_mass_counts_history()
returns trigger
language plpgsql
as $$
begin
  insert into public.mass_counts_history (
    date,
    mass,
    altar,
    left_choir,
    right_choir,
    left_nave,
    right_nave,
    balcony,
    ushers,
    total,
    operation,
    changed_by
  )
  values (
    old.date,
    old.mass,
    old.altar,
    old.left_choir,
    old.right_choir,
    old.left_nave,
    old.right_nave,
    old.balcony,
    old.ushers,
    old.total,
    tg_op,
    auth.uid()::text
  );

  -- Keep only the latest 25 versions per (date, mass)
  with ranked as (
    select
      history_id,
      row_number() over (
        partition by date, mass
        order by changed_at desc, history_id desc
      ) as rn
    from public.mass_counts_history
    where date = old.date
      and mass = old.mass
  )
  delete from public.mass_counts_history h
  using ranked r
  where h.history_id = r.history_id
    and r.rn > 25;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_mass_counts_history on public.mass_counts;
create trigger trg_mass_counts_history
before update or delete on public.mass_counts
for each row execute function public.capture_mass_counts_history();

-- 2) Full-table snapshots (manual or scheduled)
create table if not exists public.mass_counts_snapshots (
  snapshot_id uuid not null,
  snapshot_created_at timestamptz not null default now(),
  date date not null,
  mass text not null,
  altar integer not null,
  left_choir integer not null,
  right_choir integer not null,
  left_nave integer not null,
  right_nave integer not null,
  balcony integer not null,
  ushers integer not null,
  total integer not null,
  primary key (snapshot_id, date, mass)
);

create index if not exists idx_mass_counts_snapshots_created
  on public.mass_counts_snapshots (snapshot_created_at desc);

create or replace function public.create_mass_counts_snapshot()
returns uuid
language plpgsql
as $$
declare
  v_snapshot_id uuid := gen_random_uuid();
begin
  insert into public.mass_counts_snapshots (
    snapshot_id,
    date,
    mass,
    altar,
    left_choir,
    right_choir,
    left_nave,
    right_nave,
    balcony,
    ushers,
    total
  )
  select
    v_snapshot_id,
    date,
    mass,
    altar,
    left_choir,
    right_choir,
    left_nave,
    right_nave,
    balcony,
    ushers,
    total
  from public.mass_counts;

  -- Keep only the latest 25 snapshot sets
  with ranked as (
    select
      snapshot_id,
      dense_rank() over (order by max(snapshot_created_at) desc, snapshot_id desc) as rnk
    from public.mass_counts_snapshots
    group by snapshot_id
  )
  delete from public.mass_counts_snapshots s
  using ranked r
  where s.snapshot_id = r.snapshot_id
    and r.rnk > 25;

  return v_snapshot_id;
end;
$$;

-- Optional: restore helper for one snapshot
create or replace function public.restore_mass_counts_snapshot(p_snapshot_id uuid)
returns void
language plpgsql
as $$
begin
  delete from public.mass_counts;

  insert into public.mass_counts (
    date,
    mass,
    altar,
    left_choir,
    right_choir,
    left_nave,
    right_nave,
    balcony,
    ushers,
    total
  )
  select
    date,
    mass,
    altar,
    left_choir,
    right_choir,
    left_nave,
    right_nave,
    balcony,
    ushers,
    total
  from public.mass_counts_snapshots
  where snapshot_id = p_snapshot_id;
end;
$$;

-- Optional scheduling with pg_cron (if enabled):
-- select cron.schedule(
--   'mass-counts-nightly-snapshot',
--   '0 2 * * *',
--   $$select public.create_mass_counts_snapshot();$$
-- );
