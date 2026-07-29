"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useToast } from "@/lib/toast-context";
import { createMovementAction } from "./actions";
import type { Movement, MovementType, LoggableMovementType } from "@/lib/inventory";
import type { Product } from "@/lib/products";

const TYPE_FILTERS: (MovementType | "All")[] = ["All", "PURCHASE", "SALE", "ADJUSTMENT", "WASTE"];
const LOGGABLE_TYPES: LoggableMovementType[] = ["PURCHASE", "ADJUSTMENT", "WASTE"];

const TYPE_TAG_STYLE: Record<MovementType, { background: string; color: string }> = {
  PURCHASE: { background: "var(--status-active-bg)", color: "var(--status-active-fg)" },
  SALE: { background: "#eef0f6", color: "#4a5e8a" },
  ADJUSTMENT: { background: "#f6efe0", color: "#8a6d3b" },
  WASTE: { background: "#f8e9e4", color: "#b4432f" },
};

type MovementDraft = {
  productId: string;
  type: LoggableMovementType;
  qty: string;
  cost: string;
  batch: string;
  expiry: string;
};

function emptyDraft(products: Product[]): MovementDraft {
  return {
    productId: products[0]?.id ?? "",
    type: "PURCHASE",
    qty: "",
    cost: "",
    batch: "",
    expiry: "",
  };
}

function hintForType(type: LoggableMovementType): string {
  if (type === "PURCHASE") return "Increments product stock";
  if (type === "WASTE") return "Decrements product stock";
  return "Signed adjustment — prefix with − to reduce";
}

function formatQty(qty: number, unit: string): string {
  const suffix = unit.includes("g") ? "g" : "";
  return (qty > 0 ? "+" : "−") + Math.abs(qty) + suffix;
}

