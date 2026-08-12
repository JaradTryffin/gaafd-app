"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useToast } from "@/lib/toast-context";
import {
  createProductAction,
  updateProductAction,
  checkProductHistoryAction,
  deleteOrDeactivateProductAction,
} from "./actions";
import type { Product } from "@/lib/products";
import type { ProductCategoryRow } from "@/lib/categories";

const LOW_STOCK_THRESHOLD = 8;

const FLAG_LABELS: Record<string, string> = {
  app: "Show in app",
  gift: "Gifting allowed",
  nodisc: "Discount-exempt",
};

const FLAG_CHIP_LABELS: Record<string, string> = {
  app: "App",
  gift: "Gift",
  nodisc: "No disc",
};

type PriceTierDraft = { minQty: string; unitPrice: string };

function dedupeTiersByMinQty(
  tiers: { minQty: number; unitPrice: number }[],
): { minQty: number; unitPrice: number }[] {
  const byMinQty = new Map<number, number>();
  for (const tier of tiers) {
    byMinQty.set(tier.minQty, tier.unitPrice);
  }
  return Array.from(byMinQty, ([minQty, unitPrice]) => ({ minQty, unitPrice }));
}

type ProductDraft = {
  name: string;
  categoryId: string;
  unit: string;
  tokenPrice: string;
  sellPrice: string;
  cost: string;
  description: string;
  flags: string[];
  priceTiers: PriceTierDraft[];
};

const EMPTY_DRAFT: ProductDraft = {
  name: "",
  categoryId: "",
  unit: "",
  tokenPrice: "",
  sellPrice: "",
  cost: "",
  description: "",
  flags: [],
  priceTiers: [],
};

function draftFromProduct(product: Product): ProductDraft {
  return {
    name: product.name,
    categoryId: product.categoryId,
    unit: product.unit,
    tokenPrice: String(product.tokenPrice),
    sellPrice: String(product.sellPrice),
    cost: product.cost === null ? "" : String(product.cost),
    description: product.description ?? "",
    flags: product.flags,
    priceTiers: product.priceTiers.map((t) => ({
      minQty: String(t.minQty),
      unitPrice: String(t.unitPrice),
    })),
  };
}

