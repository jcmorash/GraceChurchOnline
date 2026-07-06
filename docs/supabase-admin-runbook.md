# Supabase Admin Safety Runbook

Use this before and after any risky change to attendance data.

## 1) Create a backup snapshot before changes

```sql
select public.create_mass_counts_snapshot() as snapshot_id;
```

Save the returned `snapshot_id` in your change notes.

## 2) Verify current row count

```sql
select count(*) as current_rows
from public.mass_counts;
```

## 3) List recent snapshots (latest first)

```sql
select
  snapshot_id,
  max(snapshot_created_at) as created_at,
  count(*) as rows_in_snapshot
from public.mass_counts_snapshots
group by snapshot_id
order by created_at desc
limit 25;
```

## 4) Confirm row-level history is being captured

```sql
select
  changed_at,
  operation,
  date,
  mass,
  total
from public.mass_counts_history
order by changed_at desc
limit 50;
```

## 5) Roll back full table to a snapshot

Replace `PUT-SNAPSHOT-UUID-HERE` with the snapshot id:

```sql
select public.restore_mass_counts_snapshot('PUT-SNAPSHOT-UUID-HERE'::uuid);
```

## 6) Validate rollback succeeded

```sql
select count(*) as current_rows
from public.mass_counts;

select date, mass, total
from public.mass_counts
order by date desc, mass asc
limit 25;
```

## 7) Export safety copy to CSV (optional)

In the app Admin page, click `Export CSV` and save the file with a descriptive name.

## 8) Quick incident workflow

1. Stop data entry if possible.
2. Create snapshot immediately.
3. Investigate with history query.
4. Decide: fix forward or restore snapshot.
5. Validate row counts and sample records.
6. Resume data entry.

## 9) Retention behavior

- Row history keeps latest 25 versions per `(date, mass)`.
- Full snapshots keep latest 25 snapshot sets.
- Older versions are pruned automatically by SQL functions.
