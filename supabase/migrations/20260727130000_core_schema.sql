create extension if not exists pgcrypto with schema extensions;

create table clubs (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  initials text not null,
  plan text not null check (plan in ('Trial','Starter','Growth','Enterprise')),
  region text not null,
  accent_color text not null,
  status text not null default 'trial' check (status in ('active','trial','suspended')),
  mrr numeric(10,2) not null default 0,
  created_at timestamptz not null default now()
);

create table club_users (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('staff','admin')),
  created_at timestamptz not null default now(),
  unique (club_id, user_id)
);
create index club_users_user_id_idx on club_users(user_id);
create index club_users_club_id_idx on club_users(club_id);

create table platform_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table members (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  code text not null,
  first text not null,
  last text not null,
  type text not null check (type in ('Full member','Day pass','Trial')),
  status text not null default 'active' check (status in ('active','inactive')),
  token_balance integer not null default 0,
  referrer_id uuid references members(id) on delete set null,
  phone text,
  email text,
  app_handle text,
  joined_at timestamptz not null default now(),
  unique (club_id, code)
);
create index members_club_id_idx on members(club_id);

create table products (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  name text not null,
  category text not null check (category in ('Flower','Pre-rolls','Edibles','Concentrate','Accessory')),
  unit text not null,
  token_price integer not null,
  sell_price numeric(10,2) not null,
  cost numeric(10,2),
  description text,
  flags text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index products_club_id_idx on products(club_id);

create table inventory_moves (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  type text not null check (type in ('PURCHASE','SALE','ADJUSTMENT','WASTE')),
  qty integer not null,
  cost numeric(10,2),
  batch text,
  expiry date,
  reference text,
  staff_id uuid references club_users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index inventory_moves_club_id_idx on inventory_moves(club_id);
create index inventory_moves_product_id_idx on inventory_moves(product_id);

-- Stock is always derived, never stored — security_invoker so this view
-- respects the querying user's RLS on inventory_moves, not the view owner's.
create view product_stock
with (security_invoker = true) as
  select product_id, club_id, coalesce(sum(qty), 0)::integer as stock
  from inventory_moves
  group by product_id, club_id;

create table donations (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  amount_rand numeric(10,2) not null,
  method text not null check (method in ('Cash','Card','EFT')),
  tokens_credited integer not null,
  created_at timestamptz not null default now()
);
create index donations_club_id_idx on donations(club_id);
create index donations_member_id_idx on donations(member_id);

create table contract_templates (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null unique references clubs(id) on delete cascade,
  title text not null,
  subtitle text not null,
  consent text not null,
  clauses jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

-- signature_url stores the Storage object PATH (e.g. "{club_id}/{member_id}/x.png"),
-- not a public URL — the bucket is private, so callers generate a signed URL
-- on demand from this path.
create table signed_contracts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  template_version integer not null,
  contract_snapshot jsonb not null,
  consent boolean not null,
  printed_name text,
  signature_url text not null,
  signed_at timestamptz not null default now()
);
create index signed_contracts_club_id_idx on signed_contracts(club_id);
create index signed_contracts_member_id_idx on signed_contracts(member_id);
