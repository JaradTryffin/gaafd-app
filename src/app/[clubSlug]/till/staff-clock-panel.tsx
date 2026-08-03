"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/lib/toast-context";
import { clockInAction, clockOutAction } from "./actions";
import type { Shift, Workstation } from "@/lib/till";

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
}

export function StaffClockPanel({
  clubId,
  isDayOpen,
  workstations,
  myShift: initialMyShift,
}: {
  clubId: string;
  isDayOpen: boolean;
  workstations: Workstation[];
  myShift: Shift | null;
}) {
  const { showToast } = useToast();
  const [myShift, setMyShift] = useState(initialMyShift);
  const [workstationInput, setWorkstationInput] = useState("");
  const [cashOutInput, setCashOutInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClockIn() {
    setError(null);
    startTransition(async () => {
      const result = await clockInAction(clubId, workstationInput || null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMyShift(result.shift);
      showToast("Clocked in");
    });
  }

  function handleClockOut() {
    if (!myShift) return;
    setError(null);
    const amount = Number(cashOutInput);
    if (!cashOutInput || Number.isNaN(amount) || amount < 0) {
      setError("Enter a valid cash-out amount");
      return;
    }
    startTransition(async () => {
      const result = await clockOutAction(myShift.id, amount, false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMyShift(null);
      setCashOutInput("");
      showToast("Clocked out");
    });
  }

  if (!isDayOpen) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <div className="w-full max-w-[380px] rounded-card border border-border bg-card p-6 text-center">
          <div className="mb-1 font-heading text-base font-semibold">No business day open</div>
          <p className="text-[12.5px] text-[#6b6f66]">
            Ask an admin to open today&apos;s business day before clocking in.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[360px] items-center justify-center">
      <div className="w-full max-w-[380px] rounded-card border border-border bg-card p-6">
        {myShift ? (
          <>
            <div className="mb-1 font-heading text-base font-semibold">
              Clocked in {timeLabel(myShift.clockIn)}
              {myShift.workstationName ? ` · ${myShift.workstationName}` : ""}
            </div>
            <p className="mb-4 text-[12.5px] text-[#6b6f66]">Enter your cash-out amount to clock out.</p>
            <label htmlFor="staffCashOut" className="mb-1 block text-left text-[11px] text-[#8a8e83]">
              Cash out (R)
            </label>
            <input
              id="staffCashOut"
              inputMode="numeric"
              value={cashOutInput}
              onChange={(e) => setCashOutInput(e.target.value.replace(/[^0-9]/g, ""))}
              className="mb-3 w-full rounded-[9px] border border-input px-3 py-3 text-center font-mono text-xl font-semibold"
            />
            {error && <p className="mb-3 text-[12.5px] text-destructive">{error}</p>}
            <button
              type="button"
              onClick={handleClockOut}
              disabled={isPending}
              className="w-full rounded-[9px] py-3 text-[14px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#e4e1d7] disabled:text-[#a29c8c]"
              style={!isPending ? { background: "var(--primary)" } : undefined}
            >
              {isPending ? "Clocking out…" : "Clock out"}
            </button>
          </>
        ) : (
          <>
            <div className="mb-1 font-heading text-base font-semibold">You are not clocked in</div>
            <p className="mb-4 text-[12.5px] text-[#6b6f66]">Select a workstation (optional) and clock in.</p>
            <label htmlFor="staffWorkstation" className="mb-1 block text-left text-[11px] text-[#8a8e83]">
              Workstation
            </label>
            <select
              id="staffWorkstation"
              value={workstationInput}
              onChange={(e) => setWorkstationInput(e.target.value)}
              className="mb-3 w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
            >
              <option value="">No workstation</option>
              {workstations.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            {error && <p className="mb-3 text-[12.5px] text-destructive">{error}</p>}
            <button
              type="button"
              onClick={handleClockIn}
              disabled={isPending}
              className="w-full rounded-[9px] py-3 text-[14px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#e4e1d7] disabled:text-[#a29c8c]"
              style={!isPending ? { background: "var(--primary)" } : undefined}
            >
              {isPending ? "Clocking in…" : "Clock in"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
