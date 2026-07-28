"use client";

import { useState, useTransition } from "react";
import { usePageHeader } from "@/lib/page-header-context";
import { registerMemberAction } from "./actions";

type ExistingMember = { id: string; first: string; last: string; code: string };

export function RegisterMemberForm({
  clubSlug,
  clubId,
  existingMembers,
}: {
  clubSlug: string;
  clubId: string;
  existingMembers: ExistingMember[];
}) {
  usePageHeader({
    title: "New member registration",
    subtitle: "Capture identity and membership details, then sign the agreement.",
  });

  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [type, setType] = useState("Full member");
  const [referrerId, setReferrerId] = useState("");
  const [appHandle, setAppHandle] = useState("");
  const [status, setStatus] = useState("active");
  const [idFront, setIdFront] = useState<File | null>(null);
  const [idBack, setIdBack] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await registerMemberAction({
        clubSlug,
        clubId,
        first,
        last,
        email: email || undefined,
        phone: phone || undefined,
        type: type as "Full member" | "Day pass" | "Trial",
        status: status as "active" | "inactive",
        referrerId: referrerId || undefined,
        appHandle: appHandle || undefined,
        idFront,
        idBack,
      });
      if (result?.error) {
        setError(result.error);
      }
    });
  }

  return (
    <div className="max-w-[820px]">
      <div className="rounded-card border border-border bg-card p-[22px]">
        <div className="mb-0.5 font-heading text-lg font-bold">New member registration</div>
        <p className="mb-4 text-[12.5px] text-[#6b6f66]">
          Age verification required before first dispense.
        </p>
        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3.5">
          <div>
            <label htmlFor="first" className="mb-1 block text-[11px] text-[#8a8e83]">
              First name *
            </label>
            <input
              id="first"
              required
              value={first}
              onChange={(e) => setFirst(e.target.value)}
              placeholder="e.g. Thabo"
              className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
            />
          </div>
          <div>
            <label htmlFor="last" className="mb-1 block text-[11px] text-[#8a8e83]">
              Last name *
            </label>
            <input
              id="last"
              required
              value={last}
              onChange={(e) => setLast(e.target.value)}
              placeholder="e.g. Molefe"
              className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
            />
          </div>
          <div>
            <label htmlFor="email" className="mb-1 block text-[11px] text-[#8a8e83]">
              Email (optional)
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@email.com"
              className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
            />
          </div>
          <div>
            <label htmlFor="phone" className="mb-1 block text-[11px] text-[#8a8e83]">
              Phone (optional)
            </label>
            <input
              id="phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+27…"
              className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
            />
          </div>
          <div>
            <label htmlFor="type" className="mb-1 block text-[11px] text-[#8a8e83]">
              Membership type
            </label>
            <select
              id="type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
            >
              <option>Full member</option>
              <option>Day pass</option>
              <option>Trial</option>
            </select>
          </div>
          <div>
            <label htmlFor="referrer" className="mb-1 block text-[11px] text-[#8a8e83]">
              Referred by (optional)
            </label>
            <select
              id="referrer"
              value={referrerId}
              onChange={(e) => setReferrerId(e.target.value)}
              className="w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
            >
              <option value="">—</option>
              {existingMembers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.first} {m.last} ({m.code})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="appHandle" className="mb-1 block text-[11px] text-[#8a8e83]">
              Linked app username (optional)
            </label>
            <input
              id="appHandle"
              value={appHandle}
              onChange={(e) => setAppHandle(e.target.value)}
              placeholder="@username"
              className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
            />
          </div>
          <div>
            <label htmlFor="status" className="mb-1 block text-[11px] text-[#8a8e83]">
              Initial status
            </label>
            <select
              id="status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
          <div>
            <label htmlFor="idFront" className="mb-1 block text-[11px] text-[#8a8e83]">
              ID front (optional)
            </label>
            <input
              id="idFront"
              type="file"
              accept="image/*"
              onChange={(e) => setIdFront(e.target.files?.[0] ?? null)}
              className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
            />
          </div>
          <div>
            <label htmlFor="idBack" className="mb-1 block text-[11px] text-[#8a8e83]">
              ID back (optional)
            </label>
            <input
              id="idBack"
              type="file"
              accept="image/*"
              onChange={(e) => setIdBack(e.target.files?.[0] ?? null)}
              className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
            />
          </div>

          {error && <p className="col-span-2 text-[12.5px] text-destructive">{error}</p>}

          <div className="col-span-2 mt-1.5 flex justify-end gap-2.5">
            <a
              href={`/${clubSlug}`}
              className="rounded-[9px] border border-input bg-muted px-[18px] py-2.5 text-[13px] text-[#4a4e45]"
            >
              Cancel
            </a>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-[9px] px-5 py-2.5 text-[13px] font-semibold text-white"
              style={{ background: "var(--primary)" }}
            >
              {isPending ? "Continuing…" : "Continue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
