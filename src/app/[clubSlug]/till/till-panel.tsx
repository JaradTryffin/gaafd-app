"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/lib/toast-context";
import { formatRand } from "@/lib/format";
import {
  openBusinessDayAction,
  clockInAction,
  clockOutAction,
  closeBusinessDayAction,
  createWorkstationAction,
} from "./actions";
import type { BusinessDay, Shift, Workstation } from "@/lib/till";

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
}

export function TillPanel({
  clubId,
  currentUserEmail,
  businessDay: initialBusinessDay,
  workstations: initialWorkstations,
  shifts: initialShifts,
  cashDonationsToday,
}: {
  clubId: string;
  currentUserEmail: string;
  businessDay: BusinessDay | null;
  workstations: Workstation[];
  shifts: Shift[];
  cashDonationsToday: number;
}) {
  const { showToast } = useToast();
  const [businessDay, setBusinessDay] = useState(initialBusinessDay);
  const [workstations, setWorkstations] = useState(initialWorkstations);
  const [shifts, setShifts] = useState(initialShifts);
  const [floatInput, setFloatInput] = useState("");
  const [workstationInput, setWorkstationInput] = useState("");
  const [newWorkstationName, setNewWorkstationName] = useState("");
  const [cashOutDrafts, setCashOutDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const myOpenShift = shifts.find((s) => s.staffEmail === currentUserEmail && s.status === "open");
  const openShiftsCount = shifts.filter((s) => s.status === "open").length;
  const expectedInDrawer = businessDay ? businessDay.initialFloat + cashDonationsToday : 0;

  function handleOpenDay() {
    setError(null);
    const amount = Number(floatInput);
    if (!floatInput || Number.isNaN(amount) || amount < 0) {
      setError("Enter a valid float amount");
      return;
    }
    startTransition(async () => {
      const result = await openBusinessDayAction(clubId, amount);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBusinessDay(result.businessDay);
      setShifts([]);
      setFloatInput("");
      showToast("Business day opened");
    });
  }

  function handleClockIn() {
    setError(null);
    startTransition(async () => {
      const result = await clockInAction(clubId, workstationInput || null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setShifts((prev) => [result.shift, ...prev]);
      showToast("Clocked in");
    });
  }

  function handleClockOut(shift: Shift, isForceClose: boolean) {
    setError(null);
    const raw = cashOutDrafts[shift.id] ?? "";
    const amount = Number(raw);
    if (!raw || Number.isNaN(amount) || amount < 0) {
      setError("Enter a valid cash-out amount");
      return;
    }
    startTransition(async () => {
      const result = await clockOutAction(shift.id, amount, isForceClose);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setShifts((prev) => prev.map((s) => (s.id === result.shift.id ? result.shift : s)));
      showToast(isForceClose ? "Shift force-closed" : "Clocked out");
    });
  }

  function handleAddWorkstation() {
    setError(null);
    if (!newWorkstationName.trim()) {
      setError("Enter a workstation name");
      return;
    }
    startTransition(async () => {
      const result = await createWorkstationAction(clubId, newWorkstationName.trim());
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setWorkstations((prev) => [...prev, result.workstation]);
      setNewWorkstationName("");
    });
  }

  function handleCloseDay() {
    if (!businessDay) return;
    setError(null);
    startTransition(async () => {
      const result = await closeBusinessDayAction(clubId, businessDay.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const counted = result.businessDay.cashCounted ?? 0;
      const variance = counted - expectedInDrawer;
      setBusinessDay(result.businessDay);
      showToast(
        `Business day closed · counted ${formatRand(counted)}, expected ${formatRand(expectedInDrawer)} (${
          variance >= 0 ? "+" : ""
        }${formatRand(variance)})`,
      );
    });
  }

  if (!businessDay || businessDay.status === "closed") {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <div className="w-full max-w-[380px] rounded-card border border-border bg-card p-6 text-center">
          <div className="mb-1 font-heading text-base font-semibold">
            {businessDay?.status === "closed" ? "Business day closed" : "No business day open"}
          </div>
          <p className="mb-4 text-[12.5px] text-[#6b6f66]">
            {businessDay?.status === "closed"
              ? "Open a new business day to continue."
              : "Enter the starting cash float to open today's business day."}
          </p>
          <label htmlFor="initialFloat" className="mb-1 block text-left text-[11px] text-[#8a8e83]">
            Initial float (R)
          </label>
          <input
            id="initialFloat"
            inputMode="numeric"
            value={floatInput}
            onChange={(e) => setFloatInput(e.target.value.replace(/[^0-9]/g, ""))}
            className="mb-3 w-full rounded-[9px] border border-input px-3 py-3 text-center font-mono text-xl font-semibold"
          />
          {error && <p className="mb-3 text-[12.5px] text-destructive">{error}</p>}
          <button
            type="button"
            onClick={handleOpenDay}
            disabled={isPending}
            className="w-full rounded-[9px] py-3 text-[14px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#e4e1d7] disabled:text-[#a29c8c]"
            style={!isPending ? { background: "var(--primary)" } : undefined}
          >
            {isPending ? "Opening…" : "Open business day"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3.5 flex items-center justify-between rounded-card border border-border bg-card p-4">
        <div className="text-[13px]">
          {myOpenShift ? (
            <span>
              Clocked in {timeLabel(myOpenShift.clockIn)}
              {myOpenShift.workstationName ? ` · ${myOpenShift.workstationName}` : ""}
            </span>
          ) : (
            <span className="text-[#8a8e83]">You are not clocked in</span>
          )}
        </div>
        {myOpenShift ? (
          <div className="flex items-center gap-2">
            <label htmlFor="myCashOut" className="sr-only">
              Cash out amount
            </label>
            <input
              id="myCashOut"
              inputMode="numeric"
              placeholder="Cash out (R)"
              value={cashOutDrafts[myOpenShift.id] ?? ""}
              onChange={(e) =>
                setCashOutDrafts((prev) => ({
                  ...prev,
                  [myOpenShift.id]: e.target.value.replace(/[^0-9]/g, ""),
                }))
              }
              className="w-[130px] rounded-[8px] border border-input px-3 py-2 font-mono text-[13px]"
            />
            <button
              type="button"
              onClick={() => handleClockOut(myOpenShift, false)}
              disabled={isPending}
              className="rounded-[8px] px-4 py-2 text-[13px] font-semibold text-white"
              style={{ background: "var(--primary)" }}
            >
              Clock out
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <label htmlFor="clockInWorkstation" className="sr-only">
              Workstation
            </label>
            <select
              id="clockInWorkstation"
              value={workstationInput}
              onChange={(e) => setWorkstationInput(e.target.value)}
              className="rounded-[8px] border border-input bg-card px-3 py-2 text-[13px]"
            >
              <option value="">No workstation</option>
              {workstations.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleClockIn}
              disabled={isPending}
              className="rounded-[8px] px-4 py-2 text-[13px] font-semibold text-white"
              style={{ background: "var(--primary)" }}
            >
              Clock in
            </button>
          </div>
        )}
      </div>

      {error && <p className="mb-3 text-[12.5px] text-destructive">{error}</p>}

      <div className="mb-4 grid grid-cols-3 gap-3.5">
        <div className="rounded-card border border-border bg-card p-[17px]">
          <div className="text-xs text-[#6b6f66]">Business day</div>
          <div className="mt-1.5 font-heading text-[17px] font-semibold">
            Open ·{" "}
            {new Date(businessDay.openedAt).toLocaleDateString("en-ZA", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          </div>
          <div className="mt-0.5 text-[11.5px] text-[#8a8e83]">
            Opened {timeLabel(businessDay.openedAt)} by {businessDay.openedByEmail}
          </div>
        </div>
        <div className="rounded-card border border-border bg-card p-[17px]">
          <div className="text-xs text-[#6b6f66]">Initial float</div>
          <div className="mt-1.5 font-mono text-[22px] font-semibold">
            {formatRand(businessDay.initialFloat)}
          </div>
        </div>
        <div className="rounded-card border border-border bg-card p-[17px]">
          <div className="text-xs text-[#6b6f66]">Cash donations today</div>
          <div className="mt-1.5 font-mono text-[22px] font-semibold text-primary">
            {formatRand(cashDonationsToday)}
          </div>
          <div className="mt-0.5 text-[11.5px] text-[#8a8e83]">
            Expected in drawer: {formatRand(expectedInDrawer)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_300px] items-start gap-4">
        <div className="overflow-hidden rounded-card border border-border bg-card">
          <div className="border-b border-border px-[18px] py-3.5 font-heading text-[15px] font-semibold">
            Shifts today
          </div>
          <div className="grid grid-cols-[1fr_100px_100px_110px_90px_110px] gap-3 border-b border-border bg-muted px-[18px] py-2.5 text-[11px] font-semibold uppercase tracking-[.05em] text-[#8a8e83]">
            <div>Staff</div>
            <div>Start</div>
            <div>End</div>
            <div>Cash out</div>
            <div>Status</div>
            <div></div>
          </div>
          {shifts.length === 0 ? (
            <div className="px-[18px] py-10 text-center text-[12.5px] text-[#9a9e93]">No shifts yet today.</div>
          ) : (
            shifts.map((s) => (
              <div
                key={s.id}
                className="grid grid-cols-[1fr_100px_100px_110px_90px_110px] items-center gap-3 border-b border-[#f4f2ea] px-[18px] py-3 text-[13px] last:border-b-0"
              >
                <div className="truncate font-medium">{s.staffEmail}</div>
                <div className="font-mono text-[#6b6f66]">{timeLabel(s.clockIn)}</div>
                <div className="font-mono text-[#6b6f66]">{s.clockOut ? timeLabel(s.clockOut) : "—"}</div>
                <div className="font-mono">{s.cashOut !== null ? formatRand(s.cashOut) : "—"}</div>
                <div>
                  <span
                    className={
                      s.status === "open"
                        ? "rounded-full bg-status-active-bg px-2.5 py-1 text-[11px] font-medium text-status-active-fg"
                        : "rounded-full bg-status-inactive-bg px-2.5 py-1 text-[11px] font-medium text-status-inactive-fg"
                    }
                  >
                    {s.status}
                  </span>
                </div>
                <div>
                  {s.status === "open" && s.staffEmail !== currentUserEmail && (
                    <div className="flex items-center gap-1.5">
                      <label htmlFor={`forceCashOut-${s.id}`} className="sr-only">
                        Cash out amount
                      </label>
                      <input
                        id={`forceCashOut-${s.id}`}
                        inputMode="numeric"
                        placeholder="R"
                        value={cashOutDrafts[s.id] ?? ""}
                        onChange={(e) =>
                          setCashOutDrafts((prev) => ({
                            ...prev,
                            [s.id]: e.target.value.replace(/[^0-9]/g, ""),
                          }))
                        }
                        className="w-[54px] rounded-[6px] border border-input px-1.5 py-1 font-mono text-[11px]"
                      />
                      <button
                        type="button"
                        onClick={() => handleClockOut(s, true)}
                        disabled={isPending}
                        className="rounded-[6px] border border-input bg-muted px-2 py-1 text-[11px] font-medium text-[#6b6f66]"
                      >
                        Force close
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="rounded-card border border-border bg-card p-[18px]">
          <div className="mb-3 font-heading text-[15px] font-semibold">Workstations</div>
          {workstations.length === 0 ? (
            <div className="py-4 text-center text-[12px] text-[#9a9e93]">No workstations yet.</div>
          ) : (
            workstations.map((w) => {
              const inUse = shifts.some((s) => s.workstationId === w.id && s.status === "open");
              return (
                <div
                  key={w.id}
                  className="flex items-center gap-2.5 border-b border-[#f0eee6] py-2.5 last:border-b-0"
                >
                  <div className="h-2 w-2 rounded-full" style={{ background: inUse ? "#6fbf82" : "#d9b25a" }} />
                  <div className="flex-1">
                    <div className="text-[13px] font-medium">{w.name}</div>
                    <div className="text-[11px] text-[#9a9e93]">{inUse ? "In use" : "Idle"}</div>
                  </div>
                </div>
              );
            })
          )}
          <div className="mt-3 flex gap-2">
            <label htmlFor="newWorkstationName" className="sr-only">
              New workstation name
            </label>
            <input
              id="newWorkstationName"
              value={newWorkstationName}
              onChange={(e) => setNewWorkstationName(e.target.value)}
              placeholder="New workstation name"
              className="flex-1 rounded-[8px] border border-input px-3 py-2 text-[13px]"
            />
            <button
              type="button"
              onClick={handleAddWorkstation}
              disabled={isPending}
              className="rounded-[8px] border border-input bg-muted px-3 py-2 text-[13px]"
            >
              Add
            </button>
          </div>
          <button
            type="button"
            onClick={handleCloseDay}
            disabled={isPending || openShiftsCount > 0}
            title={openShiftsCount > 0 ? `${openShiftsCount} shift(s) still open` : undefined}
            className="mt-3.5 w-full rounded-[9px] border border-input py-2.5 text-[13px] font-semibold text-[#4a4e45] disabled:cursor-not-allowed disabled:text-[#a29c8c]"
            style={{ background: "var(--muted)" }}
          >
            Close business day{openShiftsCount > 0 ? ` (${openShiftsCount} open)` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
