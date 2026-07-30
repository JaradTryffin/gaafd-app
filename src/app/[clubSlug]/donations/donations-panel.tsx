"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/lib/toast-context";
import { recordDonationAction } from "./actions";
import type { Donation, DonationMethod } from "@/lib/donations";
import type { MemberListRow } from "@/lib/members";

const METHODS: DonationMethod[] = ["Cash", "Card", "EFT"];

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
}

export function DonationsPanel({
  clubId,
  members,
  donations: initialDonations,
}: {
  clubId: string;
  members: MemberListRow[];
  donations: Donation[];
}) {
  const { showToast } = useToast();
  const [donations, setDonations] = useState(initialDonations);
  const [memberId, setMemberId] = useState(members[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<DonationMethod>("Cash");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();

  const amountNum = Number(amount) || 0;

  function handleRecord() {
    setError(null);
    if (!memberId) {
      setError("Select a member");
      return;
    }
    if (amountNum <= 0) {
      setError("Enter a valid amount");
      return;
    }
    startSaving(async () => {
      const result = await recordDonationAction(clubId, { memberId, amountRand: amountNum, method });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDonations((prev) => [result.donation, ...prev]);
      showToast(`Donation recorded · +${result.donation.tokensCredited} tokens credited`);
      setAmount("");
      setMethod("Cash");
    });
  }

  return (
    <div className="grid grid-cols-[380px_1fr] items-start gap-4">
      <div className="rounded-card border border-border bg-card p-5">
        <div className="mb-1 font-heading text-base font-semibold">Record donation</div>
        <p className="mb-4 text-[12px] text-[#6b6f66]">Cash donation converts 1:1 into tokens.</p>

        <label htmlFor="donationMember" className="mb-1 block text-[11px] text-[#8a8e83]">
          Member
        </label>
        <select
          id="donationMember"
          value={memberId}
          onChange={(e) => setMemberId(e.target.value)}
          className="mb-3.5 w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
        >
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.first} {m.last} ({m.code})
            </option>
          ))}
        </select>

        <label htmlFor="donationAmount" className="mb-1 block text-[11px] text-[#8a8e83]">
          Amount (R)
        </label>
        <input
          id="donationAmount"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
          className="mb-3.5 w-full rounded-[9px] border border-input px-3 py-3 font-mono text-xl font-semibold"
        />

        <div className="mb-1.5 text-[11px] text-[#8a8e83]">Method</div>
        <div className="mb-4 flex gap-2">
          {METHODS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMethod(m)}
              className="rounded-[8px] border px-3 py-[7px] text-[12.5px] font-medium"
              style={
                method === m
                  ? { background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }
                  : { background: "var(--card)", borderColor: "var(--border)", color: "#4a4e45" }
              }
            >
              {m}
            </button>
          ))}
        </div>

        <div
          className="mb-4 flex items-center justify-between rounded-[10px] p-3.5"
          style={{ background: "var(--accent)" }}
        >
          <div className="text-[12px]" style={{ color: "#3f6a49" }}>
            Tokens credited
          </div>
          <div className="font-mono text-xl font-semibold text-primary">+{amountNum}</div>
        </div>

        {error && <p className="mb-3 text-[12.5px] text-destructive">{error}</p>}

        <button
          type="button"
          onClick={handleRecord}
          disabled={isSaving || members.length === 0}
          className="w-full rounded-[9px] py-3 text-[14px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#e4e1d7] disabled:text-[#a29c8c]"
          style={!isSaving && members.length > 0 ? { background: "var(--primary)" } : undefined}
        >
          {isSaving ? "Recording…" : "Record donation"}
        </button>
      </div>

      <div className="rounded-card border border-border bg-card p-[18px]">
        <div className="mb-1.5 font-heading text-[15px] font-semibold">Today&apos;s donations</div>
        {donations.length === 0 ? (
          <div className="px-2 py-10 text-center text-[13px] text-[#6b6f66]">
            No donations recorded today yet.
          </div>
        ) : (
          donations.map((d) => (
            <div
              key={d.id}
              className="flex items-center gap-3 border-b border-[#f0eee6] py-[11px] last:border-b-0"
            >
              <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-primary">
                {initialsFromName(d.memberName)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{d.memberName}</div>
                <div className="text-[11px] text-[#9a9e93]">
                  {d.method} ·{" "}
                  {new Date(d.createdAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-[13px] font-semibold">R{d.amountRand}</div>
                <div className="font-mono text-[11px] text-primary">+{d.tokensCredited} tok</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
