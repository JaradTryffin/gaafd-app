-- Seed the 5 existing default categories for every club that already
-- exists (Cottonmouth included). on conflict guards re-running safety.
insert into product_categories (club_id, name)
select c.id, cat.name
from clubs c
cross join (values ('Flower'), ('Pre-rolls'), ('Edibles'), ('Concentrate'), ('Accessory')) as cat(name)
on conflict (club_id, name) do nothing;

-- Nullable at first -- it must be backfilled before it can be required.
alter table products add column category_id uuid references product_categories(id) on delete restrict;

-- Match every existing product to the category row with the same name,
-- within the same club. Guaranteed 1:1: the old CHECK constraint only
-- ever allowed the 5 exact names just seeded above.
update products p
set category_id = pc.id
from product_categories pc
where pc.club_id = p.club_id and pc.name = p.category;
