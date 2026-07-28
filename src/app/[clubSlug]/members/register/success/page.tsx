import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { SuccessHeader } from "./success-header";

export default async function RegistrationSuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ clubSlug: string }>;
  searchParams: Promise<{ memberId?: string }>;
}) {
  const { clubSlug } = await params;
  const { memberId } = await searchParams;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const { data: member } = memberId
    ? await supabase
        .from("members")
        .select("first, last, code")
        .eq("id", memberId)
        .eq("club_id", access.clubId)
        .maybeSingle()
    : { data: null };

  return (
    <>
      <SuccessHeader />
      <div className="mx-auto mt-10 max-w-[520px] text-center">
        <div className="rounded-2xl border border-border bg-card p-10">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-accent text-[30px] text-primary">
            ✓
          </div>
          <div className="font-heading text-[22px] font-bold">Member registered</div>
          <p className="mb-1.5 mt-1.5 text-[13px] text-[#6b6f66]">
            {member ? `${member.first} ${member.last}` : "The new member"} signed the membership
            agreement and their account is ready.
          </p>
          {member && (
            <div className="my-5 inline-block rounded-[9px] border border-border bg-muted px-2.5 py-2.5 font-mono text-[13px]">
              Member code · {member.code}
            </div>
          )}
          <div className="flex justify-center gap-2.5">
            <Link
              href={`/${clubSlug}/members/register`}
              className="rounded-[9px] border border-input bg-muted px-[18px] py-2.5 text-[13px] text-[#4a4e45]"
            >
              Register another
            </Link>
            <Link
              href={`/${clubSlug}`}
              className="rounded-[9px] px-5 py-2.5 text-[13px] font-semibold text-white"
              style={{ background: "var(--primary)" }}
            >
              Back to dashboard
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
