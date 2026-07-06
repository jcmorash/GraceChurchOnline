# Supabase Setup For Mass Counter App

## 1) Create/verify table

Run this in Supabase SQL Editor:

```sql
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
```

## 2) API permissions

If using a service role key in Apps Script, no extra RLS policy is required.
If using anon key, add read/write policies for this table.

## 3) Apps Script properties

In Apps Script, open Project Settings -> Script Properties and set:

- STORAGE_PROVIDER = supabase
- SUPABASE_URL = https://YOUR_PROJECT_ID.supabase.co
- SUPABASE_KEY = YOUR_SUPABASE_KEY
- SUPABASE_TABLE = mass_counts

To switch back to Google Sheets later:

- STORAGE_PROVIDER = sheets

## 4) Notes

- The app upserts by (date, mass).
- CSV import also upserts by (date, mass).
- Date values should be in YYYY-MM-DD format for best results.
