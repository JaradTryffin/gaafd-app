"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/lib/toast-context";
import { createCategoryAction, renameCategoryAction, deleteCategoryAction } from "./actions";
import type { ProductCategoryRow } from "@/lib/categories";

export function CategoriesPanel({
  clubId,
  categories: initialCategories,
}: {
  clubId: string;
  categories: ProductCategoryRow[];
}) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [categories, setCategories] = useState(initialCategories);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleAdd() {
    setError(null);
    if (!newName.trim()) {
      setError("Enter a category name");
      return;
    }
    startTransition(async () => {
      const result = await createCategoryAction(clubId, newName.trim());
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCategories((prev) => [...prev, result.category].sort((a, b) => a.name.localeCompare(b.name)));
      setNewName("");
      showToast("Category added");
    });
  }

  function startRename(category: ProductCategoryRow) {
    setEditingId(category.id);
    setEditingName(category.name);
    setError(null);
  }

  function handleRename(categoryId: string) {
    setError(null);
    if (!editingName.trim()) {
      setError("Enter a category name");
      return;
    }
    startTransition(async () => {
      const result = await renameCategoryAction(clubId, categoryId, editingName.trim());
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCategories((prev) =>
        prev.map((c) => (c.id === categoryId ? result.category : c)).sort((a, b) => a.name.localeCompare(b.name)),
      );
      setEditingId(null);
      showToast("Category renamed");
    });
  }

  function handleDelete(categoryId: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteCategoryAction(clubId, categoryId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCategories((prev) => prev.filter((c) => c.id !== categoryId));
      showToast("Category deleted");
    });
  }

  return (
    <div className="mb-3.5 rounded-card border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between px-[18px] py-3 text-left"
      >
        <span className="font-heading text-[14px] font-semibold">Manage categories</span>
        <span className="text-[12px] text-[#9a9e93]">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="border-t border-[#f0eee6] px-[18px] py-3.5">
          {categories.length === 0 ? (
            <p className="mb-3 text-[12.5px] text-[#9a9e93]">No categories yet — add one below.</p>
          ) : (
            <div className="mb-3 flex flex-col gap-2">
              {categories.map((c) => (
                <div key={c.id} className="flex items-center gap-2">
                  {editingId === c.id ? (
                    <>
                      <label htmlFor={`categoryRename-${c.id}`} className="sr-only">
                        Category name
                      </label>
                      <input
                        id={`categoryRename-${c.id}`}
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        className="flex-1 rounded-[8px] border border-input px-2.5 py-2 text-[12.5px]"
                      />
                      <button
                        type="button"
                        onClick={() => handleRename(c.id)}
                        disabled={isPending}
                        className="rounded-[6px] border border-input bg-muted px-2 py-1 text-[11px] font-medium text-[#6b6f66]"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="rounded-[6px] border border-input bg-muted px-2 py-1 text-[11px] font-medium text-[#6b6f66]"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 text-[13px]">{c.name}</span>
                      <button
                        type="button"
                        onClick={() => startRename(c)}
                        title="Rename"
                        className="h-[28px] w-[28px] rounded-[7px] border border-input text-[12px] text-[#6b6f66]"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(c.id)}
                        disabled={isPending}
                        title="Delete"
                        className="h-[28px] w-[28px] rounded-[7px] border border-input text-[13px] text-destructive"
                      >
                        🗑
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          {error && <p className="mb-2 text-[12px] text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <label htmlFor="newCategoryName" className="sr-only">
              New category name
            </label>
            <input
              id="newCategoryName"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New category name"
              className="flex-1 rounded-[8px] border border-input px-2.5 py-2 text-[12.5px]"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={isPending}
              className="rounded-[8px] border border-input bg-muted px-3 py-2 text-[12.5px] font-medium text-[#6b6f66]"
            >
              + Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
