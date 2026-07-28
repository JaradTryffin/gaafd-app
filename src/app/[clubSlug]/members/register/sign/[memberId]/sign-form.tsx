"use client";

import { useRef, useState, useTransition } from "react";
import { SignaturePad, type SignaturePadHandle } from "@/components/sign/signature-pad";
import { completeSignAction } from "./actions";
import type { ContractClause } from "@/lib/contracts";

export function SignAgreementForm({
  clubSlug,
  clubId,
  clubName,
  memberId,
  memberName,
  template,
}: {
  clubSlug: string;
  clubId: string;
  clubName: string;
  memberId: string;
  memberName: string;
  template: { title: string; subtitle: string; consent: string; clauses: ContractClause[]; version: number };
}) {
  const [consent, setConsent] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const [printedName, setPrintedName] = useState(memberName);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const padRef = useRef<SignaturePadHandle>(null);

  const canSign = consent && hasInk && !isPending;
  const signDate = new Date().toLocaleDateString("en-ZA");

  function handleSign() {
    const dataUrl = padRef.current?.toDataURL();
    if (!dataUrl) {
      setError("Add a signature before signing.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await completeSignAction({
        clubSlug,
        clubId,
        memberId,
        printedName,
        consent,
        signaturePngBase64: dataUrl,
        template: {
          title: template.title,
          subtitle: template.subtitle,
          consent: template.consent,
          clauses: template.clauses,
          version: template.version,
        },
      });
      if (result?.error) {
        setError(result.error);
      }
    });
  }

  return (
    <div className="max-w-[840px]">
      <div className="overflow-hidden rounded-card border border-border bg-card">
        <div className="px-[22px] pb-1.5 pt-5">
          <div className="font-heading text-lg font-bold">{template.title}</div>
          <div className="mt-1 whitespace-pre-line text-[12.5px] text-[#6b6f66]">
            {template.subtitle}
          </div>
        </div>
        <div className="m-[22px] max-h-[320px] overflow-y-auto rounded-[11px] border border-border bg-muted px-[18px] py-4">
          {template.clauses.map((clause, index) => (
            <div key={index} className="mb-3.5">
              <div className="font-heading text-[13.5px] font-semibold">
                {index + 1}. {clause.heading}
              </div>
              <div className="mt-1 whitespace-pre-line text-[12.5px] leading-[1.55] text-[#4a4e45]">
                {clause.body}
              </div>
            </div>
          ))}
        </div>
        <div className="px-[22px] pb-[22px] pt-2">
          <label className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-border bg-muted p-3.5 text-[12.5px] text-[#4a4e45]">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-primary"
            />
            <span>{template.consent}</span>
          </label>

          <div className="mt-4 grid grid-cols-[1.4fr_1fr] gap-3.5">
            <div>
              <label htmlFor="printedName" className="mb-1 block text-[11px] text-[#8a8e83]">
                Printed name (optional)
              </label>
              <input
                id="printedName"
                value={printedName}
                onChange={(e) => setPrintedName(e.target.value)}
                placeholder="Member's name for records"
                className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
              />
            </div>
            <div>
              <label htmlFor="signDate" className="mb-1 block text-[11px] text-[#8a8e83]">
                Date
              </label>
              <input
                id="signDate"
                value={signDate}
                readOnly
                className="w-full rounded-[9px] border border-input bg-muted px-3 py-2.5 font-mono text-[13px] text-[#6b6f66]"
              />
            </div>
          </div>

          <div className="mt-3.5">
            <div className="mb-1 flex items-center">
              <label className="text-[11px] text-[#8a8e83]">
                Signature — sign with your finger or Apple Pencil
              </label>
              <button
                type="button"
                onClick={() => padRef.current?.clear()}
                className="ml-auto text-[11.5px] text-[#6b6f66] hover:text-destructive"
              >
                Clear
              </button>
            </div>
            <div className="relative h-[150px] overflow-hidden rounded-xl border border-input bg-card">
              <SignaturePad ref={padRef} onInkChange={setHasInk} />
              {!hasInk && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-serif text-[22px] italic text-[#d8d5cb]">
                  Sign here
                </div>
              )}
              <div className="pointer-events-none absolute bottom-[26px] left-[18px] right-[18px] border-b border-[#ece9df]" />
              <div className="pointer-events-none absolute bottom-2 right-3.5 font-mono text-[9.5px] tracking-[.04em] text-[#b7b3a6]">
                e-signature · {clubName}
              </div>
            </div>
          </div>

          {error && <p className="mt-3 text-[12.5px] text-destructive">{error}</p>}

          <div className="mt-5 flex items-center justify-end gap-2.5">
            {!canSign && !error && (
              <span className="mr-auto text-[11.5px] text-[#a29c8c]">
                Tick consent and add a signature to enable
              </span>
            )}
            <a
              href={`/${clubSlug}/members/register`}
              className="rounded-[9px] border border-input bg-muted px-[18px] py-2.5 text-[13px] text-[#4a4e45]"
            >
              Back
            </a>
            <button
              type="button"
              disabled={!canSign}
              onClick={handleSign}
              className="rounded-[9px] px-5 py-2.5 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#e4e1d7] disabled:text-[#a29c8c]"
              style={canSign ? { background: "var(--primary)" } : undefined}
            >
              {isPending ? "Signing…" : "Sign & complete registration"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
