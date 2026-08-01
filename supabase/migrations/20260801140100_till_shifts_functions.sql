create or replace function clock_in(
  p_club_id uuid,
  p_workstation_id uuid,
  p_staff_email text
)
returns shifts
language plpgsql
security invoker
as $$
declare
  v_staff_id uuid;
  v_business_day_id uuid;
  v_shift shifts;
begin
  select cu.id into v_staff_id
  from club_users cu
  where cu.club_id = p_club_id and cu.user_id = auth.uid();
  if v_staff_id is null then
    raise exception 'Not a member of this club';
  end if;

  if exists (
    select 1 from shifts
    where club_id = p_club_id and staff_id = v_staff_id and clock_out is null
  ) then
    raise exception 'You already have an open shift';
  end if;

  select id into v_business_day_id
  from business_days
  where club_id = p_club_id and status = 'open';
  if v_business_day_id is null then
    raise exception 'No business day is open';
  end if;

  if p_workstation_id is not null and not exists (
    select 1 from workstations where id = p_workstation_id and club_id = p_club_id
  ) then
    raise exception 'Workstation not found in this club';
  end if;

  insert into shifts (club_id, business_day_id, staff_id, staff_email, workstation_id)
  values (p_club_id, v_business_day_id, v_staff_id, p_staff_email, p_workstation_id)
  returning * into v_shift;

  return v_shift;
end;
$$;

create or replace function close_business_day(
  p_club_id uuid,
  p_business_day_id uuid,
  p_staff_email text
)
returns business_days
language plpgsql
security invoker
as $$
declare
  v_open_count integer;
  v_cash_counted numeric(10,2);
  v_staff_id uuid;
  v_day business_days;
begin
  select cu.id into v_staff_id
  from club_users cu
  where cu.club_id = p_club_id and cu.user_id = auth.uid();
  if v_staff_id is null then
    raise exception 'Not a member of this club';
  end if;

  if not exists (
    select 1 from business_days where id = p_business_day_id and club_id = p_club_id and status = 'open'
  ) then
    raise exception 'Business day not found or already closed';
  end if;

  select count(*) into v_open_count
  from shifts
  where business_day_id = p_business_day_id and clock_out is null;
  if v_open_count > 0 then
    raise exception 'Cannot close: % shift(s) still open', v_open_count;
  end if;

  select coalesce(sum(cash_out), 0) into v_cash_counted
  from shifts
  where business_day_id = p_business_day_id;

  update business_days
  set status = 'closed', closed_at = now(), closed_by = v_staff_id,
      closed_by_email = p_staff_email, cash_counted = v_cash_counted
  where id = p_business_day_id
  returning * into v_day;

  return v_day;
end;
$$;
