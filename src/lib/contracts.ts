import type { SupabaseClient } from "@supabase/supabase-js";

export type ContractClause = {
  heading: string;
  body: string;
};

export type ContractTemplate = {
  id: string;
  clubId: string;
  title: string;
  subtitle: string;
  consent: string;
  clauses: ContractClause[];
  version: number;
  updatedAt: string;
};

type ContractTemplateRow = {
  id: string;
  club_id: string;
  title: string;
  subtitle: string;
  consent: string;
  clauses: unknown;
  version: number;
  updated_at: string;
};

const TEMPLATE_COLUMNS = "id, club_id, title, subtitle, consent, clauses, version, updated_at";

function mapTemplate(row: ContractTemplateRow): ContractTemplate {
  return {
    id: row.id,
    clubId: row.club_id,
    title: row.title,
    subtitle: row.subtitle,
    consent: row.consent,
    clauses: row.clauses as ContractClause[],
    version: row.version,
    updatedAt: row.updated_at,
  };
}

// Reproduces the design reference's defaultContract() verbatim — this is
// the seed copy every club starts with, reviewable legal-adjacent text
// that must not drift from the source.
function defaultContract(clubName: string): {
  title: string;
  subtitle: string;
  consent: string;
  clauses: ContractClause[];
} {
  return {
    title: `${clubName} — Member Agreement`,
    subtitle:
      "Private Membership Agreement for access to cannabis.\nThis agreement operates under South African law permitting the private possession and consumption of cannabis for personal use.",
    consent:
      "I have read and agree to the terms of this Member Agreement. I confirm I am 21 years or older and that the information I have provided is accurate.",
    clauses: [
      {
        heading: "Introduction",
        body: `This Agreement is entered into between ${clubName} (Pty) Ltd and the Member. The Club operates in accordance with South African law permitting the private possession and consumption of cannabis for personal use.`,
      },
      {
        heading: "Eligibility & Membership",
        body: "Membership is open only to persons aged 21 years or older.\nJoining is voluntary and grants private, members-only access.\nAccess is conditional on continued compliance with this Agreement.",
      },
      {
        heading: "Nature of Cannabis Supply",
        body: "The Club facilitates private consumption among consenting adult members.\nCannabis is for personal use only — resale or distribution to non-members or minors is strictly prohibited.\nAll activity remains within the private-use scope established by the 2018 Constitutional Court ruling.",
      },
      {
        heading: "Code of Conduct",
        body: "No conduct that endangers the safety, reputation, or operation of the Club.\nNo consumption on the premises unless in a designated, by-law compliant space.\nNo attending under the influence and no disruptive or unlawful behaviour.\nBreach may result in termination of membership without refund.",
      },
      {
        heading: "Confidentiality & Privacy",
        body: "Member data is handled in accordance with POPIA.\nNo information is shared with third parties unless legally required.",
      },
      {
        heading: "Membership Fees",
        body: "Fees may cover contributions to cultivation, packaging, and operational costs.\nFees are not payment for cannabis itself — they represent an operational and logistical contribution only.",
      },
      {
        heading: "Liability Waiver",
        body: "The Member indemnifies the Club against any claims or damages arising from use.\nThe Member acknowledges the associated psychological and physical risks.",
      },
      {
        heading: "Termination",
        body: "Either party may terminate this Agreement, with or without reason, on written notice.\nThe Club may revoke membership immediately in the event of a breach.",
      },
      {
        heading: "Governing Law",
        body: "This Agreement is governed by the laws of the Republic of South Africa.",
      },
    ],
  };
}

