create table business_days (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  initial_float numeric(10,2) not null,
  opened_at timestamptz not null default now(),
  opened_by uuid references club_users(id) on delete set null,
  opened_by_email text not null,
  closed_at timestamptz,
  closed_by uuid references club_users(id) on delete set null,
  closed_by_email text,
  cash_counted numeric(10,2),
  status text not null default 'open' check (status in ('open','closed'))
);
create index business_days_club_id_idx on business_days(club_id);
create unique index business_days_one_open_per_club on business_days(club_id) where status = 'open';

create table workstations (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index workstations_club_id_idx on workstations(club_id);

create table shifts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  business_day_id uuid not null references business_days(id) on delete cascade,
  staff_id uuid references club_users(id) on delete set null,
  staff_email text not null,
  workstation_id uuid references workstations(id) on delete set null,
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  cash_out numeric(10,2),
  force_closed boolean not null default false
);
create index shifts_club_id_idx on shifts(club_id);
create index shifts_business_day_id_idx on shifts(business_day_id);

alter table business_days enable row level security;

create policy business_days_select on business_days for select to authenticated
  using (club_id in (select my_club_ids()));

create policy business_days_insert on business_days for insert to authenticated
  with check (club_id in (select my_club_ids()));

create policy business_days_update on business_days for update to authenticated
  using (club_id in (select my_club_ids()))
  with check (club_id in (select my_club_ids()));

alter table workstations enable row level security;

create policy workstations_select on workstations for select to authenticated
  using (club_id in (select my_club_ids()));

create policy workstations_insert on workstations for insert to authenticated
  with check (club_id in (select my_club_ids()));

create policy workstations_update on workstations for update to authenticated
  using (club_id in (select my_club_ids()))
  with check (club_id in (select my_club_ids()));

alter table shifts enable row level security;

create policy shifts_select on shifts for select to authenticated
  using (club_id in (select my_club_ids()));

create policy shifts_insert on shifts for insert to authenticated
  with check (club_id in (select my_club_ids()));

create policy shifts_update on shifts for update to authenticated
  using (
    club_id in (select my_club_ids())
    and (
      staff_id = (select id from club_users where user_id = auth.uid() and club_id = shifts.club_id)
      or exists (select 1 from club_users where user_id = auth.uid() and club_id = shifts.club_id and role = 'admin')
    )
  )
  with check (
    club_id in (select my_club_ids())
    and (
      staff_id = (select id from club_users where user_id = auth.uid() and club_id = shifts.club_id)
      or exists (select 1 from club_users where user_id = auth.uid() and club_id = shifts.club_id and role = 'admin')
    )
  );
