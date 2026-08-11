alter table products add column price_tiers jsonb not null default '[]'::jsonb;
