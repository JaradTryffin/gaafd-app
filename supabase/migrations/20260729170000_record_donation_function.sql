create or replace function record_donation(
  p_club_id uuid,
  p_member_id uuid,
  p_amount_rand numeric,
  p_method text
)
returns donations
language plpgsql
security invoker
as $$
declare
  v_row donations;
  v_tokens integer;
begin
  if p_amount_rand is null or p_amount_rand <= 0 then
    raise exception 'Donation amount must be positive';
  end if;

  -- Defense-in-depth, matching this project's established pattern
  -- (signContract, createMovement): the donations INSERT policy only
  -- checks the new row's own club_id, never cross-validates that
  -- member_id belongs to that same club. Without this check, a
  -- mismatched (club_id, member_id) pair would silently insert the
  -- donation while the token-credit UPDATE below matches zero rows
  -- (its WHERE clause requires both id and club_id) -- donation
  -- recorded, no tokens credited, no error raised.
  if not exists (select 1 from members where id = p_member_id and club_id = p_club_id) then
    raise exception 'Member not found in this club';
  end if;

  v_tokens := round(p_amount_rand)::integer;

  insert into donations (club_id, member_id, amount_rand, method, tokens_credited)
  values (p_club_id, p_member_id, p_amount_rand, p_method, v_tokens)
  returning * into v_row;

  update members
  set token_balance = token_balance + v_tokens
  where id = p_member_id and club_id = p_club_id;

  return v_row;
end;
$$;
