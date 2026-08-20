create or replace function create_dispense_order(
  p_club_id uuid,
  p_member_id uuid,
  p_items jsonb,
  p_staff_email text default null
)
returns dispense_orders
language plpgsql
security invoker
as $$
declare
  v_order dispense_orders;
  v_item jsonb;
  v_product_id uuid;
  v_qty integer;
  v_token_price integer;
  v_product_name text;
  v_unit text;
  v_flags text[];
  v_category_id uuid;
  v_stock integer;
  v_token_total integer := 0;
  v_snapshot jsonb := '[]'::jsonb;
  v_member_balance integer;
  v_staff_id uuid;
  v_items_agg jsonb;
  v_items_resolved jsonb := '[]'::jsonb;
  v_pooled_qty_by_category jsonb;
  v_price_tiers jsonb;
  v_is_gift boolean;
  v_gift_reason text;
  v_line_charge integer;
  v_pooled_qty integer;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Order must contain at least one item';
  end if;

  if not exists (select 1 from members where id = p_member_id and club_id = p_club_id) then
    raise exception 'Member not found in this club';
  end if;

  select cu.id into v_staff_id
  from club_users cu
  where cu.club_id = p_club_id and cu.user_id = auth.uid();
  if v_staff_id is null then
    raise exception 'Not a member of this club';
  end if;

  select token_balance into v_member_balance from members where id = p_member_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    if (v_item->>'product_id') is null then
      raise exception 'Invalid product for a line item';
    end if;
    v_qty := (v_item->>'qty')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid quantity for a line item';
    end if;
  end loop;

  select jsonb_agg(jsonb_build_object(
    'product_id', product_id,
    'qty', qty,
    'is_gift', is_gift,
    'gift_reason', gift_reason
  ))
  into v_items_agg
  from (
    select
      (item->>'product_id')::uuid as product_id,
      sum((item->>'qty')::integer) as qty,
      bool_or(coalesce((item->>'is_gift')::boolean, false)) as is_gift,
      max(item->>'gift_reason') as gift_reason
    from jsonb_array_elements(p_items) as item
    group by (item->>'product_id')::uuid
  ) agg;

  -- Resolve pass: look up each line's product, run the existence/gift-flag/
  -- stock checks (unchanged from before), and carry category_id forward so
  -- the price pass below can pool quantity by category.
  for v_item in select * from jsonb_array_elements(v_items_agg)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::integer;
    v_is_gift := coalesce((v_item->>'is_gift')::boolean, false);
    v_gift_reason := v_item->>'gift_reason';

    select p.name, p.unit, p.token_price, p.price_tiers, p.flags, p.category_id
    into v_product_name, v_unit, v_token_price, v_price_tiers, v_flags, v_category_id
    from products p
    where p.id = v_product_id and p.club_id = p_club_id;

    if v_product_name is null then
      raise exception 'Product not found in this club';
    end if;

    if v_is_gift and not ('gift' = any(coalesce(v_flags, '{}'::text[]))) then
      raise exception '% is not marked as giftable', v_product_name;
    end if;

    select coalesce(sum(im.qty), 0) into v_stock
    from inventory_moves im
    where im.product_id = v_product_id and im.club_id = p_club_id;

    if v_stock < v_qty then
      raise exception 'Insufficient stock for %', v_product_name;
    end if;

    v_items_resolved := v_items_resolved || jsonb_build_object(
      'product_id', v_product_id,
      'qty', v_qty,
      'is_gift', v_is_gift,
      'gift_reason', v_gift_reason,
      'name', v_product_name,
      'unit', v_unit,
      'token_price', v_token_price,
      'price_tiers', v_price_tiers,
      'category_id', v_category_id
    );
  end loop;

  -- Pool step: total quantity per category across the whole order. Gift
  -- lines are included -- volume moved is volume moved regardless of who's
  -- charged for it.
  select jsonb_object_agg(category_id::text, total_qty)
  into v_pooled_qty_by_category
  from (
    select (r->>'category_id')::uuid as category_id, sum((r->>'qty')::integer) as total_qty
    from jsonb_array_elements(v_items_resolved) as r
    group by (r->>'category_id')::uuid
  ) pooled;

  -- Price pass: each line still prices against ITS OWN tier list, but keyed
  -- by the pooled category quantity rather than the line's own individual
  -- qty. Products in a category never need matching tier schedules.
  for v_item in select * from jsonb_array_elements(v_items_resolved)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::integer;
    v_is_gift := (v_item->>'is_gift')::boolean;
    v_gift_reason := v_item->>'gift_reason';
    v_product_name := v_item->>'name';
    v_unit := v_item->>'unit';
    v_token_price := (v_item->>'token_price')::integer;
    v_price_tiers := v_item->'price_tiers';
    v_category_id := (v_item->>'category_id')::uuid;

    v_pooled_qty := coalesce((v_pooled_qty_by_category ->> (v_category_id::text))::integer, v_qty);

    v_token_price := effective_unit_price(v_token_price, v_price_tiers, v_pooled_qty);

    if v_is_gift then
      v_line_charge := 0;
    else
      v_line_charge := v_token_price * v_qty;
    end if;

    v_token_total := v_token_total + v_line_charge;
    v_snapshot := v_snapshot || jsonb_build_object(
      'productId', v_product_id,
      'productName', v_product_name,
      'unit', v_unit,
      'qty', v_qty,
      'tokenPrice', v_token_price,
      'lineTotal', v_token_price * v_qty,
      'isGift', v_is_gift,
      'giftReason', v_gift_reason
    );
  end loop;

  if v_member_balance < v_token_total then
    raise exception 'Member does not have enough tokens for this order';
  end if;

  insert into dispense_orders (club_id, member_id, token_total, items, staff_id, staff_email)
  values (p_club_id, p_member_id, v_token_total, v_snapshot, v_staff_id, p_staff_email)
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(v_items_agg)
  loop
    insert into inventory_moves (club_id, product_id, type, qty, order_id, staff_id)
    values (
      p_club_id,
      (v_item->>'product_id')::uuid,
      'SALE',
      -((v_item->>'qty')::integer),
      v_order.id,
      v_staff_id
    );
  end loop;

  update members set token_balance = token_balance - v_token_total
  where id = p_member_id and club_id = p_club_id;

  return v_order;
end;
$$;
