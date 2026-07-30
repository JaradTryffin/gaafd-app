create table dispense_orders (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  token_total integer not null,
  items jsonb not null,
  staff_id uuid references club_users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index dispense_orders_club_id_idx on dispense_orders(club_id);
create index dispense_orders_member_id_idx on dispense_orders(member_id);

alter table inventory_moves add column order_id uuid references dispense_orders(id) on delete set null;

alter table dispense_orders enable row level security;

create policy dispense_orders_select on dispense_orders for select to authenticated
  using (club_id in (select my_club_ids()));

create policy dispense_orders_insert on dispense_orders for insert to authenticated
  with check (club_id in (select my_club_ids()));
