-- Role-aware RLS hardening: closes the gap where assertClubAdmin
-- (app-layer, added by the role-based-access-control feature) was the
-- only barrier against a staff member mutating admin-only data via a
-- direct Supabase REST call with their own valid session. Mirrors the
-- role-checking pattern already established by shifts_update
-- (20260801140000_till_shifts_schema.sql).

drop policy products_insert on products;
create policy products_insert on products for insert to authenticated
  with check (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = products.club_id and role = 'admin')
  );

drop policy products_update on products;
create policy products_update on products for update to authenticated
  using (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = products.club_id and role = 'admin')
  )
  with check (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = products.club_id and role = 'admin')
  );

drop policy products_delete on products;
create policy products_delete on products for delete to authenticated
  using (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = products.club_id and role = 'admin')
  );

-- contract_templates: UPDATE/DELETE restricted to admin. INSERT is
-- deliberately left unrestricted (unchanged from its existing policy)
-- because getOrCreateContractTemplate's auto-create-default-template
-- path is legitimately triggered by STAFF too (during member
-- registration/signing, not just the admin Settings screen) --
-- restricting INSERT would break that flow for a club whose first-ever
-- contract access happens to be a staff member registering a member
-- before any admin has ever opened Settings. The residual risk (a staff
-- member direct-REST-inserting arbitrary content for a club with no
-- contract_templates row yet) is a narrow one-time-per-club race window,
-- not an ongoing exposure -- the moment a row exists, this UPDATE
-- restriction covers all further edits, and contract_templates.club_id
-- is UNIQUE so only one such row can ever exist per club.
drop policy contract_templates_update on contract_templates;
create policy contract_templates_update on contract_templates for update to authenticated
  using (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = contract_templates.club_id and role = 'admin')
  )
  with check (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = contract_templates.club_id and role = 'admin')
  );

drop policy contract_templates_delete on contract_templates;
create policy contract_templates_delete on contract_templates for delete to authenticated
  using (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = contract_templates.club_id and role = 'admin')
  );

drop policy business_days_insert on business_days;
create policy business_days_insert on business_days for insert to authenticated
  with check (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = business_days.club_id and role = 'admin')
  );

drop policy business_days_update on business_days;
create policy business_days_update on business_days for update to authenticated
  using (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = business_days.club_id and role = 'admin')
  )
  with check (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = business_days.club_id and role = 'admin')
  );

drop policy workstations_insert on workstations;
create policy workstations_insert on workstations for insert to authenticated
  with check (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = workstations.club_id and role = 'admin')
  );

drop policy workstations_update on workstations;
create policy workstations_update on workstations for update to authenticated
  using (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = workstations.club_id and role = 'admin')
  )
  with check (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = workstations.club_id and role = 'admin')
  );
