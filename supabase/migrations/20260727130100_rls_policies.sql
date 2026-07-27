create or replace function my_club_ids()
returns setof uuid
language sql
security definer
set search_path = public
stable
as $$
  select club_id from club_users where user_id = auth.uid();
$$;

create or replace function is_platform()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from platform_users where user_id = auth.uid());
$$;

grant execute on function my_club_ids() to authenticated;
grant execute on function is_platform() to authenticated;

-- clubs: read own club or, read-only, every club if platform
alter table clubs enable row level security;
create policy clubs_select on clubs for select to authenticated
  using ( id in (select my_club_ids()) or (select is_platform()) );

-- club_users: read own membership rows only. No helper calls here —
-- my_club_ids() reads this table, so this policy must not call it back.
alter table club_users enable row level security;
create policy club_users_select_own on club_users for select to authenticated
  using ( user_id = auth.uid() );

-- platform_users: read own row only, same recursion guard as club_users.
alter table platform_users enable row level security;
create policy platform_users_select_own on platform_users for select to authenticated
  using ( user_id = auth.uid() );

-- members: full tenant-scoped CRUD, no platform bypass.
alter table members enable row level security;
create policy members_select on members for select to authenticated
  using ( club_id in (select my_club_ids()) );
create policy members_insert on members for insert to authenticated
  with check ( club_id in (select my_club_ids()) );
create policy members_update on members for update to authenticated
  using ( club_id in (select my_club_ids()) )
  with check ( club_id in (select my_club_ids()) );
create policy members_delete on members for delete to authenticated
  using ( club_id in (select my_club_ids()) );

-- products: full tenant-scoped CRUD, no platform bypass.
alter table products enable row level security;
create policy products_select on products for select to authenticated
  using ( club_id in (select my_club_ids()) );
create policy products_insert on products for insert to authenticated
  with check ( club_id in (select my_club_ids()) );
create policy products_update on products for update to authenticated
  using ( club_id in (select my_club_ids()) )
  with check ( club_id in (select my_club_ids()) );
create policy products_delete on products for delete to authenticated
  using ( club_id in (select my_club_ids()) );

-- inventory_moves: append-only audit ledger — SELECT + INSERT only, for
-- anyone, including the owning tenant. Corrections are new rows, never
-- UPDATE/DELETE.
alter table inventory_moves enable row level security;
create policy inventory_moves_select on inventory_moves for select to authenticated
  using ( club_id in (select my_club_ids()) );
create policy inventory_moves_insert on inventory_moves for insert to authenticated
  with check ( club_id in (select my_club_ids()) );

-- donations: full tenant-scoped CRUD, no platform bypass.
alter table donations enable row level security;
create policy donations_select on donations for select to authenticated
  using ( club_id in (select my_club_ids()) );
create policy donations_insert on donations for insert to authenticated
  with check ( club_id in (select my_club_ids()) );
create policy donations_update on donations for update to authenticated
  using ( club_id in (select my_club_ids()) )
  with check ( club_id in (select my_club_ids()) );
create policy donations_delete on donations for delete to authenticated
  using ( club_id in (select my_club_ids()) );

-- contract_templates: full tenant-scoped CRUD, no platform bypass.
alter table contract_templates enable row level security;
create policy contract_templates_select on contract_templates for select to authenticated
  using ( club_id in (select my_club_ids()) );
create policy contract_templates_insert on contract_templates for insert to authenticated
  with check ( club_id in (select my_club_ids()) );
create policy contract_templates_update on contract_templates for update to authenticated
  using ( club_id in (select my_club_ids()) )
  with check ( club_id in (select my_club_ids()) );
create policy contract_templates_delete on contract_templates for delete to authenticated
  using ( club_id in (select my_club_ids()) );

-- signed_contracts: append-only legal record — SELECT + INSERT only, for
-- anyone, including the owning tenant. Never mutated after signing.
alter table signed_contracts enable row level security;
create policy signed_contracts_select on signed_contracts for select to authenticated
  using ( club_id in (select my_club_ids()) );
create policy signed_contracts_insert on signed_contracts for insert to authenticated
  with check ( club_id in (select my_club_ids()) );

-- platform aggregate-only reporting: the only other place is_platform()
-- appears. Returns empty (not an error) for non-platform callers, so the
-- client can treat it as "no data" rather than needing to catch an
-- exception.
create type platform_club_stat as (
  club_id uuid,
  member_count bigint
);

create or replace function platform_club_stats()
returns setof platform_club_stat
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not is_platform() then
    return;
  end if;
  return query
    select c.id, count(m.id)
    from clubs c
    left join members m on m.club_id = c.id
    group by c.id;
end;
$$;

grant execute on function platform_club_stats() to authenticated;

-- Deliberately no INSERT/UPDATE/DELETE policies on clubs, club_users, or
-- platform_users for the `authenticated` role. With RLS enabled and no
-- write policy, Postgres denies the write to everyone in that role —
-- onboarding a club, granting membership, or granting platform access all
-- go through a service-role server action (phase 2+), never a client
-- write gated by these policies.