export async function getOrCreateContractTemplate(
  supabase: SupabaseClient,
  clubId: string,
  clubName: string,
): Promise<ContractTemplate> {
  const { data: existing, error: fetchError } = await supabase
    .from("contract_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("club_id", clubId)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (existing) return mapTemplate(existing);

  const seed = defaultContract(clubName);
  const { data: created, error: insertError } = await supabase
    .from("contract_templates")
    .insert({
      club_id: clubId,
      title: seed.title,
      subtitle: seed.subtitle,
      consent: seed.consent,
      clauses: seed.clauses,
      version: 1,
    })
    .select(TEMPLATE_COLUMNS)
    .single();

  if (insertError) {
    // contract_templates.club_id is UNIQUE — a concurrent first-access
    // could have already inserted it between our SELECT and INSERT.
    // Re-fetch instead of surfacing a spurious error.
    if (insertError.code === "23505") {
      const { data: retry, error: retryError } = await supabase
        .from("contract_templates")
        .select(TEMPLATE_COLUMNS)
        .eq("club_id", clubId)
        .single();
      if (retryError) throw retryError;
      return mapTemplate(retry);
    }
    throw insertError;
  }
  return mapTemplate(created);
}

export async function saveContractTemplate(
  supabase: SupabaseClient,
  clubId: string,
  input: { title: string; subtitle: string; consent: string; clauses: ContractClause[] },
): Promise<ContractTemplate> {
  const { data: existing } = await supabase
    .from("contract_templates")
    .select("version")
    .eq("club_id", clubId)
    .maybeSingle();

  const { data, error } = await supabase
    .from("contract_templates")
    .upsert(
      {
        club_id: clubId,
        title: input.title,
        subtitle: input.subtitle,
        consent: input.consent,
        clauses: input.clauses,
        version: (existing?.version ?? 0) + 1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "club_id" },
    )
    .select(TEMPLATE_COLUMNS)
    .single();
  if (error) throw error;
  return mapTemplate(data);
}

export async function resetContractTemplate(
  supabase: SupabaseClient,
  clubId: string,
  clubName: string,
): Promise<ContractTemplate> {
  const seed = defaultContract(clubName);
  return saveContractTemplate(supabase, clubId, seed);
}

export type SignContractInput = {
  clubId: string;
  clubName: string;
  memberId: string;
  printedName: string;
  consent: boolean;
  signaturePngBase64: string;
};

export async function signContract(
  supabase: SupabaseClient,
  input: SignContractInput,
): Promise<{ signedContractId: string }> {
  if (!input.consent) {
    throw new Error("Consent is required to sign");
  }

  const base64 = input.signaturePngBase64.replace(/^data:image\/png;base64,/, "");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) {
    throw new Error("A signature is required to sign");
  }

  // Defense-in-depth: RLS's signed_contracts INSERT policy only checks
  // that the NEW row's club_id belongs to the caller — it doesn't verify
  // member_id actually belongs to that same club. Check explicitly so a
  // bug can't create a record linking one club's data to another club's
  // member.
  const { data: member, error: memberError } = await supabase
    .from("members")
    .select("id")
    .eq("id", input.memberId)
    .eq("club_id", input.clubId)
    .maybeSingle();
  if (memberError) throw memberError;
  if (!member) {
    throw new Error("Member not found in this club");
  }

  const template = await getOrCreateContractTemplate(supabase, input.clubId, input.clubName);

  // Generated client-side, not the DB default, because the Storage path
  // needs this id BEFORE the row exists, and signed_contracts is
  // append-only (no UPDATE policy) — "insert then patch signature_url"
  // is not possible.
  const signedContractId = crypto.randomUUID();
  const signaturePath = `${input.clubId}/${input.memberId}/${signedContractId}.png`;

  const { error: uploadError } = await supabase.storage
    .from("signatures")
    .upload(signaturePath, bytes, { contentType: "image/png" });
  if (uploadError) throw uploadError;

  const { error: insertError } = await supabase.from("signed_contracts").insert({
    id: signedContractId,
    club_id: input.clubId,
    member_id: input.memberId,
    template_version: template.version,
    contract_snapshot: {
      title: template.title,
      subtitle: template.subtitle,
      consent: template.consent,
      clauses: template.clauses,
    },
    consent: input.consent,
    printed_name: input.printedName || null,
    signature_url: signaturePath,
  });
  if (insertError) throw insertError;

  return { signedContractId };
}