export function ProductsTable({
  clubId,
  products: initialProducts,
  categories,
}: {
  clubId: string;
  products: Product[];
  categories: ProductCategoryRow[];
}) {
  const { showToast } = useToast();
  const [products, setProducts] = useState(initialProducts);
  const [search, setSearch] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProductDraft>(EMPTY_DRAFT);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();

  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [deleteHasHistory, setDeleteHasHistory] = useState<boolean | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, startDeleting] = useTransition();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (modalOpen) setModalOpen(false);
      if (deleteTarget) closeDeleteDialog();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen, deleteTarget]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => !q || `${p.name} ${p.categoryName}`.toLowerCase().includes(q));
  }, [products, search]);

  function openCreate() {
    setDraft({ ...EMPTY_DRAFT, categoryId: categories[0]?.id ?? "" });
    setModalMode("create");
    setEditingId(null);
    setSaveError(null);
    setModalOpen(true);
  }

  function openEdit(product: Product) {
    setDraft(draftFromProduct(product));
    setModalMode("edit");
    setEditingId(product.id);
    setSaveError(null);
    setModalOpen(true);
  }

  function toggleFlag(flag: string) {
    setDraft((prev) => ({
      ...prev,
      flags: prev.flags.includes(flag) ? prev.flags.filter((f) => f !== flag) : [...prev.flags, flag],
    }));
  }

  function addTierRow() {
    setDraft((prev) => ({ ...prev, priceTiers: [...prev.priceTiers, { minQty: "", unitPrice: "" }] }));
  }

  function removeTierRow(index: number) {
    setDraft((prev) => ({ ...prev, priceTiers: prev.priceTiers.filter((_, i) => i !== index) }));
  }

  function updateTierRow(index: number, field: "minQty" | "unitPrice", value: string) {
    setDraft((prev) => ({
      ...prev,
      priceTiers: prev.priceTiers.map((t, i) =>
        i === index ? { ...t, [field]: value.replace(/[^0-9]/g, "") } : t,
      ),
    }));
  }

  function handleSave() {
    setSaveError(null);
    if (!draft.name.trim()) {
      setSaveError("Product name is required");
      return;
    }
    if (!draft.categoryId) {
      setSaveError("Select a category (add one first via Manage categories if none exist)");
      return;
    }
    startSaving(async () => {
      const input = {
        name: draft.name,
        categoryId: draft.categoryId,
        unit: draft.unit,
        tokenPrice: Number(draft.tokenPrice) || 0,
        sellPrice: Number(draft.sellPrice) || 0,
        cost: draft.cost === "" ? null : Number(draft.cost),
        description: draft.description || null,
        flags: draft.flags,
        priceTiers: dedupeTiersByMinQty(
          draft.priceTiers
            .map((t) => ({ minQty: Number(t.minQty) || 0, unitPrice: Number(t.unitPrice) || 0 }))
            .filter((t) => t.minQty > 0 && t.unitPrice > 0),
        ),
      };
      const result =
        modalMode === "create"
          ? await createProductAction(clubId, input)
          : await updateProductAction(clubId, editingId!, input);
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      setProducts((prev) =>
        modalMode === "create"
          ? [...prev, result.product]
          : prev.map((p) => (p.id === result.product.id ? result.product : p)),
      );
      showToast(modalMode === "create" ? "Product added" : "Product saved");
      setModalOpen(false);
    });
  }

  async function openDeleteDialog(product: Product) {
    setDeleteTarget(product);
    setDeleteHasHistory(null);
    setDeleteError(null);
    const result = await checkProductHistoryAction(clubId, product.id);
    if (result.ok) {
      setDeleteHasHistory(result.hasHistory);
    } else {
      setDeleteError(result.error);
    }
  }

  function closeDeleteDialog() {
    setDeleteTarget(null);
    setDeleteHasHistory(null);
    setDeleteError(null);
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    startDeleting(async () => {
      const result = await deleteOrDeactivateProductAction(clubId, targetId);
      if (!result.ok) {
        setDeleteError(result.error);
        return;
      }
      if (result.result.action === "deleted") {
        setProducts((prev) => prev.filter((p) => p.id !== targetId));
        showToast("Product deleted");
      } else {
        const nextActive = result.result.action === "reactivated";
        setProducts((prev) => prev.map((p) => (p.id === targetId ? { ...p, active: nextActive } : p)));
        showToast(nextActive ? "Product reactivated" : "Product deactivated");
      }
      closeDeleteDialog();
    });
  }

  return (
    <div>
      <div className="mb-3.5 flex items-center gap-2.5">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products…"
          aria-label="Search products"
          className="w-[260px] rounded-[9px] border border-input bg-card px-3 py-[9px] text-[13px]"
        />
        <button
          type="button"
          onClick={openCreate}
          className="ml-auto rounded-[9px] px-[15px] py-[9px] text-[13px] font-semibold text-white"
          style={{ background: "var(--primary)" }}
        >
          + New product
        </button>
      </div>

      <div className="rounded-card border border-border bg-card">
        {products.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="text-[13.5px] text-[#6b6f66]">
              No products yet — add your first product to get started.
            </div>
            <button
              type="button"
              onClick={openCreate}
              className="rounded-[9px] px-5 py-2.5 text-[13px] font-semibold text-white"
              style={{ background: "var(--primary)" }}
            >
              + New product
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-16 text-center text-[13.5px] text-[#6b6f66]">
            No products match your search.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[2.4fr_1fr_70px_78px_64px_1fr_96px] gap-3 border-b border-border bg-muted px-[18px] py-3 text-[11px] font-semibold uppercase tracking-[.05em] text-[#8a8e83]">
              <div>Product</div>
              <div>Category</div>
              <div>Stock</div>
              <div>Token</div>
              <div>Sell R</div>
              <div>Flags</div>
              <div className="text-right">Actions</div>
            </div>
            {filtered.map((p) => (
              <div
                key={p.id}
                className="grid grid-cols-[2.4fr_1fr_70px_78px_64px_1fr_96px] items-center gap-3 border-b border-[#f4f2ea] px-[18px] py-[13px] last:border-b-0"
              >
                <div className="flex min-w-0 items-center gap-[11px]">
                  <div className="h-[34px] w-[34px] flex-none rounded-lg bg-accent" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-[7px]">
                      <span
                        className={"truncate text-[13.5px] font-medium" + (p.active ? "" : " text-[#a29c8c]")}
                      >
                        {p.name}
                      </span>
                      {!p.active && (
                        <span className="rounded-[4px] bg-[#f0eee6] px-[5px] py-px font-mono text-[9.5px] font-semibold text-[#8a8e83]">
                          inactive
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-[#9a9e93]">{p.unit}</div>
                  </div>
                </div>
                <div className="text-[13px] text-[#4a4e45]">{p.categoryName}</div>
                <div className={"font-mono text-[13px]" + (p.stock <= LOW_STOCK_THRESHOLD ? " text-destructive" : "")}>
                  {p.stock}
                </div>
                <div className="font-mono text-[13px] font-medium text-primary">{p.tokenPrice}</div>
                <div className="font-mono text-[13px] text-[#6b6f66]">R{p.sellPrice}</div>
                <div className="flex flex-wrap gap-1">
                  {p.flags.map((flag) =>
                    flag === "app" ? (
                      <span
                        key={flag}
                        className="rounded-[4px] bg-status-active-bg px-[5px] py-px font-mono text-[9.5px] font-semibold text-status-active-fg"
                      >
                        {FLAG_CHIP_LABELS[flag]}
                      </span>
                    ) : (
                      <span
                        key={flag}
                        className="rounded-[4px] px-[5px] py-px font-mono text-[9.5px] font-semibold"
                        style={
                          flag === "gift"
                            ? { background: "#f6efe0", color: "#8a6d3b" }
                            : { background: "#f0eee6", color: "#6b6f66" }
                        }
                      >
                        {FLAG_CHIP_LABELS[flag]}
                      </span>
                    ),
                  )}
                </div>
                <div className="flex justify-end gap-[6px]">
                  <button
                    type="button"
                    onClick={() => openEdit(p)}
                    title="Edit"
                    className="h-[30px] w-[30px] rounded-[7px] border border-input text-[13px] text-[#6b6f66]"
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    onClick={() => openDeleteDialog(p)}
                    title="Delete"
                    className="h-[30px] w-[30px] rounded-[7px] border border-input text-[14px] text-destructive"
                  >
                    🗑
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {modalOpen && (
        <div
          role="presentation"
          onClick={() => setModalOpen(false)}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(22,26,21,.45)] p-6"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={modalMode === "create" ? "New product" : "Edit product"}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] w-[560px] max-w-full overflow-y-auto rounded-2xl bg-card shadow-2xl"
          >
            <div className="flex items-center border-b border-[#eeece4] px-[22px] py-[18px]">
              <div className="font-heading text-lg font-bold">
                {modalMode === "create" ? "New product" : "Edit product"}
              </div>
              <button type="button" onClick={() => setModalOpen(false)} className="ml-auto text-xl text-[#9a9e93]">
                ×
              </button>
            </div>
            <div className="p-[22px]">
              <div className="mb-3.5">
                <label htmlFor="productName" className="mb-1 block text-[11px] text-[#8a8e83]">
                  Product name *
                </label>
                <input
                  id="productName"
                  required
                  value={draft.name}
                  onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g. Durban Poison"
                  className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
                />
              </div>
              <div className="mb-3.5 grid grid-cols-2 gap-3.5">
                <div>
                  <label htmlFor="productCategory" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Category
                  </label>
                  <select
                    id="productCategory"
                    value={draft.categoryId}
                    onChange={(e) => setDraft((prev) => ({ ...prev, categoryId: e.target.value }))}
                    className="w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
                  >
                    {categories.length === 0 && <option value="">No categories yet</option>}
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {categories.length === 0 && (
                    <p className="mt-1 text-[11px] text-[#9a9e93]">
                      Add a category first via Manage categories above.
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="productUnit" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Unit
                  </label>
                  <input
                    id="productUnit"
                    value={draft.unit}
                    onChange={(e) => setDraft((prev) => ({ ...prev, unit: e.target.value }))}
                    placeholder="per 1g / each / pack"
                    className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
                  />
                </div>
              </div>
              <div className="mb-3.5 grid grid-cols-3 gap-3.5">
                <div>
                  <label htmlFor="productToken" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Token price
                  </label>
                  <input
                    id="productToken"
                    inputMode="numeric"
                    value={draft.tokenPrice}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, tokenPrice: e.target.value.replace(/[^0-9]/g, "") }))
                    }
                    placeholder="45"
                    className="w-full rounded-[9px] border border-input px-3 py-2.5 font-mono text-[13px]"
                  />
                </div>
                <div>
                  <label htmlFor="productCost" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Cost R
                  </label>
                  <input
                    id="productCost"
                    inputMode="decimal"
                    value={draft.cost}
                    onChange={(e) => setDraft((prev) => ({ ...prev, cost: e.target.value.replace(/[^0-9.]/g, "") }))}
                    placeholder="40"
                    className="w-full rounded-[9px] border border-input px-3 py-2.5 font-mono text-[13px]"
                  />
                </div>
                <div>
                  <label htmlFor="productSell" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Sell R
                  </label>
                  <input
                    id="productSell"
                    inputMode="decimal"
                    value={draft.sellPrice}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, sellPrice: e.target.value.replace(/[^0-9.]/g, "") }))
                    }
                    placeholder="60"
                    className="w-full rounded-[9px] border border-input px-3 py-2.5 font-mono text-[13px]"
                  />
                </div>
              </div>
              <div className="mb-3.5">
                <label htmlFor="productDescription" className="mb-1 block text-[11px] text-[#8a8e83]">
                  Description
                </label>
                <textarea
                  id="productDescription"
                  value={draft.description}
                  onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="Optional notes shown internally"
                  className="min-h-[60px] w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
                />
              </div>
              <div className="mb-4">
                <div className="mb-[7px] text-[11px] text-[#8a8e83]">Flags</div>
                <div className="flex gap-2">
                  {(["app", "gift", "nodisc"] as const).map((flag) => (
                    <button
                      key={flag}
                      type="button"
                      onClick={() => toggleFlag(flag)}
                      className="rounded-[8px] border px-3 py-[7px] text-[12.5px] font-medium"
                      style={
                        draft.flags.includes(flag)
                          ? { background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }
                          : { background: "var(--card)", borderColor: "var(--border)", color: "#4a4e45" }
                      }
                    >
                      {FLAG_LABELS[flag]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mb-4">
                <div className="mb-[7px] flex items-center justify-between">
                  <div className="text-[11px] text-[#8a8e83]">Bulk pricing</div>
                  <button
                    type="button"
                    onClick={addTierRow}
                    className="rounded-[6px] border border-input bg-muted px-2 py-1 text-[11px] font-medium text-[#6b6f66]"
                  >
                    + Add price break
                  </button>
                </div>
                {draft.priceTiers.length === 0 ? (
                  <p className="text-[11.5px] text-[#9a9e93]">
                    No bulk pricing configured — every quantity charges the token price above.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {draft.priceTiers.map((tier, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <div className="flex-1">
                          <label htmlFor={`tierMinQty-${index}`} className="sr-only">
                            Minimum quantity
                          </label>
                          <input
                            id={`tierMinQty-${index}`}
                            inputMode="numeric"
                            value={tier.minQty}
                            onChange={(e) => updateTierRow(index, "minQty", e.target.value)}
                            placeholder="Qty (e.g. 10)"
                            className="w-full rounded-[8px] border border-input px-2.5 py-2 font-mono text-[12.5px]"
                          />
                        </div>
                        <span className="text-[11px] text-[#9a9e93]">at</span>
                        <div className="flex-1">
                          <label htmlFor={`tierUnitPrice-${index}`} className="sr-only">
                            Price per unit at this quantity
                          </label>
                          <input
                            id={`tierUnitPrice-${index}`}
                            inputMode="numeric"
                            value={tier.unitPrice}
                            onChange={(e) => updateTierRow(index, "unitPrice", e.target.value)}
                            placeholder="Tok/unit (e.g. 100)"
                            className="w-full rounded-[8px] border border-input px-2.5 py-2 font-mono text-[12.5px]"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => removeTierRow(index)}
                          title="Remove price break"
                          className="h-[30px] w-[30px] flex-none rounded-[7px] border border-input text-[13px] text-destructive"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {modalMode === "edit" && (
                <div className="mb-4 flex items-start gap-2 rounded-[9px] border border-dashed border-[#d6d2c5] bg-muted px-[13px] py-[11px] text-[12px] text-[#7c7f74]">
                  <span>🔒</span>
                  <span>Stock isn&apos;t editable here — it&apos;s owned by the Inventory ledger.</span>
                </div>
              )}
              {saveError && <p className="mb-3 text-[12.5px] text-destructive">{saveError}</p>}
              <div className="flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-[9px] border border-input bg-muted px-[18px] py-2.5 text-[13px] text-[#4a4e45]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="rounded-[9px] px-5 py-2.5 text-[13px] font-semibold text-white"
                  style={{ background: "var(--primary)" }}
                >
                  {isSaving ? "Saving…" : "Save product"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div
          role="presentation"
          onClick={closeDeleteDialog}
          className="fixed inset-0 z-[72] flex items-center justify-center bg-[rgba(22,26,21,.45)] p-6"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Confirm product removal"
            onClick={(e) => e.stopPropagation()}
            className="w-[400px] max-w-full rounded-2xl bg-card p-6 shadow-2xl"
          >
            {deleteHasHistory === null && !deleteError ? (
              <div className="text-[13px] text-[#6b6f66]">Checking product history…</div>
            ) : deleteError ? (
              <>
                <div className="mb-3 font-heading text-lg font-bold">Something went wrong</div>
                <p className="mb-5 text-[13px] text-destructive">{deleteError}</p>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={closeDeleteDialog}
                    className="rounded-[9px] border border-input bg-muted px-[18px] py-2.5 text-[13px] text-[#4a4e45]"
                  >
                    Close
                  </button>
                </div>
              </>
            ) : deleteHasHistory ? (
              <>
                <div className="mb-1.5 font-heading text-lg font-bold">Can&apos;t delete {deleteTarget.name}</div>
                <p className="mb-5 text-[13px] text-[#6b6f66]">
                  It has inventory movements on record. History is immutable, so this product can only be{" "}
                  {deleteTarget.active ? "deactivated" : "reactivated"}.
                </p>
                <div className="flex justify-end gap-2.5">
                  <button
                    type="button"
                    onClick={closeDeleteDialog}
                    className="rounded-[9px] border border-input bg-muted px-[18px] py-2.5 text-[13px] text-[#4a4e45]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={confirmDelete}
                    disabled={isDeleting}
                    className="rounded-[9px] px-5 py-2.5 text-[13px] font-semibold"
                    style={{ background: "#f6efe0", color: "#8a6d3b" }}
                  >
                    {isDeleting ? "Working…" : deleteTarget.active ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mb-1.5 font-heading text-lg font-bold">Delete product?</div>
                <p className="mb-5 text-[13px] text-[#6b6f66]">
                  <b>{deleteTarget.name}</b> has no inventory history, so it can be permanently removed. This
                  can&apos;t be undone.
                </p>
                <div className="flex justify-end gap-2.5">
                  <button
                    type="button"
                    onClick={closeDeleteDialog}
                    className="rounded-[9px] border border-input bg-muted px-[18px] py-2.5 text-[13px] text-[#4a4e45]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={confirmDelete}
                    disabled={isDeleting}
                    className="rounded-[9px] px-5 py-2.5 text-[13px] font-semibold text-white"
                    style={{ background: "var(--destructive)" }}
                  >
                    {isDeleting ? "Deleting…" : "Delete permanently"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