export function InventoryTable({
  clubId,
  products,
  movements: initialMovements,
}: {
  clubId: string;
  products: Product[];
  movements: Movement[];
}) {
  const { showToast } = useToast();
  const [movements, setMovements] = useState(initialMovements);
  const [productFilter, setProductFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<MovementType | "All">("All");

  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<MovementDraft>(() => emptyDraft(products));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && modalOpen) setModalOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [modalOpen]);

  const filtered = useMemo(() => {
    return movements
      .filter((m) => productFilter === "all" || m.productId === productFilter)
      .filter((m) => typeFilter === "All" || m.type === typeFilter);
  }, [movements, productFilter, typeFilter]);

  function openModal() {
    setDraft(emptyDraft(products));
    setSaveError(null);
    setModalOpen(true);
  }

  function handleSave() {
    setSaveError(null);
    const qtyNum = Number(draft.qty);
    if (!draft.productId) {
      setSaveError("Select a product");
      return;
    }
    if (!Number.isFinite(qtyNum) || qtyNum === 0 || !Number.isInteger(qtyNum)) {
      setSaveError("Enter a valid, non-zero whole-number quantity");
      return;
    }
    startSaving(async () => {
      const result = await createMovementAction(clubId, {
        productId: draft.productId,
        type: draft.type,
        qty: qtyNum,
        cost: draft.cost === "" ? null : Number(draft.cost),
        batch: draft.batch || null,
        expiry: draft.expiry || null,
      });
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      setMovements((prev) => [result.movement, ...prev]);
      showToast(
        `${result.movement.type} logged · ${result.movement.productName} stock now ${result.newStock}`,
      );
      setModalOpen(false);
    });
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <select
          value={productFilter}
          onChange={(e) => setProductFilter(e.target.value)}
          aria-label="Filter by product"
          className="rounded-[9px] border border-input bg-card px-3 py-[9px] text-[13px]"
        >
          <option value="all">All products</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap gap-[7px]">
          {TYPE_FILTERS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTypeFilter(t)}
              className="rounded-[8px] border px-3 py-[7px] text-[12.5px] font-medium"
              style={
                typeFilter === t
                  ? { background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }
                  : { background: "var(--card)", borderColor: "var(--border)", color: "#4a4e45" }
              }
            >
              {t === "All" ? "All types" : t}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={openModal}
          disabled={products.length === 0}
          title={products.length === 0 ? "Add a product first" : undefined}
          className="ml-auto rounded-[9px] px-[15px] py-[9px] text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#e4e1d7] disabled:text-[#a29c8c]"
          style={products.length > 0 ? { background: "var(--primary)" } : undefined}
        >
          + Log movement
        </button>
      </div>

      <div className="mb-3.5 flex items-start gap-2 rounded-[10px] border border-border bg-muted px-[13px] py-[9px] text-[12px] leading-[1.5] text-[#7c7f74]">
        <span className="flex-none text-[13px]">🔒</span>
        <span>
          Movements are an immutable audit trail — entries can&apos;t be edited or deleted. Correct mistakes
          by appending an ADJUSTMENT or WASTE.
        </span>
      </div>

      <div className="rounded-card border border-border bg-card">
        {movements.length === 0 ? (
          <div className="px-6 py-16 text-center text-[13.5px] text-[#6b6f66]">
            No movements yet — log your first inventory movement to get started.
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-16 text-center text-[13.5px] text-[#6b6f66]">
            No movements match your filters.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[110px_2fr_90px_90px_1fr_140px_100px] gap-3 border-b border-border bg-muted px-[18px] py-3 text-[11px] font-semibold uppercase tracking-[.05em] text-[#8a8e83]">
              <div>Type</div>
              <div>Product</div>
              <div>Qty</div>
              <div>Cost R</div>
              <div>Batch / expiry</div>
              <div>Staff</div>
              <div>Date</div>
            </div>
            {filtered.map((m) => (
              <div
                key={m.id}
                className="grid grid-cols-[110px_2fr_90px_90px_1fr_140px_100px] items-center gap-3 border-b border-[#f4f2ea] px-[18px] py-3 last:border-b-0"
              >
                <div>
                  <span
                    className="rounded-[5px] px-2 py-[3px] font-mono text-[10.5px] font-semibold"
                    style={TYPE_TAG_STYLE[m.type]}
                  >
                    {m.type}
                  </span>
                </div>
                <div className="truncate text-[13px] font-medium">{m.productName}</div>
                <div
                  className={
                    "font-mono text-[13px] font-semibold " +
                    (m.qty >= 0 ? "text-primary" : "text-destructive")
                  }
                >
                  {formatQty(m.qty, productById.get(m.productId)?.unit ?? "")}
                </div>
                <div className="font-mono text-[13px] text-[#6b6f66]">
                  {m.cost === null ? "—" : `R${m.cost}`}
                </div>
                <div className="truncate font-mono text-[11.5px] text-[#8a8e83]">
                  {m.batch
                    ? m.expiry
                      ? `${m.batch} · exp ${m.expiry}`
                      : m.batch
                    : m.expiry
                      ? `exp ${m.expiry}`
                      : "—"}
                </div>
                <div className="truncate text-[12px] text-[#6b6f66]">{m.staffEmail ?? "—"}</div>
                <div className="text-[11px] text-[#9a9e93]">
                  {new Date(m.createdAt).toLocaleDateString("en-ZA", { day: "2-digit", month: "short" })}
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
            aria-label="Log inventory movement"
            onClick={(e) => e.stopPropagation()}
            className="w-[480px] max-w-full rounded-2xl bg-card shadow-2xl"
          >
            <div className="flex items-center border-b border-[#eeece4] px-[22px] py-[18px]">
              <div className="font-heading text-lg font-bold">Log inventory movement</div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="ml-auto text-xl text-[#9a9e93]"
              >
                ×
              </button>
            </div>
            <div className="p-[22px]">
              <div className="mb-3.5">
                <label htmlFor="movementProduct" className="mb-1 block text-[11px] text-[#8a8e83]">
                  Product
                </label>
                <select
                  id="movementProduct"
                  value={draft.productId}
                  onChange={(e) => setDraft((prev) => ({ ...prev, productId: e.target.value }))}
                  className="w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
                >
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mb-1.5 grid grid-cols-2 gap-3.5">
                <div>
                  <label htmlFor="movementType" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Type
                  </label>
                  <select
                    id="movementType"
                    value={draft.type}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, type: e.target.value as LoggableMovementType }))
                    }
                    className="w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
                  >
                    {LOGGABLE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="movementQty" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Quantity
                  </label>
                  <input
                    id="movementQty"
                    inputMode="decimal"
                    value={draft.qty}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, qty: e.target.value.replace(/[^0-9-]/g, "") }))
                    }
                    placeholder="e.g. 100 or -4"
                    className="w-full rounded-[9px] border border-input px-3 py-2.5 font-mono text-[13px]"
                  />
                </div>
              </div>
              <div className="mb-3.5 text-[11.5px] text-[#8a6d3b]">{hintForType(draft.type)}</div>
              <div className="mb-4 grid grid-cols-3 gap-3.5">
                <div>
                  <label htmlFor="movementCost" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Cost R
                  </label>
                  <input
                    id="movementCost"
                    inputMode="decimal"
                    value={draft.cost}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, cost: e.target.value.replace(/[^0-9.]/g, "") }))
                    }
                    placeholder="opt."
                    className="w-full rounded-[9px] border border-input px-3 py-2.5 font-mono text-[13px]"
                  />
                </div>
                <div>
                  <label htmlFor="movementBatch" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Batch #
                  </label>
                  <input
                    id="movementBatch"
                    value={draft.batch}
                    onChange={(e) => setDraft((prev) => ({ ...prev, batch: e.target.value }))}
                    placeholder="opt."
                    className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
                  />
                </div>
                <div>
                  <label htmlFor="movementExpiry" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Expiry
                  </label>
                  <input
                    id="movementExpiry"
                    type="date"
                    value={draft.expiry}
                    onChange={(e) => setDraft((prev) => ({ ...prev, expiry: e.target.value }))}
                    className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
                  />
                </div>
              </div>
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
                  {isSaving ? "Posting…" : "Post movement"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
