"use client";

import { useState } from "react";
import { useClub } from "@/lib/club-context";
import { usePageHeader } from "@/lib/page-header-context";
import { useToast } from "@/lib/toast-context";
import { saveContractTemplateAction, resetContractTemplateAction } from "./actions";
import type { ContractClause, ContractTemplate } from "@/lib/contracts";

export function ContractEditor({ initialTemplate }: { initialTemplate: ContractTemplate }) {
  const club = useClub();
  const { showToast } = useToast();
  usePageHeader({
    title: "Membership agreement",
    subtitle: "Shown to every new member at registration and signed before their first dispense.",
  });

  const [title, setTitle] = useState(initialTemplate.title);
  const [subtitle, setSubtitle] = useState(initialTemplate.subtitle);
  const [consent, setConsent] = useState(initialTemplate.consent);
  const [clauses, setClauses] = useState<ContractClause[]>(initialTemplate.clauses);
  const [saving, setSaving] = useState(false);

  function updateClause(index: number, field: "heading" | "body", value: string) {
    setClauses((prev) => prev.map((c, i) => (i === index ? { ...c, [field]: value } : c)));
  }

  function addClause() {
    setClauses((prev) => [...prev, { heading: "", body: "" }]);
  }

  function removeClause(index: number) {
    setClauses((prev) => prev.filter((_, i) => i !== index));
  }

  function moveClause(index: number, direction: -1 | 1) {
    setClauses((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    const result = await saveContractTemplateAction(club.clubId, { title, subtitle, consent, clauses });
    setSaving(false);
    if (result.ok) {
      showToast("Template saved");
    } else {
      showToast(result.error, "error");
    }
  }

  async function handleReset() {
    setSaving(true);
    const result = await resetContractTemplateAction(club.clubId, club.name);
    setSaving(false);
    if (result.ok) {
      setTitle(result.template.title);
      setSubtitle(result.template.subtitle);
      setConsent(result.template.consent);
      setClauses(result.template.clauses);
      showToast("Template reset to default");
    } else {
      showToast(result.error, "error");
    }
  }

  return (
    <div className="grid grid-cols-2 items-start gap-4">
      <div className="rounded-card border border-border bg-card p-5">
        <div className="mb-1 flex items-center gap-2.5">
          <div className="font-heading text-lg font-bold">Membership agreement</div>
          <span className="ml-auto rounded-[5px] bg-accent px-2 py-0.5 font-mono text-[10.5px] text-[var(--status-active-fg)]">
            {club.name}
          </span>
        </div>
        <p className="mb-4 text-[12.5px] text-[#6b6f66]">Each club maintains its own version.</p>

        <label htmlFor="contractTitle" className="mb-1 block text-[11px] text-[#8a8e83]">
          Agreement title
        </label>
        <input
          id="contractTitle"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mb-3 w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
        />
        <label htmlFor="contractSubtitle" className="mb-1 block text-[11px] text-[#8a8e83]">
          Subtitle / preamble
        </label>
        <textarea
          id="contractSubtitle"
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          rows={2}
          className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px] leading-relaxed"
        />

        <div className="mb-2.5 mt-5 flex items-center">
          <div className="font-heading text-sm font-semibold">Clauses</div>
          <span className="ml-2 font-mono text-[10.5px] text-[#8a8e83]">{clauses.length}</span>
        </div>
        {clauses.map((clause, index) => (
          <div key={index} className="mb-2.5 rounded-[11px] border border-border bg-muted p-3">
            <div className="mb-2 flex items-center gap-1.5">
              <span className="font-mono text-xs font-semibold text-[var(--status-active-fg)]">
                {index + 1}
              </span>
              <input
                value={clause.heading}
                onChange={(e) => updateClause(index, "heading", e.target.value)}
                placeholder="Clause heading"
                aria-label={`Clause ${index + 1} heading`}
                className="min-w-0 flex-1 rounded-[7px] border border-input bg-card px-2.5 py-1.5 text-[12.5px] font-semibold"
              />
              <button
                type="button"
                onClick={() => moveClause(index, -1)}
                title="Move up"
                className="h-[26px] w-[26px] rounded-[6px] border border-input bg-card text-xs text-[#8a8e83]"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => moveClause(index, 1)}
                title="Move down"
                className="h-[26px] w-[26px] rounded-[6px] border border-input bg-card text-xs text-[#8a8e83]"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => removeClause(index)}
                title="Remove clause"
                className="h-[26px] w-[26px] rounded-[6px] border border-input bg-card text-xs text-destructive"
              >
                ✕
              </button>
            </div>
            <textarea
              value={clause.body}
              onChange={(e) => updateClause(index, "body", e.target.value)}
              placeholder="Clause text…"
              aria-label={`Clause ${index + 1} body`}
              rows={3}
              className="w-full rounded-[7px] border border-input bg-card px-2.5 py-2 text-[12.5px] leading-relaxed"
            />
          </div>
        ))}
        <button
          type="button"
          onClick={addClause}
          className="w-full rounded-[10px] border border-dashed border-[var(--border-dashed)] py-2.5 text-[12.5px] text-[#6b6f66]"
        >
          + Add clause
        </button>

        <label htmlFor="contractConsent" className="mb-1 mt-4 block text-[11px] text-[#8a8e83]">
          Consent statement (shown beside the signature checkbox)
        </label>
        <textarea
          id="contractConsent"
          value={consent}
          onChange={(e) => setConsent(e.target.value)}
          rows={2}
          className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[12.5px] leading-relaxed"
        />

        <div className="mt-5 flex gap-2.5">
          <button
            type="button"
            onClick={handleReset}
            disabled={saving}
            className="rounded-[9px] border border-input bg-muted px-4 py-2.5 text-[13px] text-[#4a4e45]"
          >
            Reset to default
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="ml-auto rounded-[9px] px-5 py-2.5 text-[13px] font-semibold text-white"
            style={{ background: "var(--primary)" }}
          >
            Save template
          </button>
        </div>
      </div>

      <div className="sticky top-0">
        <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[.08em] text-[#8a8e83]">
          Member-facing preview
        </div>
        <div className="overflow-hidden rounded-card border border-border bg-card">
          <div className="px-[22px] pb-1.5 pt-5">
            <div className="font-heading text-[17px] font-bold">{title}</div>
            <div className="mt-1 whitespace-pre-line text-xs text-[#6b6f66]">{subtitle}</div>
          </div>
          <div className="mx-[22px] mt-3 max-h-[360px] overflow-y-auto border-t border-[#efece3] pt-3.5">
            {clauses.map((clause, index) => (
              <div key={index} className="mb-3">
                <div className="font-heading text-[13px] font-semibold">
                  {index + 1}. {clause.heading}
                </div>
                <div className="mt-0.5 whitespace-pre-line text-xs leading-[1.55] text-[#4a4e45]">
                  {clause.body}
                </div>
              </div>
            ))}
          </div>
          <div className="mx-[22px] mb-5 border-t border-[#efece3] pt-3.5">
            <label className="flex items-start gap-2 text-[11.5px] text-[#6b6f66]">
              <span className="mt-0.5 h-[15px] w-[15px] flex-none rounded border-[1.5px] border-[var(--border-dashed)]" />
              <span>{consent}</span>
            </label>
            <div className="mt-3 flex h-14 items-center rounded-[9px] border border-border px-3.5 font-serif text-xl italic text-[#c4c0b3]">
              Signature
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
