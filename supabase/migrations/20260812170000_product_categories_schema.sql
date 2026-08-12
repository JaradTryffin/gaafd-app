create table product_categories (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (club_id, name)
);
create index product_categories_club_id_idx on product_categories(club_id);

alter table product_categories enable row level security;

create policy product_categories_select on product_categories for select to authenticated
  using (club_id in (select my_club_ids()));

create policy product_categories_insert on product_categories for insert to authenticated
  with check (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = product_categories.club_id and role = 'admin')
  );

create policy product_categories_update on product_categories for update to authenticated
  using (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = product_categories.club_id and role = 'admin')
  )
  with check (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = product_categories.club_id and role = 'admin')
  );

create policy product_categories_delete on product_categories for delete to authenticated
  using (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = product_categories.club_id and role = 'admin')
  );
