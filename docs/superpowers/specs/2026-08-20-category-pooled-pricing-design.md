# Category-Pooled Bulk Pricing — Design Spec

## Problem

Bulk-pricing tiers (`products.price_tiers`) are evaluated per product against that product's own quantity in the cart. When a customer buys 10 units of one product and 10 units of a *different* product in the same category, each line is priced independently against its own tier list — neither line reaches the 20-unit tier even though 20 units of that category moved in one order.

Concrete example (both products in "Premium Flower", identical tiers `10 @ 100`, `20 @ 90`):

- Shortbread Premium × 10 → priced at the 10-tier (100/unit) → 1000
- London Fog Premium × 10 → priced at the 10-tier (100/unit) → 1000
- Order total: 2000

Expected: the two lines' quantities pool to 20 within "Premium Flower", both should price at the 20-tier (90/unit) → 1800.

## Goal

Quantities of products sharing a category pool together for the purpose of picking a tier. Each product still charges *its own* price for whatever tier the pooled quantity unlocks — no requirement that products in a category share identical tier schedules. This applies identically in the live Dispensing cart preview and in the authoritative checkout charge, so staff never see a total that doesn't match what's actually charged.

## Design

### Server: `create_dispense_order` (7th live modification to this function)

Today the function's main loop does, per aggregated line item: look up the product (name/unit/token_price/price_tiers/flags), check it exists, check the gift-flag, check stock, price it via `effective_unit_price(token_price, price_tiers, qty)` using *that line's own* qty, then build the snapshot and accumulate the total.

This becomes two passes over the aggregated items instead of one:

1. **Resolve pass** — for each aggregated line, look up the product (now also selecting `category_id`), run the existing not-found and gift-flag checks (unchanged, same order, same error messages), and collect a resolved list carrying everything the pricing pass needs (product_id, qty, is_gift, gift_reason, name, unit, token_price, price_tiers, category_id). Stock is checked here too, still against each line's own qty — pooling never affects stock, only price.
2. **Pool step** — sum `qty` across the resolved list grouped by `category_id` (gift-inclusive, since gifted volume still moved through the category).
3. **Price pass** — for each resolved line, look up its category's pooled quantity and call `effective_unit_price(token_price, price_tiers, pooled_qty)` instead of the line's own qty. Everything downstream (line_charge zeroing for gifts, snapshot fields, token_total accumulation) is unchanged.

Balance check, the `dispense_orders` insert, the `inventory_moves` insert loop, and the member balance update are all unaffected — they already key off each line's own qty, not price.

`security invoker` is preserved, as always. This is a real restructuring (one loop → resolve + pool + price), not just an added field, so it gets the same heightened-scrutiny review every prior change to this function has gotten, plus explicit test coverage for the pooling logic itself.

### Client: `dispensing-panel.tsx`

A `pooledQtyByCategory` map is derived from the current cart (categoryId → summed quantity across every cart line in that category, gift lines included). Each cart line's live price preview calls `effectiveUnitPrice(product.tokenPrice, product.priceTiers, pooledQty)` instead of the line's own qty — `effectiveUnitPrice`'s signature (`basePrice, tiers, qty`) doesn't change, only what gets passed as `qty`.

Product tiles' static tier-list hint (e.g. "10+: 100 tok · 20+: 90 tok") is unchanged — it's a fixed informational label describing that product's own price list, not a claim about the current cart, so it doesn't need to reflect pooling.

## Out of scope

- No new schema, no new product field, no change to how tiers are authored on Products.
- No change to the "10+ / 20+" tier-hint label shown on product tiles.
- No change to stock checks, inventory writes, or gift-flag enforcement — pooling only changes which tier's *price* applies.

## Testing

- **Regression:** a single product alone in the cart prices identically to today (pooled qty == its own qty).
- **The reported case:** two products, same category, identical tiers, 10+10 → both price at the 20-tier, total 1800.
- **No cross-category pooling:** two products in different categories, 10 each, neither reaches a 20-tier even though the order has 20 total items.
- **Mismatched tier schedules:** two products in the same category with different tier lists — pooled qty unlocks each product's own best-matching tier independently (not a shared/uniform price).
- **Gift pooling:** a gifted line and a paid line in the same category — the paid line's tier is unlocked using the combined (gift + paid) quantity, per the confirmed design choice.
- **Live-preview parity:** a scoped smoke test confirming the Dispensing cart's displayed total for a pooled multi-product order matches what `create_dispense_order` actually charges.

## Global constraints (carried from project conventions)

- No PostgREST relation embedding.
- `security invoker` preserved on `create_dispense_order`.
- No schema changes.
- Client and server pricing logic must never diverge (established rule since Bulk Pricing shipped).
