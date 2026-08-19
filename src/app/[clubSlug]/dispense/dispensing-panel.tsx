"use client";

import { useMemo, useState, useTransition } from "react";
import { useToast } from "@/lib/toast-context";
import { createDispenseOrderAction } from "./actions";
import { effectiveUnitPrice, type Product } from "@/lib/products";
import type { ProductCategoryRow } from "@/lib/categories";
import type { MemberListRow } from "@/lib/members";

export function DispensingPanel({
  clubId,
  products: initialProducts,
  members,
  categories,
}: {
  clubId: string;
  products: Product[];
  members: MemberListRow[];
  categories: ProductCategoryRow[];
}) {
  const { showToast } = useToast();
  const [products, setProducts] = useState(initialProducts);
  const [categoryFilter, setCategoryFilter] = useState<string>("All");
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [giftLines, setGiftLines] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [isCheckingOut, startCheckingOut] = useTransition();

  const selectedMember = members.find((m) => m.id === selectedMemberId) ?? null;

  const categoryChips = useMemo(() => ["All", ...categories.map((c) => c.name)], [categories]);

  const filteredProducts = useMemo(() => {
    return products.filter((p) => p.active && (categoryFilter === "All" || p.categoryName === categoryFilter));
  }, [products, categoryFilter]);

  const memberResults = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return [];
    return members.filter((m) => `${m.first} ${m.last} ${m.code}`.toLowerCase().includes(q)).slice(0, 6);
  }, [members, memberSearch]);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const cartLines = Object.entries(cart).map(([productId, qty]) => {
    const product = productById.get(productId);
    const tokenPrice = product ? effectiveUnitPrice(product.tokenPrice, product.priceTiers, qty) : 0;
    const isGift = productId in giftLines;
    const lineTotal = tokenPrice * qty;
    return {
      productId,
      qty,
      name: product?.name ?? "—",
      tokenPrice,
      lineTotal,
      isGift,
      isGiftable: product?.flags.includes("gift") ?? false,
      giftReason: giftLines[productId] ?? "",
      chargedTotal: isGift ? 0 : lineTotal,
    };
  });
  const cartCount = cartLines.reduce((sum, l) => sum + l.qty, 0);
  const cartTotal = cartLines.reduce((sum, l) => sum + l.chargedTotal, 0);
  const giftCount = cartLines.filter((l) => l.isGift).length;
  const balanceAfter = selectedMember ? selectedMember.tokenBalance - cartTotal : null;
  const canCheckout = Boolean(selectedMember) && cartCount > 0 && (balanceAfter ?? -1) >= 0;

  function addToCart(productId: string) {
    setCart((prev) => ({ ...prev, [productId]: (prev[productId] ?? 0) + 1 }));
  }

  function changeQty(productId: string, delta: number) {
    setCart((prev) => {
      const next = { ...prev };
      const qty = (next[productId] ?? 0) + delta;
      if (qty <= 0) {
        delete next[productId];
      } else {
        next[productId] = qty;
      }
      return next;
    });
    setGiftLines((prev) => {
      const qty = (cart[productId] ?? 0) + delta;
      if (qty > 0) return prev;
      if (!(productId in prev)) return prev;
      const next = { ...prev };
      delete next[productId];
      return next;
    });
  }

  function selectMember(memberId: string) {
    setSelectedMemberId(memberId);
    setMemberSearch("");
  }

  function toggleGift(productId: string) {
    setGiftLines((prev) => {
      if (productId in prev) {
        const next = { ...prev };
        delete next[productId];
        return next;
      }
      return { ...prev, [productId]: "" };
    });
  }

  function setGiftReason(productId: string, reason: string) {
    setGiftLines((prev) => (productId in prev ? { ...prev, [productId]: reason } : prev));
  }

  function handleCheckout() {
    setError(null);
    if (!selectedMember) {
      setError("Select a member first");
      return;
    }
    if (cartCount === 0) {
      setError("Add products to the order");
      return;
    }
    if ((balanceAfter ?? -1) < 0) {
      setError("Not enough tokens for this order");
      return;
    }
    const items = cartLines.map((l) => ({
      productId: l.productId,
      qty: l.qty,
      isGift: l.isGift,
      giftReason: l.giftReason || null,
    }));
    startCheckingOut(async () => {
      const result = await createDispenseOrderAction(clubId, selectedMember.id, items);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setProducts((prev) =>
        prev.map((p) => {
          const cartQty = cart[p.id];
          return cartQty ? { ...p, stock: p.stock - cartQty } : p;
        }),
      );
      showToast(
        `Dispensed · ${cartCount} item(s), ${selectedMember.tokenBalance - result.order.tokenTotal} tokens remaining`,
      );
      setCart({});
      setGiftLines({});
      setSelectedMemberId(null);
    });
  }

  return (
    <div className="grid grid-cols-[1fr_380px] items-start gap-4">
      <div>
        {selectedMember ? (
          <div className="mb-3.5 flex items-center gap-3.5 rounded-card border border-border bg-card p-4">
            <div className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-accent text-base font-semibold text-primary">
              {selectedMember.first.charAt(0)}
              {selectedMember.last.charAt(0)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold">
                {selectedMember.first} {selectedMember.last}
              </div>
              <div className="text-[12px] text-[#6b6f66]">
                {selectedMember.type} · {selectedMember.code}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-[#6b6f66]">Token balance</div>
              <div className="font-mono text-xl font-semibold text-primary">{selectedMember.tokenBalance}</div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedMemberId(null)}
              className="rounded-[8px] border border-input bg-muted px-3 py-2 text-[12px] text-[#6b6f66]"
            >
              Change
            </button>
          </div>
        ) : (
          <div className="relative mb-3.5">
            <label htmlFor="dispenseMemberSearch" className="mb-1 block text-[11px] text-[#8a8e83]">
              Select a member to dispense to
            </label>
            <input
              id="dispenseMemberSearch"
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder="Search members by name or code…"
              className="w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
            />
            {memberResults.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-[10px] border border-border bg-card shadow-lg">
                {memberResults.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => selectMember(m.id)}
                    className="flex w-full items-center gap-2.5 border-b border-[#f4f2ea] px-3 py-2.5 text-left last:border-b-0"
                  >
                    <div className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-primary">
                      {m.first.charAt(0)}
                      {m.last.charAt(0)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">
                        {m.first} {m.last}
                      </div>
                      <div className="text-[11px] text-[#9a9e93]">{m.code}</div>
                    </div>
                    <div className="font-mono text-[12px] text-primary">{m.tokenBalance} bal</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mb-3 flex flex-wrap gap-[7px]">
          {categoryChips.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategoryFilter(c)}
              className="rounded-[8px] border px-3 py-[7px] text-[12.5px] font-medium"
              style={
                categoryFilter === c
                  ? { background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }
                  : { background: "var(--card)", borderColor: "var(--border)", color: "#4a4e45" }
              }
            >
              {c}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
          {filteredProducts.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => addToCart(p.id)}
              className="overflow-hidden rounded-[13px] border border-border bg-card text-left"
            >
              <div className="flex h-[78px] items-center justify-center bg-accent font-mono text-[10px] text-[#8ba690]">
                {p.categoryName}
              </div>
              <div className="px-3 py-2.5">
                <div className="text-[13px] font-semibold leading-tight">{p.name}</div>
                <div className="mt-0.5 text-[11px] text-[#8a8e83]">
                  {p.unit} · {p.stock} in stock
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <div className="font-mono text-[15px] font-semibold text-primary">
                    {p.tokenPrice}
                    <span className="text-[10px] font-normal text-[#8a8e83]"> tok</span>
                  </div>
                  <div className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-accent text-[15px] font-semibold text-primary">
                    +
                  </div>
                </div>
                {p.priceTiers.length > 0 && (
                  <div className="mt-1 truncate text-[10px] text-[#8a8e83]">
                    {[...p.priceTiers]
                      .sort((a, b) => a.minQty - b.minQty)
                      .map((t) => `${t.minQty}+: ${t.unitPrice} tok`)
                      .join(" · ")}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="sticky top-0 flex max-h-[calc(100vh-150px)] flex-col rounded-card border border-border bg-card">
        <div className="border-b border-[#f0eee6] px-4 py-[15px] font-heading text-[15px] font-semibold">
          Order · redeem tokens
        </div>
        <div className="min-h-[120px] flex-1 overflow-y-auto px-3 py-1.5">
          {cartLines.length === 0 ? (
            <div className="px-2.5 py-10 text-center text-[12.5px] text-[#9a9e93]">
              No items yet.
              <br />
              Tap products to add them.
            </div>
          ) : (
            cartLines.map((l) => (
              <div key={l.productId} className="border-b border-[#f4f2ea] py-2.5">
                <div className="flex items-center gap-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{l.name}</div>
                    <div className="font-mono text-[11px] text-[#8a8e83]">
                      {l.tokenPrice} × {l.qty}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => changeQty(l.productId, -1)}
                      className="h-6 w-6 rounded-[6px] border border-input bg-muted text-[14px] text-[#6b6f66]"
                    >
                      −
                    </button>
                    <div className="w-[22px] text-center font-mono text-[13px]">{l.qty}</div>
                    <button
                      type="button"
                      onClick={() => changeQty(l.productId, 1)}
                      className="h-6 w-6 rounded-[6px] border border-input bg-muted text-[14px] text-[#6b6f66]"
                    >
                      +
                    </button>
                  </div>
                  {l.isGiftable && (
                    <button
                      type="button"
                      onClick={() => toggleGift(l.productId)}
                      title={l.isGift ? "Remove gift" : "Mark as gift"}
                      className="flex h-6 w-6 flex-none items-center justify-center rounded-[6px] border text-[13px]"
                      style={
                        l.isGift
                          ? { background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }
                          : { background: "var(--card)", borderColor: "var(--border)", color: "#8a8e83" }
                      }
                    >
                      🎁
                    </button>
                  )}
                  <div
                    className={
                      "w-[52px] text-right font-mono text-[13px] font-semibold" +
                      (l.isGift ? " text-[#9a9e93] line-through" : "")
                    }
                  >
                    {l.lineTotal}
                  </div>
                </div>
                {l.isGift && (
                  <div className="mt-1.5">
                    <label htmlFor={`giftReason-${l.productId}`} className="sr-only">
                      Gift reason
                    </label>
                    <input
                      id={`giftReason-${l.productId}`}
                      value={l.giftReason}
                      onChange={(e) => setGiftReason(l.productId, e.target.value)}
                      placeholder="Reason (optional)"
                      className="w-full rounded-[6px] border border-input px-2 py-1 text-[11.5px]"
                    />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
        <div className="border-t border-border px-4 py-3.5">
          <div className="mb-1.5 flex justify-between text-[12.5px] text-[#6b6f66]">
            <span>Items</span>
            <span className="font-mono">{cartCount}</span>
          </div>
          {giftCount > 0 && (
            <div className="mb-1.5 flex justify-between text-[12.5px] text-primary">
              <span>Includes {giftCount} gift{giftCount > 1 ? "s" : ""}</span>
            </div>
          )}
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-semibold">Total tokens</span>
            <span className="font-mono text-xl font-semibold text-primary">{cartTotal}</span>
          </div>
          <div
            className="mb-3 flex justify-between text-[12px]"
            style={{ color: balanceAfter !== null && balanceAfter < 0 ? "var(--destructive)" : "#6b6f66" }}
          >
            <span>Balance after</span>
            <span className="font-mono">{balanceAfter === null ? "—" : balanceAfter}</span>
          </div>
          {error && <p className="mb-3 text-[12.5px] text-destructive">{error}</p>}
          <button
            type="button"
            onClick={handleCheckout}
            disabled={!canCheckout || isCheckingOut}
            className="w-full rounded-[10px] py-3.5 text-[14px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#e7e4db] disabled:text-[#9a9e93]"
            style={canCheckout && !isCheckingOut ? { background: "var(--primary)" } : undefined}
          >
            {isCheckingOut
              ? "Dispensing…"
              : !selectedMember
                ? "Select a member"
                : cartCount === 0
                  ? "Add products"
                  : (balanceAfter ?? -1) < 0
                    ? "Insufficient balance"
                    : `Confirm dispense · ${cartTotal} tokens`}
          </button>
        </div>
      </div>
    </div>
  );
}
